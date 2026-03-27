/**
 * Incremental Reindex Utilities
 *
 * Given a set of directly-changed files (from git diff), expand the set to
 * include files that import from the changed files.  This ensures that when
 * a file's public API changes, all importers are re-indexed so their edges
 * stay correct.
 */

import type { ExecuteQueryFn } from './community-processor.js';
import type { ChangedFile } from '../../storage/git.js';

export interface AffectedFileSet {
  /** Original directly-changed files from git diff (repo-relative paths) */
  directlyChanged: string[];
  /** Files that import from the directly-changed files (1-hop importers, repo-relative) */
  importers: string[];
  /** Union of directlyChanged + importers (deduplicated, repo-relative) */
  all: string[];
  /** Deleted files that need removal from the DB (repo-relative) */
  deleted: string[];
}

/**
 * Escape a string for safe interpolation inside a Cypher single-quoted literal.
 * Handles backslashes, single quotes, null bytes, and control characters.
 * File paths come from git diff (trusted) but may contain quotes or unicode.
 */
const escapeCypher = (s: string): string =>
  // eslint-disable-next-line no-control-regex
  s.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\0/g, '').replace(/[\x01-\x1f\x7f]/g, '');

/**
 * Edge types that represent cross-file dependencies. If file A has one of
 * these edge types pointing at a node in file B, then A "depends on" B and
 * must be re-indexed when B changes.
 *
 * IMPORTS is included so that direct importers (including barrel re-exports)
 * are always caught in the 1-hop expansion.
 */
const DEPENDENCY_EDGE_TYPES = ['CALLS', 'ACCESSES', 'IMPORTS'];

/**
 * Expand a list of directly-changed file paths to include 1-hop dependents.
 *
 * Queries the existing LadybugDB graph for any node that has a dependency
 * edge (CALLS, ACCESSES) pointing to a node whose filePath matches one of
 * the changed files.  The source node's filePath is collected as a
 * "dependent" that also needs re-indexing so its cross-file edges stay
 * correct after the target nodes are re-created.
 *
 * All returned paths are **repo-relative** (e.g. `src/handler.ts`), matching
 * the format used by the pipeline, graph nodes, and DB filePath columns.
 *
 * @param executeQuery  LadybugDB query function (single-arg Cypher string)
 * @param changedFiles  Changed files from git diff (with status and repo-relative path)
 * @param _repoPath     Unused — kept for API compatibility
 * @returns Deduplicated set of affected files (changed + importers + deleted)
 */
export async function expandAffectedFiles(
  executeQuery: ExecuteQueryFn,
  changedFiles: ChangedFile[],
  _repoPath: string,
): Promise<AffectedFileSet> {
  const directlyChanged = changedFiles
    .filter(f => f.status !== 'D')
    .map(f => f.path);

  const deleted = changedFiles
    .filter(f => f.status === 'D')
    .map(f => f.path);

  if (directlyChanged.length === 0 && deleted.length === 0) {
    return { directlyChanged: [], importers: [], all: [], deleted: [] };
  }

  // Include all changed paths (including deleted) for the dependent query —
  // files that call/access symbols in deleted files need re-indexing to
  // clean up dangling edges. Also include oldPath for renamed files so that
  // importers of the pre-rename path are caught.
  const allChangedPaths = changedFiles.flatMap(f =>
    f.oldPath ? [f.path, f.oldPath] : [f.path],
  );

  const importers = new Set<string>();
  const edgeTypeFilter = DEPENDENCY_EDGE_TYPES.map(t => `'${t}'`).join(', ');

  const BATCH_SIZE = 100;
  for (let i = 0; i < allChangedPaths.length; i += BATCH_SIZE) {
    const batch = allChangedPaths.slice(i, i + BATCH_SIZE);
    const inList = batch.map(p => `'${escapeCypher(p)}'`).join(', ');

    // 1-hop: direct dependents (CALLS, ACCESSES, IMPORTS)
    try {
      const rows = await executeQuery(
        `MATCH (n)-[r:CodeRelation]->(target)
         WHERE r.type IN [${edgeTypeFilter}]
           AND target.filePath IN [${inList}]
           AND n.filePath IS NOT NULL
         RETURN DISTINCT n.filePath AS fp`,
      );
      for (const row of rows) {
        const fp = String(row.fp ?? '');
        if (fp) importers.add(fp);
      }
    } catch {
      // If the query fails (e.g. empty DB), just skip dependent expansion
    }

    // 2-hop: barrel re-export chains (consumer -> index.ts -> changed file).
    // Catches TypeScript barrel patterns where index.ts re-exports from the
    // changed file. Without this, consumers importing through barrels are missed.
    // TODO: Full signature-comparison for transitive type dependencies (Phase 3B)
    try {
      const rows = await executeQuery(
        `MATCH (consumer)-[r1:CodeRelation]->(barrel)-[r2:CodeRelation]->(target)
         WHERE r1.type = 'IMPORTS' AND r2.type = 'IMPORTS'
           AND target.filePath IN [${inList}]
           AND consumer.filePath IS NOT NULL
           AND barrel.filePath <> target.filePath
         RETURN DISTINCT consumer.filePath AS fp`,
      );
      for (const row of rows) {
        const fp = String(row.fp ?? '');
        if (fp) importers.add(fp);
      }
    } catch {
      // 2-hop query failed — 1-hop results are still valid
    }
  }

  // Remove directly-changed and deleted files from the importers set
  const changedSet = new Set(allChangedPaths);
  for (const fp of changedSet) importers.delete(fp);

  const all = [...new Set([...directlyChanged, ...importers])];

  return {
    directlyChanged,
    importers: [...importers],
    all,
    deleted,
  };
}

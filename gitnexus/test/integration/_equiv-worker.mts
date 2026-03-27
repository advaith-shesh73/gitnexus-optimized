/**
 * Worker subprocess for incremental-equivalence test.
 *
 * Performs a single DB operation (full rebuild or incremental) and prints
 * the DB snapshot as JSON on the last line of stdout.
 *
 * Each invocation opens and closes the DB exactly once, avoiding the
 * LadybugDB N-API destructor crash from multiple open/close cycles.
 *
 * Environment variables:
 *   EQUIV_MODE     "full-rebuild" | "incremental"
 *   EQUIV_REPO     Path to the git repository
 *   EQUIV_DB       Path to the LadybugDB database file
 *   EQUIV_STORAGE  Path to the storage directory
 *   EQUIV_CHANGED  JSON array of ChangedFile objects (incremental only)
 */
import { runPipelineFromRepo } from '../../src/core/ingestion/pipeline.js';
import {
  initLbug,
  loadGraphToLbug,
  executeQuery,
  closeLbug,
  checkpointLbug,
  deleteNodesByFilePath,
} from '../../src/core/lbug/lbug-adapter.js';
import { expandAffectedFiles } from '../../src/core/ingestion/incremental.js';
import { filterGraphForIncremental } from '../../src/core/ingestion/graph-filter.js';
import { NODE_TABLES } from '../../src/core/lbug/schema.js';
import type { ChangedFile } from '../../src/storage/git.js';

interface NodeSnapshot { id: string; label: string; name: string; filePath: string }
interface EdgeSnapshot { sourceId: string; targetId: string; type: string }
interface DBSnapshot { nodes: NodeSnapshot[]; edges: EdgeSnapshot[] }

const SKIP_LABELS = new Set(['Community', 'Process', 'CodeEmbedding']);
const SKIP_REL_TYPES = new Set(['MEMBER_OF', 'STEP_IN_PROCESS', 'ENTRY_POINT_OF']);

async function snapshotDB(): Promise<DBSnapshot> {
  const nodes: NodeSnapshot[] = [];
  for (const table of NODE_TABLES) {
    if (SKIP_LABELS.has(table)) continue;
    try {
      const rows = await executeQuery(
        `MATCH (n:\`${table}\`) RETURN n.id AS id, n.name AS name, n.filePath AS fp`,
      );
      for (const r of rows) {
        nodes.push({ id: String(r.id ?? ''), label: table, name: String(r.name ?? ''), filePath: String(r.fp ?? '') });
      }
    } catch {}
  }
  const edges: EdgeSnapshot[] = [];
  try {
    const rows = await executeQuery(
      `MATCH (a)-[r:CodeRelation]->(b) RETURN a.id AS src, b.id AS tgt, r.type AS typ`,
    );
    for (const r of rows) {
      const typ = String(r.typ ?? '');
      if (SKIP_REL_TYPES.has(typ)) continue;
      edges.push({ sourceId: String(r.src ?? ''), targetId: String(r.tgt ?? ''), type: typ });
    }
  } catch {}
  nodes.sort((a, b) => a.id.localeCompare(b.id));
  edges.sort((a, b) => a.sourceId.localeCompare(b.sourceId) || a.targetId.localeCompare(b.targetId) || a.type.localeCompare(b.type));
  return { nodes, edges };
}

const mode = process.env.EQUIV_MODE!;
const repoPath = process.env.EQUIV_REPO!;
const dbPath = process.env.EQUIV_DB!;
const storagePath = process.env.EQUIV_STORAGE!;

if (mode === 'full-rebuild') {
  const pipelineResult = await runPipelineFromRepo(repoPath, () => {});
  await initLbug(dbPath);
  await loadGraphToLbug(pipelineResult.graph, repoPath, storagePath, () => {});
  await checkpointLbug();
  const snap = await snapshotDB();
  await closeLbug();
  console.log(JSON.stringify(snap));
} else if (mode === 'incremental') {
  const changedFiles: ChangedFile[] = JSON.parse(process.env.EQUIV_CHANGED!);

  await initLbug(dbPath);
  const affectedFiles = await expandAffectedFiles(executeQuery, changedFiles, repoPath);
  const pathsToDelete = [...affectedFiles.all, ...affectedFiles.deleted];
  await deleteNodesByFilePath(pathsToDelete);

  // Run the full pipeline (parse ALL files) so cross-file CALLS edges are
  // resolved correctly. Then filter to only affected-file nodes before insert.
  const fileFilter = new Set(affectedFiles.all);
  const pipelineResult = await runPipelineFromRepo(repoPath, () => {});
  filterGraphForIncremental(pipelineResult.graph, fileFilter);

  await loadGraphToLbug(pipelineResult.graph, repoPath, storagePath, () => {});
  await checkpointLbug();
  const snap = await snapshotDB();
  await closeLbug();
  console.log(JSON.stringify(snap));
} else {
  console.error(`Unknown mode: ${mode}`);
  process.exit(1);
}

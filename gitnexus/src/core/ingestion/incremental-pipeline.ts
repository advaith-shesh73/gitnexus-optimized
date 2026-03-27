/**
 * Incremental Reindex Pipeline
 *
 * Orchestrates the incremental reindex path: parse → filter → delete → insert.
 * Extracted from cli/analyze.ts to keep the CLI orchestrator focused on
 * argument parsing and progress display.
 *
 * Steps:
 *   1. Acquire lock (advisory file lock for concurrency safety)
 *   2. Parse repository (no DB lock)
 *   3. Filter graph to affected files
 *   4. Delete old nodes from live DB
 *   5. Insert updated nodes
 *   6. Defer FTS rebuild (lazy flag in meta.json)
 *   7. Incremental embeddings (optional)
 *   8. Community detection (threshold-gated)
 *   9. Update process stats
 *  10. Checkpoint DB, THEN save metadata (ordering is critical for crash safety)
 *  11. Release lock
 */

import fs from 'fs/promises';
import path from 'path';
import { runPipelineFromRepo } from './pipeline.js';
import { filterGraphForIncremental } from './graph-filter.js';
import { processCommunitiesInDB } from './community-processor.js';
import type { AffectedFileSet } from './incremental.js';
import type { PipelineResult, PipelineProgress } from '../../types/pipeline.js';
import type { RepoMeta } from '../../storage/repo-manager.js';
import {
  initLbug, loadGraphToLbug, getLbugStats, executeQuery,
  executeWithReusedStatement, closeLbug, checkpointLbug,
  loadFTSExtension, loadAlgoExtension, deleteNodesByFilePath,
  rebuildFTSIndexes,
} from '../lbug/lbug-adapter.js';
import { saveMeta, registerRepo } from '../../storage/repo-manager.js';
import {
  loadSymbolCache, saveSymbolCache, buildSymbolCacheFromGraph,
  type SymbolCache, type SymbolCacheEntry,
} from './symbol-cache.js';

const COMMUNITY_REDETECT_THRESHOLD = parseFloat(
  process.env.GITNEXUS_COMMUNITY_THRESHOLD ?? '0.05',
);

const DB_OPERATION_TIMEOUT_MS = parseInt(
  process.env.GITNEXUS_DB_TIMEOUT_MS ?? '120000', 10,
);

export interface IncrementalPipelineOptions {
  repoPath: string;
  lbugPath: string;
  storagePath: string;
  currentCommit: string;
  affectedFiles: AffectedFileSet;
  existingMeta: RepoMeta;
  embeddingsEnabled: boolean;
  embeddingNodeLimit: number;
  onProgress: (pct: number, phase: string) => void;
}

export interface IncrementalPipelineResult {
  elapsedMs: number;
  stats: { nodes: number; edges: number };
  pipelineResult: PipelineResult;
}

/**
 * Wraps an async operation with a timeout. If the operation exceeds the
 * deadline, the returned promise rejects. The underlying operation is NOT
 * cancelled (Node has no cooperative cancellation for N-API calls), but the
 * caller can proceed with error handling instead of hanging indefinitely.
 */
function withTimeout<T>(op: Promise<T>, ms: number, label: string): Promise<T> {
  if (ms <= 0) return op;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Timeout after ${ms}ms: ${label}`)),
      ms,
    );
    op.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

const LOCK_STALE_MS = 10 * 60 * 1000;
const LOCK_MAX_RETRIES = 3;
const LOCK_JITTER_BASE_MS = 200;

/**
 * Advisory file lock using mkdir (atomic on POSIX).
 *
 * Stale-lock recovery uses a retry-with-jitter loop to close the TOCTOU
 * window: after removing a stale lock, we retry mkdir — if another process
 * won the race, mkdir fails and we back off instead of both acquiring.
 */
async function acquireLock(storagePath: string): Promise<string> {
  const lockPath = path.join(storagePath, '.lock');

  for (let attempt = 0; attempt <= LOCK_MAX_RETRIES; attempt++) {
    try {
      await fs.mkdir(lockPath);
      break; // acquired
    } catch (e: any) {
      if (e.code !== 'EEXIST') throw e;

      let stale = false;
      try {
        const stat = await fs.stat(lockPath);
        stale = Date.now() - stat.mtimeMs > LOCK_STALE_MS;
        if (!stale) {
          try {
            const pidStr = await fs.readFile(path.join(lockPath, 'pid'), 'utf-8');
            const pid = parseInt(pidStr, 10);
            if (!isNaN(pid) && pid !== process.pid) {
              try { process.kill(pid, 0); }
              catch { stale = true; }
            }
          } catch {
            // No PID file or unreadable — rely on age-based staleness only
          }
        }
      } catch {
        // Lock dir vanished between EEXIST and stat — another process
        // released it. Retry mkdir on next iteration.
        if (attempt < LOCK_MAX_RETRIES) {
          await jitterDelay(attempt);
          continue;
        }
      }

      if (stale) {
        try { await fs.rm(lockPath, { recursive: true, force: true }); } catch {}
        // Don't mkdir here — loop back and let the next iteration's mkdir
        // determine who actually won the race.
        if (attempt < LOCK_MAX_RETRIES) {
          await jitterDelay(attempt);
          continue;
        }
      }

      throw new Error(
        'Another GitNexus process is indexing this repository. '
        + 'If this is stale, remove ' + lockPath,
      );
    }
  }

  const pidFile = path.join(lockPath, 'pid');
  await fs.writeFile(pidFile, String(process.pid));
  return lockPath;
}

function jitterDelay(attempt: number): Promise<void> {
  const jitter = Math.random() * LOCK_JITTER_BASE_MS * (attempt + 1);
  return new Promise(r => setTimeout(r, jitter));
}

/**
 * Release the lock only if we're certain no DB operation is still running.
 * Callers pass `safe=false` when a timeout fired — in that case the lock
 * is intentionally left stale so a concurrent process won't start mutating
 * while the timed-out N-API call might still be running.
 */
async function releaseLock(lockPath: string, safe = true): Promise<void> {
  if (!safe) return; // leave stale — next run's staleness check will clean up
  try { await fs.rm(lockPath, { recursive: true, force: true }); } catch {}
}

/**
 * Run the full incremental reindex pipeline.
 *
 * Callers are responsible for:
 *  - Setting the dirty flag before calling this function
 *  - Calling process.exit(0) if needed (LadybugDB N-API workaround)
 */
export async function runIncrementalPipeline(
  opts: IncrementalPipelineOptions,
): Promise<IncrementalPipelineResult> {
  const {
    repoPath, lbugPath, storagePath, currentCommit,
    affectedFiles, existingMeta, embeddingsEnabled,
    embeddingNodeLimit, onProgress,
  } = opts;

  const lockPath = await acquireLock(storagePath);
  const t0 = Date.now();
  let completedCleanly = false;

  try {
    // Step 0: Load cached symbol table from the last full/incremental build.
    // Validates cache.commit matches existingMeta.lastCommit — a force-push
    // (rebase/amend/reset) makes the cache stale because affectedFiles is
    // computed relative to a different commit than the cache was built from.
    const symbolCache = await loadSymbolCache(storagePath, existingMeta.lastCommit);

    // Step 1: Parse BEFORE acquiring DB write lock.
    onProgress(5, 'Re-parsing repository...');
    const fileFilter = new Set(affectedFiles.all);
    const pipelineResult = await runPipelineFromRepo(repoPath, (progress: PipelineProgress) => {
      const scaled = 5 + Math.round(progress.percent * 0.55);
      onProgress(scaled, progress.phase);
    }, {
      fileFilter,
      symbolCache: symbolCache ?? undefined,
    });

    // Step 2: Filter graph to only affected files (safety net — fileFilter
    // already limits which files get parsed, but scanning still adds
    // File/Folder nodes for all paths).
    onProgress(60, 'Filtering graph to affected files...');
    filterGraphForIncremental(pipelineResult.graph, fileFilter);

    // Step 3: Open DB and delete old nodes for affected AND deleted files.
    const pathsToDelete = [...affectedFiles.all, ...affectedFiles.deleted];
    onProgress(62, `Deleting nodes for ${pathsToDelete.length} file(s)...`);
    await withTimeout(initLbug(lbugPath), DB_OPERATION_TIMEOUT_MS, 'initLbug');
    try { await loadFTSExtension(); } catch {}
    await withTimeout(
      deleteNodesByFilePath(pathsToDelete),
      DB_OPERATION_TIMEOUT_MS,
      'deleteNodesByFilePath',
    );

    // Step 4: Insert updated nodes into the live DB
    onProgress(65, 'Inserting updated nodes...');
    let lbugMsgCount = 0;
    await withTimeout(
      loadGraphToLbug(pipelineResult.graph, pipelineResult.repoPath, storagePath, (msg) => {
        lbugMsgCount++;
        const progress = Math.min(84, 65 + Math.round((lbugMsgCount / (lbugMsgCount + 5)) * 19));
        onProgress(progress, msg);
      }),
      DB_OPERATION_TIMEOUT_MS * 2,
      'loadGraphToLbug',
    );

    // Step 5: Eager FTS rebuild — eliminates first-query latency spike
    onProgress(85, 'Rebuilding FTS indexes...');
    let ftsRebuilt = false;
    try {
      await rebuildFTSIndexes();
      ftsRebuilt = true;
    } catch {
      // FTS extension may not be available — fall back to stale flag
    }

    // Step 6: Incremental embeddings — only embed new/changed nodes
    if (embeddingsEnabled) {
      const embedStats = await getLbugStats();
      if (embedStats.nodes <= embeddingNodeLimit) {
        const existingEmbIds = new Set<string>();
        try {
          const rows = await executeQuery(`MATCH (e:CodeEmbedding) RETURN e.nodeId AS nid`);
          for (const r of rows) if (r.nid) existingEmbIds.add(String(r.nid));
        } catch {}

        onProgress(88, 'Embedding new nodes...');
        const { runEmbeddingPipeline } = await import('../embeddings/embedding-pipeline.js');
        await runEmbeddingPipeline(
          executeQuery,
          executeWithReusedStatement,
          (progress) => {
            const scaled = 88 + Math.round((progress.percent / 100) * 3);
            onProgress(scaled, `Embedding ${progress.nodesProcessed || 0}/${progress.totalNodes || '?'}`);
          },
          {},
          existingEmbIds.size > 0 ? existingEmbIds : undefined,
        );
      }
    }

    // Step 7: Community detection — skip for small changesets.
    const affectedRatio = (existingMeta?.stats?.files ?? 0) > 0
      ? affectedFiles.all.length / existingMeta.stats!.files!
      : 1;

    if (affectedRatio < COMMUNITY_REDETECT_THRESHOLD) {
      onProgress(95, `Keeping communities (${affectedFiles.all.length} files < ${Math.round(COMMUNITY_REDETECT_THRESHOLD * 100)}% threshold)`);
    } else {
      let skipCommunityDetection = false;
      try {
        const structuralCheck = await executeQuery(
          `MATCH (n)-[r:CodeRelation]->(m)
           WHERE r.type IN ['CALLS', 'EXTENDS', 'IMPLEMENTS']
             AND n.filePath IN [${[...fileFilter].map(p => `'${escapeCypher(p)}'`).join(', ')}]
           RETURN count(r) AS cnt LIMIT 1`,
        );
        if (Number(structuralCheck[0]?.cnt ?? 0) === 0) {
          skipCommunityDetection = true;
          onProgress(95, 'Skipping community detection (no structural changes)');
        }
      } catch {}

      if (!skipCommunityDetection) {
        onProgress(92, 'Re-detecting communities (Louvain)...');
        try { await executeQuery('MATCH (c:Community) DETACH DELETE c'); } catch {}
        try {
          await loadAlgoExtension();
          const communityResult = await processCommunitiesInDB(executeQuery, (message, progress) => {
            const scaled = 92 + Math.round((progress / 100) * 3);
            onProgress(scaled, message);
          });
          pipelineResult.communityResult = communityResult;
        } catch {
          pipelineResult.communityResult = {
            communities: [],
            memberships: [],
            stats: { totalCommunities: 0, modularity: 0, nodesProcessed: 0 },
          };
        }
      }
    }

    // Step 8: Update process stats from DB
    try {
      const procRows = await executeQuery(`MATCH (p:Process) RETURN count(p) AS cnt`);
      const processCount = Number(procRows[0]?.cnt ?? 0);
      if (pipelineResult.processResult) {
        pipelineResult.processResult.stats.totalProcesses = processCount;
      }
    } catch {}

    // Step 9: Checkpoint DB THEN save metadata.
    // ORDER IS CRITICAL: if checkpoint fails, meta.json still has dirty=true
    // (set by the caller before this function), so the next run forces a full
    // rebuild. If we saved meta first (clearing dirty + advancing lastCommit)
    // and then checkpoint failed, the next run would see a clean meta pointing
    // at a commit whose data was never persisted — silent data loss.
    onProgress(96, 'Checkpointing database...');
    await withTimeout(checkpointLbug(), DB_OPERATION_TIMEOUT_MS, 'checkpoint');

    onProgress(97, 'Saving metadata...');
    const stats = await getLbugStats();
    const meta: RepoMeta = {
      repoPath,
      lastCommit: currentCommit,
      indexedAt: new Date().toISOString(),
      ftsStale: !ftsRebuilt,
      stats: {
        files: pipelineResult.totalFileCount,
        nodes: stats.nodes,
        edges: stats.edges,
        communities: pipelineResult.communityResult?.stats.totalCommunities,
        processes: pipelineResult.processResult?.stats.totalProcesses,
      },
    };
    await saveMeta(storagePath, meta);
    await registerRepo(repoPath, meta);

    // Update symbol cache: merge fresh entries for affected files into
    // the previous cache, and remove entries for deleted files.
    try {
      const freshEntries = buildSymbolCacheFromGraph(pipelineResult.graph);
      const merged = symbolCache?.files ?? {};
      for (const [fp, entry] of Object.entries(freshEntries)) {
        merged[fp] = entry;
      }
      for (const fp of affectedFiles.deleted) {
        delete merged[fp];
      }
      await saveSymbolCache(storagePath, currentCommit, merged);
    } catch {
      // Symbol cache is advisory — failures are non-fatal
    }

    await closeLbug();
    completedCleanly = true;

    return {
      elapsedMs: Date.now() - t0,
      stats,
      pipelineResult,
    };
  } finally {
    await releaseLock(lockPath, completedCleanly);
  }
}

/**
 * Escape a string for safe interpolation inside a Cypher single-quoted literal.
 * Handles backslashes, single quotes, null bytes, and control characters.
 * File paths come from git diff (trusted) but may contain quotes or unicode.
 */
function escapeCypher(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\0/g, '')
    .replace(/[\x01-\x1f\x7f]/g, '');
}

/**
 * Analyze Command -- Repository Indexing Orchestrator
 *
 * Indexes a repository and stores the knowledge graph in .gitnexus/.
 *
 * Phase boundaries:
 * 1. PIPELINE:    Scan, parse, resolve -> KnowledgeGraph (in-memory, ephemeral)
 * 2. STORE:       Persist graph to LadybugDB via CSV COPY (full) or filtered insert (incremental)
 * 3. ENRICHMENT:  Community detection (Louvain), FTS indexes, embeddings (operate on stored graph)
 *
 * Execution modes:
 * - Full rebuild: blue-green swap (build pending DB, atomic rename to live)
 * - Incremental:  parse (no DB lock) -> open DB -> delete affected -> re-insert -> close
 *   Incremental auto-enables when meta.json exists and HEAD differs from lastCommit.
 *   Falls back to full rebuild when >30% of files changed or crash recovery is needed.
 */

import path from 'path';
import { execFileSync } from 'child_process';
import v8 from 'v8';
import cliProgress from 'cli-progress';
import { runPipelineFromRepo } from '../core/ingestion/pipeline.js';
import { initLbug, loadGraphToLbug, getLbugStats, executeQuery, executeWithReusedStatement, closeLbug, checkpointLbug, createFTSIndex, loadCachedEmbeddings, loadAlgoExtension, loadFTSExtension, deleteNodesByFilePath, rebuildFTSIndexes } from '../core/lbug/lbug-adapter.js';
import { processCommunitiesInDB } from '../core/ingestion/community-processor.js';
import { expandAffectedFiles, type AffectedFileSet } from '../core/ingestion/incremental.js';
import { runIncrementalPipeline } from '../core/ingestion/incremental-pipeline.js';
// Embedding imports are lazy (dynamic import) so onnxruntime-node is never
// loaded when embeddings are not requested. This avoids crashes on Node
// versions whose ABI is not yet supported by the native binary (#89).
// disposeEmbedder intentionally not called — ONNX Runtime segfaults on cleanup (see #38)
import { getStoragePaths, saveMeta, loadMeta, addToGitignore, registerRepo, getGlobalRegistryPath, cleanupOldKuzuFiles, type RepoMeta } from '../storage/repo-manager.js';
import { getCurrentCommit, getGitRoot, hasGitDir, getTrackedFiles, getChangedFiles, type ChangedFile } from '../storage/git.js';
import { generateAIContextFiles } from './ai-context.js';
import { generateSkillFiles, type GeneratedSkillInfo } from './skill-gen.js';
import { isNativeAvailable } from '../core/native-bridge.js';
import type { KnowledgeGraph } from '../core/graph/types.js';
import { filterGraphForIncremental } from '../core/ingestion/graph-filter.js';
import fs from 'fs/promises';

export { filterGraphForIncremental };

const HEAP_MB = 8192;
const HEAP_FLAG = `--max-old-space-size=${HEAP_MB}`;

/** Re-exec the process with an 8GB heap if we're currently below that. */
function ensureHeap(): boolean {
  const nodeOpts = process.env.NODE_OPTIONS || '';
  if (nodeOpts.includes('--max-old-space-size')) return false;

  const v8Heap = v8.getHeapStatistics().heap_size_limit;
  if (v8Heap >= HEAP_MB * 1024 * 1024 * 0.9) return false;

  try {
    execFileSync(process.execPath, [HEAP_FLAG, ...process.argv.slice(1)], {
      stdio: 'inherit',
      env: { ...process.env, NODE_OPTIONS: `${nodeOpts} ${HEAP_FLAG}`.trim() },
    });
  } catch (e: any) {
    process.exitCode = e.status ?? 1;
  }
  return true;
}

export interface AnalyzeOptions {
  force?: boolean;
  embeddings?: boolean;
  skills?: boolean;
  verbose?: boolean;
  /** Index the folder even when no .git directory is present. */
  skipGit?: boolean;
  /** Explicitly disable incremental mode (--no-incremental). When undefined,
   *  incremental is auto-enabled if meta.json exists and lastCommit differs. */
  incremental?: boolean;
  /** Skip .gitignore parsing — recovers files excluded by overly broad patterns. */
  noGitignore?: boolean;
  /** Follow symbolic links during file discovery. */
  followSymlinks?: boolean;
}

/** Threshold: auto-skip embeddings for repos with more nodes than this.
 *  Configurable via GITNEXUS_EMBEDDING_NODE_LIMIT env var.
 *  When an HTTP endpoint is configured (GITNEXUS_EMBEDDING_URL), the limit
 *  is raised to 2M by default since remote GPUs handle scale effortlessly. */
const getEmbeddingNodeLimit = (): number => {
  const envLimit = process.env.GITNEXUS_EMBEDDING_NODE_LIMIT;
  if (envLimit) {
    const parsed = parseInt(envLimit, 10);
    if (!Number.isNaN(parsed) && parsed > 0) return parsed;
  }
  const hasHttpEndpoint = !!process.env.GITNEXUS_EMBEDDING_URL && !!process.env.GITNEXUS_EMBEDDING_MODEL;
  return hasHttpEndpoint ? 2_000_000 : 50_000;
};
const EMBEDDING_NODE_LIMIT = getEmbeddingNodeLimit();

const PHASE_LABELS: Record<string, string> = {
  extracting: 'Scanning files',
  structure: 'Building structure',
  parsing: 'Parsing code',
  imports: 'Resolving imports',
  calls: 'Tracing calls',
  heritage: 'Extracting inheritance',
  communities: 'Detecting communities',
  processes: 'Detecting processes',
  complete: 'Pipeline complete',
  lbug: 'Loading into LadybugDB',
  fts: 'Creating search indexes',
  embeddings: 'Generating embeddings',
  done: 'Done',
};

/**
 * Mark the index as dirty (incremental reindex in progress).
 * If the process crashes before clearing the flag, the next run will
 * detect it and force a full rebuild.
 */
async function setDirtyFlag(storagePath: string, existingMeta: RepoMeta): Promise<void> {
  await saveMeta(storagePath, { ...existingMeta, dirty: true });
}

// ── Extracted: post-load enrichment phases ──────────────────────────────
// Shared between full rebuild and incremental paths.

interface PostLoadOptions {
  embeddingsEnabled: boolean;
  nodeLimit: number;
}

/**
 * Run enrichment phases that operate on the stored graph:
 * community detection (Louvain) and embeddings.
 *
 * Used by both full rebuild (on the pending DB) and incremental (on the live DB).
 */
async function runPostLoadPhases(
  onProgress: (pct: number, label: string) => void,
  pipelineResult: { communityResult?: any; processResult?: any },
  opts: PostLoadOptions,
): Promise<void> {
  // Community detection
  onProgress(0, 'Detecting code communities (in-DB Louvain)...');
  try {
    await loadAlgoExtension();
    const communityResult = await processCommunitiesInDB(executeQuery, (message, progress) => {
      onProgress(Math.round(progress * 0.6), message);
    });
    pipelineResult.communityResult = communityResult;
  } catch {
    pipelineResult.communityResult = {
      communities: [],
      memberships: [],
      stats: { totalCommunities: 0, modularity: 0, nodesProcessed: 0 },
    };
  }

  // Embeddings
  if (opts.embeddingsEnabled) {
    const stats = await getLbugStats();
    if (stats.nodes <= opts.nodeLimit) {
      onProgress(60, 'Generating embeddings...');
      const { isHttpMode } = await import('../core/embeddings/http-client.js');
      const { runEmbeddingPipeline } = await import('../core/embeddings/embedding-pipeline.js');
      await runEmbeddingPipeline(
        executeQuery,
        executeWithReusedStatement,
        (progress) => {
          onProgress(60 + Math.round((progress.percent / 100) * 30), `Embedding ${progress.nodesProcessed || 0}/${progress.totalNodes || '?'}`);
        },
        {},
      );
    }
  }
  onProgress(100, 'Post-load phases complete');
}

export const analyzeCommand = async (
  inputPath?: string,
  options?: AnalyzeOptions
) => {
  if (ensureHeap()) return;

  if (options?.verbose) {
    process.env.GITNEXUS_VERBOSE = '1';
  }

  if (options?.noGitignore) {
    process.env.GITNEXUS_NO_GITIGNORE = '1';
  }

  if (options?.followSymlinks) {
    process.env.GITNEXUS_FOLLOW_SYMLINKS = '1';
  }

  console.log('\n  GitNexus Analyzer\n');

  const useNative = isNativeAvailable();
  if (useNative) {
    console.log('  Native core: available (Rust, not yet active for parsing)\n');
  }

  let repoPath: string;
  if (inputPath) {
    repoPath = path.resolve(inputPath);
  } else {
    const gitRoot = getGitRoot(process.cwd());
    if (!gitRoot) {
      if (!options?.skipGit) {
        console.log('  Not inside a git repository.\n  Tip: pass --skip-git to index any folder without a .git directory.\n');
        process.exitCode = 1;
        return;
      }
      // --skip-git: fall back to cwd as the root
      repoPath = path.resolve(process.cwd());
    } else {
      repoPath = gitRoot;
    }
  }

  const repoHasGit = hasGitDir(repoPath);
  if (!repoHasGit && !options?.skipGit) {
    console.log('  Not a git repository.\n  Tip: pass --skip-git to index any folder without a .git directory.\n');
    process.exitCode = 1;
    return;
  }
  if (!repoHasGit) {
    console.log('  Warning: no .git directory found \u2014 commit-tracking and incremental updates disabled.\n');
  }

  const { storagePath, lbugPath } = getStoragePaths(repoPath);

  // Warn early if disk space is critically low
  try {
    const diskStats = await fs.statfs(repoPath);
    const freeGB = (diskStats.bavail * diskStats.bsize) / (1024 ** 3);
    if (freeGB < 0.5) {
      console.log(`  Warning: Low disk space (${freeGB.toFixed(1)} GB free). Indexing may fail.\n`);
    }
  } catch { /* statfs not available on all platforms — skip */ }

  // Clean up stale KuzuDB files from before the LadybugDB migration.
  // If kuzu existed but lbug doesn't, we're doing a migration re-index — say so.
  const kuzuResult = await cleanupOldKuzuFiles(storagePath);
  if (kuzuResult.found && kuzuResult.needsReindex) {
    console.log('  Migrating from KuzuDB to LadybugDB — rebuilding index...\n');
  }

  const currentCommit = repoHasGit ? getCurrentCommit(repoPath) : '';
  const existingMeta = await loadMeta(storagePath);

  // Crash recovery: if a previous incremental run crashed mid-reindex, the DB
  // is in an inconsistent state.  Force a full rebuild to recover.
  if (existingMeta?.dirty) {
    console.log('  ⚠ Previous incremental reindex did not complete. Forcing full rebuild to recover.\n');
    options = { ...options, force: true, incremental: false };
  }

  if (existingMeta && !options?.force && !options?.skills && existingMeta.lastCommit === currentCommit) {
    // Non-git folders have currentCommit = '' — always rebuild since we can't detect changes
    if (currentCommit !== '') {
      console.log('  Already up to date\n');
      return;
    }
  }

  // ── Incremental change detection ─────────────────────────────────
  // When --incremental is set and a prior index exists, diff the git history
  // to identify which files changed.  The actual per-file reindex pipeline
  // (Phase 1 items 1A–1E) will consume this list — until that's built we
  // detect changes here and fall through to a full rebuild.
  let incrementalChanges: ChangedFile[] | null = null;
  let affectedFiles: AffectedFileSet | null = null;
  // Auto-enable incremental when meta.json exists with a lastCommit that
  // differs from HEAD. Disabled by --force or --no-incremental (which sets
  // options.incremental to false via Commander's negated boolean).
  const useIncremental = options?.incremental !== false
    && !options?.force
    && repoHasGit
    && !!existingMeta?.lastCommit
    && !!currentCommit
    && existingMeta.lastCommit !== currentCommit;
  if (useIncremental) {
    const changed = getChangedFiles(repoPath, existingMeta.lastCommit, currentCommit);
    if (changed.length === 0 && existingMeta.lastCommit === currentCommit) {
      console.log('  Already up to date (incremental: 0 files changed)\n');
      return;
    }
    incrementalChanges = changed;
    console.log(`  Incremental: ${changed.length} file(s) changed since ${existingMeta.lastCommit.slice(0, 8)}`);
    if (changed.length > 0 && changed.length <= 20) {
      for (const f of changed) {
        console.log(`    ${f.status} ${f.path}${f.oldPath ? ` (was ${f.oldPath})` : ''}`);
      }
    }

    // Open existing DB to expand the affected set via import graph (1-hop)
    try {
      await initLbug(lbugPath);
      affectedFiles = await expandAffectedFiles(executeQuery, changed, repoPath);
      await closeLbug();
      if (affectedFiles.importers.length > 0) {
        console.log(`  +${affectedFiles.importers.length} importer(s) affected (${affectedFiles.all.length} files total)`);
      }
    } catch {
      try { await closeLbug(); } catch {}
      affectedFiles = null;
    }

    // Fallback to full rebuild when too many files changed.
    // Configurable via GITNEXUS_FALLBACK_THRESHOLD (default 0.30 = 30%).
    const FALLBACK_THRESHOLD = parseFloat(process.env.GITNEXUS_FALLBACK_THRESHOLD ?? '0.30');
    if (affectedFiles && existingMeta?.stats?.files) {
      const totalFiles = existingMeta.stats.files;
      const ratio = affectedFiles.all.length / totalFiles;
      if (totalFiles > 0 && ratio > FALLBACK_THRESHOLD) {
        console.log(`  Too many files changed (${affectedFiles.all.length}/${totalFiles} = ${Math.round(ratio * 100)}% > ${Math.round(FALLBACK_THRESHOLD * 100)}%), falling back to full rebuild\n`);
        affectedFiles = null;
      }
    }

    // ── Incremental pipeline: parse → delete → re-insert ──────────
    if (affectedFiles && affectedFiles.all.length > 0) {
      console.log('  Running incremental reindex...\n');

      const bar = new cliProgress.SingleBar({
        format: '  {bar} {percentage}% | {phase}',
        barCompleteChar: '\u2588',
        barIncompleteChar: '\u2591',
        hideCursor: true,
        barGlue: '',
        autopadding: true,
        clearOnComplete: false,
        stopOnComplete: false,
      }, cliProgress.Presets.shades_grey);
      bar.start(100, 0, { phase: 'Incremental reindex...' });

      if (existingMeta) {
        await setDirtyFlag(storagePath, existingMeta);
      }

      const result = await runIncrementalPipeline({
        repoPath,
        lbugPath,
        storagePath,
        currentCommit,
        affectedFiles,
        existingMeta: existingMeta!,
        embeddingsEnabled: !!options?.embeddings,
        embeddingNodeLimit: EMBEDDING_NODE_LIMIT,
        onProgress: (pct, phase) => {
          const phaseLabel = PHASE_LABELS[phase] || phase;
          bar.update(pct, { phase: phaseLabel });
        },
      });

      bar.update(100, { phase: 'Done' });
      bar.stop();

      const incrTime = (result.elapsedMs / 1000).toFixed(1);
      console.log(`\n  Incremental reindex complete (${incrTime}s)`);
      console.log(`  ${affectedFiles.directlyChanged.length} changed + ${affectedFiles.importers.length} importers = ${affectedFiles.all.length} files re-indexed${affectedFiles.deleted.length > 0 ? ` (${affectedFiles.deleted.length} deleted)` : ''}`);
      console.log(`  ${result.stats.nodes.toLocaleString()} nodes | ${result.stats.edges.toLocaleString()} edges`);
      console.log(`  ${repoPath}\n`);

      // TODO(#38): Remove process.exit once LadybugDB N-API destructors and
      // ONNX Runtime atexit handlers no longer segfault on normal exit.
      process.exit(0);
    }
  }

  if (process.env.GITNEXUS_NO_GITIGNORE) {
    console.log('  GITNEXUS_NO_GITIGNORE is set — skipping .gitignore (still reading .gitnexusignore)\n');
  }

  // Single progress bar for entire pipeline
  const bar = new cliProgress.SingleBar({
    format: '  {bar} {percentage}% | {phase}',
    barCompleteChar: '\u2588',
    barIncompleteChar: '\u2591',
    hideCursor: true,
    barGlue: '',
    autopadding: true,
    clearOnComplete: false,
    stopOnComplete: false,
  }, cliProgress.Presets.shades_grey);

  bar.start(100, 0, { phase: 'Initializing...' });

  // Paths for the blue-green swap (declared early so SIGINT cleanup can reach them)
  const pendingLbugPath = lbugPath + '.pending';
  const prevLbugPath = lbugPath + '.prev';

  // Graceful SIGINT handling — clean up resources and exit.
  // Also removes the incomplete pending DB so it doesn't confuse the next run.
  let aborted = false;
  const sigintHandler = () => {
    if (aborted) process.exit(1); // Second Ctrl-C: force exit
    aborted = true;
    bar.stop();
    console.log('\n  Interrupted — cleaning up...');
    closeLbug()
      .catch(() => {})
      .finally(async () => {
        for (const f of [pendingLbugPath, `${pendingLbugPath}.wal`, `${pendingLbugPath}.lock`]) {
          try { await fs.rm(f, { force: true }); } catch {}
        }
        process.exit(130);
      });
  };
  process.on('SIGINT', sigintHandler);

  // Route all console output through bar.log() so the bar doesn't stamp itself
  // multiple times when other code writes to stdout/stderr mid-render.
  const origLog = console.log.bind(console);
  const origWarn = console.warn.bind(console);
  const origError = console.error.bind(console);
  const barLog = (...args: any[]) => {
    // Clear the bar line, print the message, then let the next bar.update redraw
    process.stdout.write('\x1b[2K\r');
    origLog(args.map(a => (typeof a === 'string' ? a : String(a))).join(' '));
  };
  console.log = barLog;
  console.warn = barLog;
  console.error = barLog;

  // Track elapsed time per phase — both updateBar and the interval use the
  // same format so they don't flicker against each other.
  let lastPhaseLabel = 'Initializing...';
  let phaseStart = Date.now();

  /** Update bar with phase label + elapsed seconds (shown after 3s). */
  const updateBar = (value: number, phaseLabel: string) => {
    if (phaseLabel !== lastPhaseLabel) { lastPhaseLabel = phaseLabel; phaseStart = Date.now(); }
    const elapsed = Math.round((Date.now() - phaseStart) / 1000);
    const display = elapsed >= 3 ? `${phaseLabel} (${elapsed}s)` : phaseLabel;
    bar.update(value, { phase: display });
  };

  // Tick elapsed seconds for phases with infrequent progress callbacks
  // (e.g. CSV streaming, FTS indexing). Uses the same display format as
  // updateBar so there's no flickering.
  const elapsedTimer = setInterval(() => {
    const elapsed = Math.round((Date.now() - phaseStart) / 1000);
    if (elapsed >= 3) {
      bar.update({ phase: `${lastPhaseLabel} (${elapsed}s)` });
    }
  }, 1000);

  const t0Global = Date.now();

  // ── Cache embeddings from existing index before rebuild ────────────
  let cachedEmbeddingNodeIds = new Set<string>();
  let cachedEmbeddings: Array<{ nodeId: string; embedding: number[] }> = [];

  if (options?.embeddings && existingMeta && !options?.force) {
    try {
      updateBar(0, 'Caching embeddings...');
      await initLbug(lbugPath);
      const cached = await loadCachedEmbeddings();
      cachedEmbeddingNodeIds = cached.embeddingNodeIds;
      cachedEmbeddings = cached.embeddings;
      await closeLbug();
    } catch {
      try { await closeLbug(); } catch {}
    }
  }

  // ── Phase 1: Full Pipeline (0–60%) ─────────────────────────────────
  const pipelineResult = await runPipelineFromRepo(repoPath, (progress) => {
    const phaseLabel = PHASE_LABELS[progress.phase] || progress.phase;
    const scaled = Math.round(progress.percent * 0.6);
    updateBar(scaled, phaseLabel);
  });

  // ── Phase 2: LadybugDB (60–85%) — Blue-Green Swap ──────────────────
  // Build into a shadow database (lbug.pending) so the live serve process
  // keeps reading the existing lbug without interruption.  After the build
  // completes we do an atomic rename swap.
  updateBar(60, 'Loading into LadybugDB...');

  await closeLbug();

  // Clean stale pending build from a previous interrupted run
  for (const f of [pendingLbugPath, `${pendingLbugPath}.wal`, `${pendingLbugPath}.lock`]) {
    try { await fs.rm(f, { recursive: true, force: true }); } catch {}
  }

  const t0Lbug = Date.now();
  await initLbug(pendingLbugPath);
  let lbugMsgCount = 0;
  const lbugResult = await loadGraphToLbug(pipelineResult.graph, pipelineResult.repoPath, storagePath, (msg) => {
    lbugMsgCount++;
    const progress = Math.min(84, 60 + Math.round((lbugMsgCount / (lbugMsgCount + 10)) * 24));
    updateBar(progress, msg);
  });
  const lbugTime = ((Date.now() - t0Lbug) / 1000).toFixed(1);
  const lbugWarnings = lbugResult.warnings;

  // ── Phase 3: FTS (85–90%) ─────────────────────────────────────────
  updateBar(85, 'Creating search indexes...');

  const t0Fts = Date.now();
  const ftsTargets: Array<[string, string, string[]]> = [
    ['File', 'file_fts', ['name', 'content']],
    ['Function', 'function_fts', ['name', 'content']],
    ['Class', 'class_fts', ['name', 'content']],
    ['Method', 'method_fts', ['name', 'content']],
    ['Interface', 'interface_fts', ['name', 'content']],
    ['Struct', 'struct_fts', ['name', 'content']],
    ['Enum', 'enum_fts', ['name', 'content']],
    ['Macro', 'macro_fts', ['name', 'content']],
    ['Typedef', 'typedef_fts', ['name', 'content']],
    ['Const', 'const_fts', ['name', 'content']],
    ['Property', 'property_fts', ['name', 'content']],
    ['Constructor', 'constructor_fts', ['name', 'content']],
    ['Trait', 'trait_fts', ['name', 'content']],
    ['Namespace', 'namespace_fts', ['name', 'content']],
    ['Union', 'union_fts', ['name', 'content']],
  ];
  for (const [table, idx, props] of ftsTargets) {
    try {
      await createFTSIndex(table, idx, props);
    } catch {
      // Non-fatal — table may be empty or FTS unsupported
    }
  }
  const ftsTime = ((Date.now() - t0Fts) / 1000).toFixed(1);

  // ── Phase 3.5: In-DB Community Detection ───────────────────────────
  updateBar(86, 'Detecting code communities (in-DB Louvain)...');

  const t0Comm = Date.now();
  try {
    await loadAlgoExtension();
    const communityResult = await processCommunitiesInDB(executeQuery, (message, progress) => {
      const scaled = 86 + Math.round((progress / 100) * 3);
      updateBar(scaled, message);
    });
    pipelineResult.communityResult = communityResult;
  } catch (e: any) {
    if (process.env.NODE_ENV === 'development') {
      console.error('Community detection failed:', e.message);
    }
    pipelineResult.communityResult = {
      communities: [],
      memberships: [],
      stats: { totalCommunities: 0, modularity: 0, nodesProcessed: 0 },
    };
  }
  const commTime = ((Date.now() - t0Comm) / 1000).toFixed(1);

  // ── Phase 3.6: Re-insert cached embeddings ────────────────────────
  if (cachedEmbeddings.length > 0) {
    // Check if cached embedding dimensions match current schema
    const cachedDims = cachedEmbeddings[0].embedding.length;
    const { EMBEDDING_DIMS } = await import('../core/lbug/schema.js');
    if (cachedDims !== EMBEDDING_DIMS) {
      // Dimensions changed (e.g. switched embedding model) — discard cache and re-embed all
      console.error(`⚠️  Embedding dimensions changed (${cachedDims}d → ${EMBEDDING_DIMS}d), discarding cache`);
      cachedEmbeddings = [];
      cachedEmbeddingNodeIds = new Set();
    } else {
      updateBar(88, `Restoring ${cachedEmbeddings.length} cached embeddings...`);
      const EMBED_BATCH = 200;
      for (let i = 0; i < cachedEmbeddings.length; i += EMBED_BATCH) {
        const batch = cachedEmbeddings.slice(i, i + EMBED_BATCH);
        const paramsList = batch.map(e => ({ nodeId: e.nodeId, embedding: e.embedding }));
        try {
          await executeWithReusedStatement(
            `CREATE (e:CodeEmbedding {nodeId: $nodeId, embedding: $embedding})`,
            paramsList,
          );
        } catch { /* some may fail if node was removed, that's fine */ }
      }
    }
  }

  // ── Phase 4: Embeddings (90–98%) ──────────────────────────────────
  const stats = await getLbugStats();
  let embeddingTime = '0.0';
  let embeddingSkipped = true;
  let embeddingSkipReason = 'off (use --embeddings to enable)';

  if (options?.embeddings) {
    if (stats.nodes > EMBEDDING_NODE_LIMIT) {
      embeddingSkipReason = `skipped (${stats.nodes.toLocaleString()} nodes > ${EMBEDDING_NODE_LIMIT.toLocaleString()} limit)`;
    } else {
      embeddingSkipped = false;
    }
  }

  if (!embeddingSkipped) {
    const { isHttpMode } = await import('../core/embeddings/http-client.js');
    const httpMode = isHttpMode();
    updateBar(90, httpMode ? 'Connecting to embedding endpoint...' : 'Loading embedding model...');
    const t0Emb = Date.now();
    const { runEmbeddingPipeline } = await import('../core/embeddings/embedding-pipeline.js');
    await runEmbeddingPipeline(
      executeQuery,
      executeWithReusedStatement,
      (progress) => {
        const scaled = 90 + Math.round((progress.percent / 100) * 8);
        const label = progress.phase === 'loading-model'
          ? (httpMode ? 'Connecting to embedding endpoint...' : 'Loading embedding model...')
          : `Embedding ${progress.nodesProcessed || 0}/${progress.totalNodes || '?'}`;
        updateBar(scaled, label);
      },
      {},
      cachedEmbeddingNodeIds.size > 0 ? cachedEmbeddingNodeIds : undefined,
    );
    embeddingTime = ((Date.now() - t0Emb) / 1000).toFixed(1);
  }

  // ── Phase 4.5: Stale file cleanup ──────────────────────────────────
  // After a full rebuild, the new DB should only contain files currently
  // tracked by git. Query all File nodes in the DB and remove any whose
  // filePath doesn't match a currently tracked file. This is a no-op for
  // first builds but catches ghost nodes from interrupted incremental runs.
  if (hasGitDir(repoPath)) {
    try {
      const trackedSet = new Set(getTrackedFiles(repoPath));
      const dbFiles = await executeQuery(
        `MATCH (f:File) RETURN f.filePath AS fp`,
      );
      const staleFiles: string[] = [];
      for (const row of dbFiles) {
        const fp = String(row.fp ?? '');
        if (fp && !trackedSet.has(fp)) staleFiles.push(fp);
      }
      if (staleFiles.length > 0) {
        updateBar(98, `Removing ${staleFiles.length} stale file(s)...`);
        await deleteNodesByFilePath(staleFiles);
        if (process.env.NODE_ENV === 'development') {
          console.log(`🗑️  Removed ${staleFiles.length} stale file(s) from index`);
        }
      }
    } catch {
      // Stale cleanup is best-effort
    }
  }

  // ── Phase 5: Finalize (98–100%) ───────────────────────────────────
  updateBar(98, 'Saving metadata...');

  // Count embeddings in the index (cached + newly generated)
  let embeddingCount = 0;
  try {
    const embResult = await executeQuery(`MATCH (e:CodeEmbedding) RETURN count(e) AS cnt`);
    embeddingCount = embResult?.[0]?.cnt ?? 0;
  } catch { /* table may not exist if embeddings never ran */ }

  const meta = {
    repoPath,
    lastCommit: currentCommit,
    indexedAt: new Date().toISOString(),
    stats: {
      files: pipelineResult.totalFileCount,
      nodes: stats.nodes,
      edges: stats.edges,
      communities: pipelineResult.communityResult?.stats.totalCommunities,
      processes: pipelineResult.processResult?.stats.totalProcesses,
      embeddings: embeddingCount,
    },
  };
  await saveMeta(storagePath, meta);
  await registerRepo(repoPath, meta);

  // Save symbol cache for incremental runs — exported symbols + import map
  // per file, used to seed the resolution context without full re-parse.
  try {
    const { saveSymbolCache, buildSymbolCacheFromGraph } = await import('../core/ingestion/symbol-cache.js');
    const cacheEntries = buildSymbolCacheFromGraph(pipelineResult.graph);
    await saveSymbolCache(storagePath, currentCommit, cacheEntries);
  } catch {
    // Symbol cache is advisory — failures are non-fatal
  }

  // Only attempt to update .gitignore when a .git directory is present.
  // Use hasGitDir (filesystem check) rather than git CLI subprocess
  // so we skip correctly for --skip-git folders even if git CLI is available.
  if (hasGitDir(repoPath)) {
    await addToGitignore(repoPath);
  }

  const projectName = path.basename(repoPath);
  let aggregatedClusterCount = 0;
  if (pipelineResult.communityResult?.communities) {
    const groups = new Map<string, number>();
    for (const c of pipelineResult.communityResult.communities) {
      const label = c.heuristicLabel || c.label || 'Unknown';
      groups.set(label, (groups.get(label) || 0) + c.symbolCount);
    }
    aggregatedClusterCount = Array.from(groups.values()).filter(count => count >= 5).length;
  }

  let generatedSkills: GeneratedSkillInfo[] = [];
  if (options?.skills && pipelineResult.communityResult) {
    updateBar(99, 'Generating skill files...');
    const skillResult = await generateSkillFiles(repoPath, projectName, pipelineResult);
    generatedSkills = skillResult.skills;
  }

  const aiContext = await generateAIContextFiles(repoPath, storagePath, projectName, {
    files: pipelineResult.totalFileCount,
    nodes: stats.nodes,
    edges: stats.edges,
    communities: pipelineResult.communityResult?.stats.totalCommunities,
    clusters: aggregatedClusterCount,
    processes: pipelineResult.processResult?.stats.totalProcesses,
  }, generatedSkills);

  // Flush WAL to disk before swapping — ensures the pending DB file is
  // self-contained and doesn't depend on a separate .wal sidecar.
  await checkpointLbug();
  await closeLbug();

  // ── Enrichment Preservation (stub) ──────────────────────────────────
  // Future enrichment agents (annotation agents, issue linkers, runtime
  // trace correlators) will tag their nodes with `source: 'enrichment'`.
  // Before the blue-green swap, query the old DB for enrichment-tagged
  // nodes and re-insert them after the swap. Currently a no-op since no
  // enrichment agents exist yet.
  // TODO: When enrichment agents ship, implement:
  //   1. Before swap: query old DB for nodes with source='enrichment'
  //   2. After swap: re-insert enrichment nodes into new DB

  // ── Blue-Green Atomic Swap ──────────────────────────────────────────
  // The pending DB is now fully built with FTS + embeddings.  Swap it
  // into the live path so the serve process picks it up on next query.
  // On POSIX, rename() is atomic when src and dst are on the same FS.
  try { await fs.rm(prevLbugPath, { force: true }); } catch {}
  try { await fs.rm(`${prevLbugPath}.wal`, { force: true }); } catch {}
  try { await fs.rm(`${prevLbugPath}.lock`, { force: true }); } catch {}
  try {
    await fs.rename(lbugPath, prevLbugPath);
  } catch {
    // First build ever — no existing lbug to move aside
  }
  await fs.rename(pendingLbugPath, lbugPath);
  // Move sidecars too (WAL may have been checkpointed away, so ignore errors)
  try { await fs.rename(`${pendingLbugPath}.wal`, `${lbugPath}.wal`); } catch {}
  try { await fs.rename(`${pendingLbugPath}.lock`, `${lbugPath}.lock`); } catch {}
  // Clean up the old database
  try { await fs.rm(prevLbugPath, { force: true }); } catch {}
  try { await fs.rm(`${prevLbugPath}.wal`, { force: true }); } catch {}
  try { await fs.rm(`${prevLbugPath}.lock`, { force: true }); } catch {}

  // Note: we intentionally do NOT call disposeEmbedder() here.
  // ONNX Runtime's native cleanup segfaults on macOS and some Linux configs.
  // Since the process exits immediately after, Node.js reclaims everything.

  const totalTime = ((Date.now() - t0Global) / 1000).toFixed(1);

  clearInterval(elapsedTimer);
  process.removeListener('SIGINT', sigintHandler);

  console.log = origLog;
  console.warn = origWarn;
  console.error = origError;

  bar.update(100, { phase: 'Done' });
  bar.stop();

  // ── Summary ───────────────────────────────────────────────────────
  const embeddingsCached = cachedEmbeddings.length > 0;
  console.log(`\n  Repository indexed successfully (${totalTime}s)${embeddingsCached ? ` [${cachedEmbeddings.length} embeddings cached]` : ''}\n`);
  console.log(`  ${stats.nodes.toLocaleString()} nodes | ${stats.edges.toLocaleString()} edges | ${pipelineResult.communityResult?.stats.totalCommunities || 0} clusters | ${pipelineResult.processResult?.stats.totalProcesses || 0} flows`);
  console.log(`  LadybugDB ${lbugTime}s | FTS ${ftsTime}s | Louvain ${commTime}s | Embeddings ${embeddingSkipped ? embeddingSkipReason : embeddingTime + 's'}`);
  console.log(`  ${repoPath}`);

  if (aiContext.files.length > 0) {
    console.log(`  Context: ${aiContext.files.join(', ')}`);
  }

  // Show a quiet summary if some edge types needed fallback insertion
  if (lbugWarnings.length > 0) {
    const totalFallback = lbugWarnings.reduce((sum, w) => {
      const m = w.match(/\((\d+) edges\)/);
      return sum + (m ? parseInt(m[1]) : 0);
    }, 0);
    console.log(`  Note: ${totalFallback} edges across ${lbugWarnings.length} types inserted via fallback (schema will be updated in next release)`);
  }

  try {
    await fs.access(getGlobalRegistryPath());
  } catch {
    console.log('\n  Tip: Run `gitnexus setup` to configure MCP for your editor.');
  }

  console.log('');

  // LadybugDB's native module holds open file descriptors and mmap regions
  // that prevent Node's event loop from draining. ONNX Runtime (if loaded for
  // embeddings) registers native atexit hooks that segfault on macOS and some
  // Linux distros (#38, #40). checkpointLbug() was called above (line 666) to
  // flush the WAL before closeLbug(), so all data is safely on disk.
  // process.exit(0) is the only reliable way to terminate cleanly.
  process.exit(0);
};
// verify-benchmark 1774557530

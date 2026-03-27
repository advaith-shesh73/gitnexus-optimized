/**
 * Standalone version of the incremental-equivalence test.
 * Runs outside vitest to avoid N-API destructor crashes in fork workers.
 * Exit code 0 = pass, 1 = assertion failure, 139 = N-API exit crash (harmless).
 */
import { execSync } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

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

process.on('uncaughtException', (e) => { console.error('UNCAUGHT:', e); process.exit(1); });
process.on('unhandledRejection', (e) => { console.error('UNHANDLED:', e); process.exit(1); });

const SKIP_LABELS = new Set(['Community', 'Process', 'CodeEmbedding']);
const SKIP_REL_TYPES = new Set(['MEMBER_OF', 'STEP_IN_PROCESS', 'ENTRY_POINT_OF']);

interface NodeSnapshot { id: string; label: string; name: string; filePath: string }
interface EdgeSnapshot { sourceId: string; targetId: string; type: string }
interface DBSnapshot { nodes: NodeSnapshot[]; edges: EdgeSnapshot[] }

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

function normalizeSnapshot(snap: DBSnapshot, repoPath: string): DBSnapshot {
  const prefix = repoPath.endsWith('/') ? repoPath : repoPath + '/';
  const strip = (s: string) => s.replace(prefix, '');
  return {
    nodes: snap.nodes.map(n => ({ ...n, id: strip(n.id), filePath: strip(n.filePath) })),
    edges: snap.edges.map(e => ({ ...e, sourceId: strip(e.sourceId), targetId: strip(e.targetId) })),
  };
}

const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'equiv-'));
const repoDir = path.join(tmpDir, 'repo');
const srcDir = path.join(repoDir, 'src');

const git = (cmd: string) =>
  execSync(`git ${cmd}`, {
    cwd: repoDir, stdio: 'pipe',
    env: { ...process.env, GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 't@t' },
  }).toString().trim();

await fs.mkdir(srcDir, { recursive: true });

// Create a small but representative repo
async function writeFile(dir: string, relPath: string, content: string) {
  const fullPath = path.join(dir, relPath);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, content);
}

await writeFile(repoDir, 'src/types.ts', `export interface User { id: string; name: string; }`);
await writeFile(repoDir, 'src/logger.ts', `export function log(msg: string) { console.log(msg); }`);
await writeFile(repoDir, 'src/validator.ts', `import type { User } from './types.js';\nexport function validate(u: User) { return !!u.id; }`);
await writeFile(repoDir, 'src/formatter.ts', `import type { User } from './types.js';\nexport function format(u: User) { return u.name; }`);
await writeFile(repoDir, 'src/service.ts', `import { validate } from './validator.js';\nimport { format } from './formatter.js';\nimport { log } from './logger.js';\nexport function process(u: any) { if (validate(u)) log(format(u)); }`);
await writeFile(repoDir, 'src/handler.ts', `import { process } from './service.js';\nexport function handle(req: any) { process(req.body); }`);
await writeFile(repoDir, 'src/analytics.ts', `import { log } from './logger.js';\nexport function track(event: string) { log(event); }`);
await writeFile(repoDir, 'src/router.ts', `import { handle } from './handler.js';\nimport { track } from './analytics.js';\nexport function route(path: string, req: any) { track(path); handle(req); }`);

git('init --initial-branch=main');
git('add -A');
git('commit -m "initial"');
const commit1 = git('rev-parse HEAD');

console.log('[1] Full rebuild A (baseline)...');
const storageA = path.join(tmpDir, 'storage-a');
const dbA = path.join(storageA, 'lbug');
await fs.mkdir(storageA, { recursive: true });
const resultA = await runPipelineFromRepo(repoDir, () => {});
await initLbug(dbA);
await loadGraphToLbug(resultA.graph, repoDir, storageA, () => {});
await checkpointLbug();
const snapA = await snapshotDB();
console.log(`    Nodes: ${snapA.nodes.length}, Edges: ${snapA.edges.length}`);
await closeLbug();

// Modify files
await writeFile(repoDir, 'src/validator.ts', `import type { User } from './types.js';\nexport function validate(u: User) { return !!u.id && !!u.name; }\nexport function isAdmin(u: User) { return u.name === 'admin'; }`);
await writeFile(repoDir, 'src/cache.ts', `export const cache = new Map<string, any>();\nexport function get(key: string) { return cache.get(key); }`);
await fs.rm(path.join(repoDir, 'src/analytics.ts'));
await writeFile(repoDir, 'src/router.ts', `import { handle } from './handler.js';\nexport function route(path: string, req: any) { handle(req); }`);

git('add -A');
git('commit -m "modifications"');
const commit2 = git('rev-parse HEAD');

const diffOutput = execSync(`git diff --name-status ${commit1} ${commit2}`, { cwd: repoDir, encoding: 'utf8' }).trim();
const changedFiles: ChangedFile[] = diffOutput.split('\n').filter(Boolean).map(line => {
  const parts = line.split('\t');
  const status = parts[0] as ChangedFile['status'];
  return { status, path: parts[1] };
});
console.log('[2] Changed files:', changedFiles.map(f => `${f.status} ${f.path}`));

console.log('[3] Full rebuild B (expected)...');
const storageB = path.join(tmpDir, 'storage-b');
const dbB = path.join(storageB, 'lbug');
await fs.mkdir(storageB, { recursive: true });
const resultB = await runPipelineFromRepo(repoDir, () => {});
await initLbug(dbB);
await loadGraphToLbug(resultB.graph, repoDir, storageB, () => {});
await checkpointLbug();
const snapB = await snapshotDB();
console.log(`    Nodes: ${snapB.nodes.length}, Edges: ${snapB.edges.length}`);
await closeLbug();

console.log('[4] Incremental rebuild C (actual)...');
const storageC = path.join(tmpDir, 'storage-c');
const dbC = path.join(storageC, 'lbug');
await fs.mkdir(storageC, { recursive: true });
await fs.copyFile(dbA, dbC);
try { await fs.copyFile(dbA + '.wal', dbC + '.wal'); } catch {}

console.log('    4a: opening DB C...');
await initLbug(dbC);
console.log('    4b: expanding affected files...');
const affectedFiles = await expandAffectedFiles(executeQuery, changedFiles, repoDir);
console.log(`    Affected: directly=${affectedFiles.directlyChanged.length}, importers=${affectedFiles.importers.length}, deleted=${affectedFiles.deleted.length}`);
console.log(`    All: ${affectedFiles.all.join(', ')}`);
console.log(`    Deleted: ${affectedFiles.deleted.join(', ')}`);

const pathsToDelete = [...affectedFiles.all, ...affectedFiles.deleted];
console.log(`    4c: deleting ${pathsToDelete.length} paths...`);
await deleteNodesByFilePath(pathsToDelete);

console.log('    4d: running pipeline with fileFilter:', [...affectedFiles.all]);
const fileFilter = new Set(affectedFiles.all);
let resultC: Awaited<ReturnType<typeof runPipelineFromRepo>>;
try {
  resultC = await runPipelineFromRepo(repoDir, () => {}, { fileFilter });
} catch (e: any) {
  console.error('    PIPELINE ERROR:', e.message);
  console.error(e.stack);
  process.exit(1);
}
console.log(`    4e: filtering graph (${resultC.graph.nodeCount} nodes)...`);
filterGraphForIncremental(resultC.graph, fileFilter);
console.log(`    4f: loading to DB (${resultC.graph.nodeCount} nodes)...`);
await loadGraphToLbug(resultC.graph, repoDir, storageC, () => {});
console.log('    4g: checkpoint...');
await checkpointLbug();
console.log('    4h: snapshot...');
const snapC = await snapshotDB();
console.log(`    Nodes: ${snapC.nodes.length}, Edges: ${snapC.edges.length}`);
console.log('    4i: close...');
await closeLbug();

// Compare B and C
const normB = normalizeSnapshot(snapB, repoDir);
const normC = normalizeSnapshot(snapC, repoDir);

const nodeIdsB = new Set(normB.nodes.map(n => n.id));
const nodeIdsC = new Set(normC.nodes.map(n => n.id));
const onlyInFull = normB.nodes.filter(n => !nodeIdsC.has(n.id));
const onlyInIncr = normC.nodes.filter(n => !nodeIdsB.has(n.id));

const edgeKeyB = new Set(normB.edges.map(e => `${e.sourceId}|${e.targetId}|${e.type}`));
const edgeKeyC = new Set(normC.edges.map(e => `${e.sourceId}|${e.targetId}|${e.type}`));
const edgesOnlyInFull = normB.edges.filter(e => !edgeKeyC.has(`${e.sourceId}|${e.targetId}|${e.type}`));
const edgesOnlyInIncr = normC.edges.filter(e => !edgeKeyB.has(`${e.sourceId}|${e.targetId}|${e.type}`));

let failed = false;
if (onlyInFull.length > 0) {
  console.error(`FAIL: ${onlyInFull.length} nodes only in full rebuild:`);
  onlyInFull.forEach(n => console.error(`  ${n.label}:${n.name} (${n.filePath})`));
  failed = true;
}
if (onlyInIncr.length > 0) {
  console.error(`FAIL: ${onlyInIncr.length} nodes only in incremental:`);
  onlyInIncr.forEach(n => console.error(`  ${n.label}:${n.name} (${n.filePath})`));
  failed = true;
}
if (edgesOnlyInFull.length > 0) {
  console.error(`FAIL: ${edgesOnlyInFull.length} edges only in full rebuild:`);
  edgesOnlyInFull.slice(0, 20).forEach(e => console.error(`  ${e.type}: ${e.sourceId} -> ${e.targetId}`));
  failed = true;
}
if (edgesOnlyInIncr.length > 0) {
  console.error(`FAIL: ${edgesOnlyInIncr.length} edges only in incremental:`);
  edgesOnlyInIncr.slice(0, 20).forEach(e => console.error(`  ${e.type}: ${e.sourceId} -> ${e.targetId}`));
  failed = true;
}

if (failed) {
  console.error(`\nFAIL: Node counts: full=${normB.nodes.length}, incr=${normC.nodes.length}`);
  console.error(`FAIL: Edge counts: full=${normB.edges.length}, incr=${normC.edges.length}`);
  process.exit(1);
} else {
  console.log(`\nPASS: Graphs are equivalent (${normB.nodes.length} nodes, ${normB.edges.length} edges)`);
}

await fs.rm(tmpDir, { recursive: true, force: true });

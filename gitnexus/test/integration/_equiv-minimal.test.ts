import { describe, it, expect, beforeAll, afterAll } from 'vitest';
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

describe('minimal lbug test', () => {
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-min-'));
  });

  afterAll(async () => {
    await closeLbug();
    try { await fs.rm(tmpDir, { recursive: true, force: true }); } catch {}
  });

  it('three open+close cycles with pipeline and loadGraph', async () => {
    const repoDir = path.join(tmpDir, 'repo');
    const srcDir = path.join(repoDir, 'src');
    await fs.mkdir(srcDir, { recursive: true });
    await fs.writeFile(path.join(srcDir, 'a.ts'), 'export function greet() { return "hi"; }');
    await fs.writeFile(path.join(srcDir, 'b.ts'), 'import { greet } from "./a"; export const msg = greet();');
    execSync('git init && git add -A && git commit -m init', {
      cwd: repoDir,
      stdio: 'pipe',
      env: { ...process.env, GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 't@t' },
    });

    const result = await runPipelineFromRepo(repoDir, () => {});
    expect(result.graph.nodeCount).toBeGreaterThan(0);

    // Cycle 1
    const dbA = path.join(tmpDir, 'testdb-a');
    await initLbug(dbA);
    await loadGraphToLbug(result.graph, repoDir, tmpDir, () => {});
    await checkpointLbug();
    const rows1 = await executeQuery('MATCH (n) RETURN count(n) as cnt');
    expect(rows1[0].cnt).toBeGreaterThan(0);
    await closeLbug();

    // Cycle 2
    const dbB = path.join(tmpDir, 'testdb-b');
    await initLbug(dbB);
    await loadGraphToLbug(result.graph, repoDir, tmpDir, () => {});
    await checkpointLbug();
    const rows2 = await executeQuery('MATCH (n) RETURN count(n) as cnt');
    expect(rows2[0].cnt).toBeGreaterThan(0);
    await closeLbug();

    // Cycle 3 (reopen A, delete, re-insert)
    await initLbug(dbA);
    await deleteNodesByFilePath(['src/a.ts']);
    await checkpointLbug();
    await closeLbug();
    await initLbug(dbA);
    await loadGraphToLbug(result.graph, repoDir, tmpDir, () => {});
    await checkpointLbug();
    const rows3 = await executeQuery('MATCH (n) RETURN count(n) as cnt');
    expect(rows3[0].cnt).toBeGreaterThan(0);
    await closeLbug();
  }, 60000);
});

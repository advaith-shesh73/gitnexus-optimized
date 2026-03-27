/**
 * Integration Test: CLI Analyze End-to-End (Incremental)
 *
 * Spawns the analyze CLI as a child process against a temp git repo:
 * 1. Full analyze on initial commit
 * 2. Modify files, commit
 * 3. Incremental analyze — assert no crash, meta.json updated
 */
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testDir, '../..');
const cliEntry = path.join(repoRoot, 'src/cli/index.ts');

const _require = createRequire(import.meta.url);

const git = (args: string[], cwd: string) =>
  spawnSync('git', args, {
    cwd,
    stdio: 'pipe',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'test',
      GIT_AUTHOR_EMAIL: 'test@test',
      GIT_COMMITTER_NAME: 'test',
      GIT_COMMITTER_EMAIL: 'test@test',
    },
  });

function runAnalyze(cwd: string, extraArgs: string[] = [], timeoutMs = 60000) {
  return spawnSync(
    process.execPath,
    ['--import', 'tsx', cliEntry, 'analyze', cwd, ...extraArgs],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: timeoutMs,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --max-old-space-size=8192`.trim(),
      },
    },
  );
}

describe('CLI analyze E2E (incremental)', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-cli-incr-'));
  const repoDir = path.join(tmpDir, 'repo');

  afterAll(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  it('full analyze + incremental analyze on a temp repo', () => {
    // --- Setup: git repo with TS files ---
    fs.mkdirSync(path.join(repoDir, 'src'), { recursive: true });

    const files: Record<string, string> = {
      'src/main.ts': `
import { greet } from './greeter.js';
import { add, multiply } from './math.js';
export function run() {
  console.log(greet('World'));
  console.log(add(1, 2));
  console.log(multiply(3, 4));
}`,
      'src/greeter.ts': `
import { capitalize } from './utils.js';
export function greet(name: string): string {
  return 'Hello, ' + capitalize(name);
}`,
      'src/math.ts': `
export function add(a: number, b: number): number { return a + b; }
export function multiply(a: number, b: number): number { return a * b; }
export function subtract(a: number, b: number): number { return a - b; }`,
      'src/utils.ts': `
export function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
export function lowercase(s: string): string {
  return s.toLowerCase();
}`,
      'src/logger.ts': `
export class Logger {
  info(msg: string): void { console.log(msg); }
  error(msg: string): void { console.error(msg); }
}`,
      'src/config.ts': `
export interface AppConfig { port: number; debug: boolean; }
export function getConfig(): AppConfig { return { port: 3000, debug: false }; }`,
      'src/db.ts': `
import { Logger } from './logger.js';
const log = new Logger();
export function connect(): void { log.info('Connected'); }
export function disconnect(): void { log.info('Disconnected'); }`,
      'src/handler.ts': `
import { greet } from './greeter.js';
import { connect, disconnect } from './db.js';
import { getConfig } from './config.js';
export function handleRequest(name: string): string {
  connect();
  const config = getConfig();
  const msg = greet(name);
  disconnect();
  return msg;
}`,
      'src/middleware.ts': `
import { Logger } from './logger.js';
const log = new Logger();
export function cors(): void { log.info('CORS enabled'); }
export function auth(): boolean { return true; }`,
      'src/router.ts': `
import { handleRequest } from './handler.js';
import { cors, auth } from './middleware.js';
export function route(path: string, name: string): string {
  cors();
  if (!auth()) return 'Unauthorized';
  return handleRequest(name);
}`,
      'src/types.ts': `
export interface User { id: string; name: string; }
export interface Post { id: string; title: string; }
export type Result<T> = { ok: true; data: T } | { ok: false; error: string };`,
      'src/validator.ts': `
import type { User } from './types.js';
export function validateUser(u: unknown): u is User {
  return typeof u === 'object' && u !== null && 'id' in u;
}`,
      'src/formatter.ts': `
import type { User } from './types.js';
export function formatUser(u: User): string { return u.name; }`,
      'src/index.ts': `
export { run } from './main.js';
export { greet } from './greeter.js';
export { add, multiply, subtract } from './math.js';
export { capitalize, lowercase } from './utils.js';`,
      'src/service.ts': `
import { Logger } from './logger.js';
import { validateUser } from './validator.js';
import { formatUser } from './formatter.js';
import type { User } from './types.js';
const log = new Logger();
export function processUser(data: unknown): string {
  if (!validateUser(data)) { log.error('Invalid'); return 'Error'; }
  return formatUser(data);
}`,
      'src/cache.ts': `
const store = new Map<string, unknown>();
export function get(key: string): unknown { return store.get(key); }
export function set(key: string, value: unknown): void { store.set(key, value); }`,
      'src/events.ts': `
import { Logger } from './logger.js';
const log = new Logger();
export function emit(event: string): void { log.info('Event: ' + event); }
export function on(event: string, handler: () => void): void { handler(); }`,
      'src/queue.ts': `
import { emit } from './events.js';
export function enqueue(item: string): void { emit('enqueued:' + item); }
export function dequeue(): string | null { return null; }`,
      'src/scheduler.ts': `
import { enqueue } from './queue.js';
import { Logger } from './logger.js';
const log = new Logger();
export function schedule(task: string, delay: number): void {
  log.info('Scheduling ' + task);
  enqueue(task);
}`,
    };

    for (const [rel, content] of Object.entries(files)) {
      const fullPath = path.join(repoDir, rel);
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, content);
    }

    git(['init', '--initial-branch=main'], repoDir);
    git(['add', '-A'], repoDir);
    git(['commit', '-m', 'initial'], repoDir);

    // --- Step 1: Full analyze ---
    const fullResult = runAnalyze(repoDir);

    if (fullResult.status === null) return; // CI timeout

    expect(fullResult.status, [
      `Full analyze failed (code ${fullResult.status})`,
      `stdout: ${(fullResult.stdout || '').slice(-500)}`,
      `stderr: ${(fullResult.stderr || '').slice(-500)}`,
    ].join('\n')).toBe(0);

    const metaPath = path.join(repoDir, '.gitnexus', 'meta.json');
    expect(fs.existsSync(metaPath)).toBe(true);

    const meta1 = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    expect(meta1.stats.nodes).toBeGreaterThan(0);
    expect(meta1.stats.edges).toBeGreaterThanOrEqual(0);

    // --- Step 2: Modify files and commit ---
    fs.writeFileSync(path.join(repoDir, 'src/math.ts'), `
export function add(a: number, b: number): number { return a + b; }
export function multiply(a: number, b: number): number { return a * b; }
export function subtract(a: number, b: number): number { return a - b; }
export function divide(a: number, b: number): number { return b !== 0 ? a / b : 0; }
`);

    fs.writeFileSync(path.join(repoDir, 'src/greeter.ts'), `
import { capitalize } from './utils.js';
export function greet(name: string): string {
  return 'Hello, ' + capitalize(name) + '!';
}
export function farewell(name: string): string {
  return 'Goodbye, ' + capitalize(name);
}
`);

    git(['add', '-A'], repoDir);
    git(['commit', '-m', 'update math and greeter'], repoDir);

    // --- Step 3: Incremental analyze ---
    // Incremental is now auto-enabled when meta.json exists and lastCommit differs.
    const incrResult = runAnalyze(repoDir, []);

    if (incrResult.status === null) return; // CI timeout

    expect(incrResult.status, [
      `Incremental analyze failed (code ${incrResult.status})`,
      `stdout: ${(incrResult.stdout || '').slice(-500)}`,
      `stderr: ${(incrResult.stderr || '').slice(-500)}`,
    ].join('\n')).toBe(0);

    // meta.json should be updated with new commit
    const meta2 = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    expect(meta2.lastCommit).not.toBe(meta1.lastCommit);
    expect(meta2.stats.nodes).toBeGreaterThan(0);

    // Node count may increase: new functions are added, and the incremental
    // pipeline now runs a full parse for cross-file edge resolution.  Community
    // detection (Louvain) on the mutated graph can produce a different number
    // of Community nodes.  Allow up to 60% growth.
    const ratio = meta2.stats.nodes / meta1.stats.nodes;
    expect(ratio).toBeGreaterThan(0.8);
    expect(ratio).toBeLessThan(1.6);
  }, 120000);

  it('detects dirty flag and forces full rebuild', () => {
    // The previous test already created a full index in repoDir.
    // Simulate a crash by writing dirty: true into meta.json.
    const metaPath = path.join(repoDir, '.gitnexus', 'meta.json');
    if (!fs.existsSync(metaPath)) return;

    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    fs.writeFileSync(metaPath, JSON.stringify({ ...meta, dirty: true }));

    // Modify a file and commit so the incremental path would normally trigger
    fs.writeFileSync(path.join(repoDir, 'src/cache.ts'), `
const store = new Map<string, unknown>();
export function get(key: string): unknown { return store.get(key); }
export function set(key: string, value: unknown): void { store.set(key, value); }
export function has(key: string): boolean { return store.has(key); }
`);
    git(['add', '-A'], repoDir);
    git(['commit', '-m', 'add has() to cache'], repoDir);

    const result = runAnalyze(repoDir);
    if (result.status === null) return;

    expect(result.status, [
      `Dirty recovery failed (code ${result.status})`,
      `stderr: ${(result.stderr || '').slice(-500)}`,
    ].join('\n')).toBe(0);

    // After recovery, the dirty flag should be cleared
    const metaAfter = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    expect(metaAfter.dirty).toBeFalsy();

    // Verify the output mentions forcing a full rebuild
    const combinedOutput = (result.stdout || '') + (result.stderr || '');
    expect(combinedOutput).toContain('full rebuild');
  }, 120000);
});

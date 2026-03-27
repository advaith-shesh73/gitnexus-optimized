/**
 * Integration Test: Incremental Equivalence
 *
 * Proves that incremental reindex produces the same graph as full reindex.
 * This is the single most important test for the incremental pipeline.
 *
 * Architecture: Each DB phase runs in a separate subprocess via
 * _equiv-worker.mts to avoid LadybugDB N-API destructor crashes that
 * occur after 3+ open/close cycles in a single process (known macOS issue).
 *
 * Flow:
 * 1. Create temp git repo with TS files with cross-file imports
 * 2. Subprocess: Full pipeline → load to DB A → snapshot (baseline)
 * 3. Modify files (add, modify, delete), commit
 * 4. Subprocess: Full pipeline from scratch → load to DB B → snapshot (expected)
 * 5. Copy DB A → DB C
 * 6. Subprocess: Run incremental pipeline on DB C → snapshot (actual)
 * 7. Assert B deeply equals C (excluding non-deterministic Community/Process data)
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync, execFileSync } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

import type { ChangedFile } from '../../src/storage/git.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKER_SCRIPT = path.join(__dirname, '_equiv-worker.mts');

interface NodeSnapshot { id: string; label: string; name: string; filePath: string }
interface EdgeSnapshot { sourceId: string; targetId: string; type: string }
interface DBSnapshot { nodes: NodeSnapshot[]; edges: EdgeSnapshot[] }

// ═══════════════════════════════════════════════════════════════════════
// Subprocess runner — each DB phase gets its own process to avoid
// LadybugDB N-API destructor crashes from multiple open/close cycles.
// ═══════════════════════════════════════════════════════════════════════

function runWorker(args: Record<string, string>): DBSnapshot {
  const env = { ...process.env, ...args };
  let stdout: string;
  try {
    stdout = execFileSync(
      process.execPath,
      ['--import', 'tsx', WORKER_SCRIPT],
      { env, encoding: 'utf8', timeout: 60000, stdio: ['pipe', 'pipe', 'pipe'] },
    );
  } catch (err: any) {
    // LadybugDB N-API destructors segfault at process exit on macOS.
    // The worker prints valid JSON before the crash — extract it from stdout.
    if (err.signal === 'SIGSEGV' && err.stdout) {
      stdout = err.stdout;
    } else {
      throw err;
    }
  }
  const lines = stdout.trim().split('\n');
  const jsonLine = lines[lines.length - 1];
  return JSON.parse(jsonLine) as DBSnapshot;
}

// ═══════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════

const git = (cmd: string, cwd: string) =>
  execSync(`git ${cmd}`, {
    cwd,
    stdio: 'pipe',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'test',
      GIT_AUTHOR_EMAIL: 'test@test',
      GIT_COMMITTER_NAME: 'test',
      GIT_COMMITTER_EMAIL: 'test@test',
    },
  }).toString().trim();

async function writeFile(dir: string, relPath: string, content: string) {
  const fullPath = path.join(dir, relPath);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, content);
}

function normalizeSnapshot(snap: DBSnapshot, repoPath: string): DBSnapshot {
  const prefix = repoPath.endsWith('/') ? repoPath : repoPath + '/';
  const strip = (s: string) => s.replace(prefix, '');
  return {
    nodes: snap.nodes.map(n => ({
      ...n,
      id: strip(n.id),
      filePath: strip(n.filePath),
    })),
    edges: snap.edges.map(e => ({
      ...e,
      sourceId: strip(e.sourceId),
      targetId: strip(e.targetId),
    })),
  };
}

// ═══════════════════════════════════════════════════════════════════════
// Fixture generation
// ═══════════════════════════════════════════════════════════════════════

async function generateFixtureRepo(dir: string) {
  const files: Array<{ path: string; content: string }> = [];

  files.push({ path: 'src/types.ts', content: `
export interface User { id: string; name: string; email: string; }
export interface Post { id: string; title: string; authorId: string; }
export type Result<T> = { ok: true; data: T } | { ok: false; error: string };
` });

  files.push({ path: 'src/utils/logger.ts', content: `
export class Logger {
  private prefix: string;
  constructor(prefix: string) { this.prefix = prefix; }
  info(msg: string): void { console.log(\`[\${this.prefix}] \${msg}\`); }
  error(msg: string): void { console.error(\`[\${this.prefix}] ERROR: \${msg}\`); }
}
export const createLogger = (prefix: string) => new Logger(prefix);
` });

  files.push({ path: 'src/utils/validator.ts', content: `
import type { User, Post } from '../types.js';
export function validateUser(u: unknown): u is User {
  return typeof u === 'object' && u !== null && 'id' in u && 'name' in u;
}
export function validatePost(p: unknown): p is Post {
  return typeof p === 'object' && p !== null && 'id' in p && 'title' in p;
}
export function validateEmail(email: string): boolean {
  return /^[^@]+@[^@]+$/.test(email);
}
` });

  files.push({ path: 'src/utils/formatter.ts', content: `
import type { User, Post } from '../types.js';
export function formatUser(u: User): string { return \`\${u.name} <\${u.email}>\`; }
export function formatPost(p: Post): string { return \`[\${p.id}] \${p.title}\`; }
export function formatDate(d: Date): string { return d.toISOString(); }
` });

  files.push({ path: 'src/utils/crypto.ts', content: `
export function hashString(s: string): string { return Buffer.from(s).toString('base64'); }
export function generateId(): string { return Math.random().toString(36).slice(2); }
` });

  files.push({ path: 'src/utils/index.ts', content: `
export { Logger, createLogger } from './logger.js';
export { validateUser, validatePost, validateEmail } from './validator.js';
export { formatUser, formatPost, formatDate } from './formatter.js';
export { hashString, generateId } from './crypto.js';
` });

  files.push({ path: 'src/data/database.ts', content: `
import { createLogger } from '../utils/logger.js';
const log = createLogger('db');
export class Database {
  private connected = false;
  async connect(): Promise<void> { this.connected = true; log.info('Connected'); }
  async disconnect(): Promise<void> { this.connected = false; log.info('Disconnected'); }
  isConnected(): boolean { return this.connected; }
}
export const db = new Database();
` });

  files.push({ path: 'src/data/user-repo.ts', content: `
import type { User, Result } from '../types.js';
import { db } from './database.js';
import { generateId } from '../utils/crypto.js';
export async function findUser(id: string): Promise<Result<User>> {
  if (!db.isConnected()) return { ok: false, error: 'Not connected' };
  return { ok: true, data: { id, name: 'Test', email: 'test@test.com' } };
}
export async function createUser(name: string, email: string): Promise<User> {
  return { id: generateId(), name, email };
}
` });

  files.push({ path: 'src/data/post-repo.ts', content: `
import type { Post, Result } from '../types.js';
import { db } from './database.js';
import { generateId } from '../utils/crypto.js';
import { validatePost } from '../utils/validator.js';
export async function findPost(id: string): Promise<Result<Post>> {
  if (!db.isConnected()) return { ok: false, error: 'Not connected' };
  return { ok: true, data: { id, title: 'Test', authorId: '1' } };
}
export async function createPost(title: string, authorId: string): Promise<Post | null> {
  const post = { id: generateId(), title, authorId };
  return validatePost(post) ? post : null;
}
` });

  files.push({ path: 'src/services/auth-service.ts', content: `
import type { User, Result } from '../types.js';
import { findUser } from '../data/user-repo.js';
import { hashString, compareHash } from '../utils/crypto.js';
import { validateEmail } from '../utils/validator.js';
import { createLogger } from '../utils/logger.js';
const log = createLogger('auth');
export async function authenticate(email: string, password: string): Promise<Result<User>> {
  if (!validateEmail(email)) return { ok: false, error: 'Invalid email' };
  log.info(\`Auth attempt: \${email}\`);
  const hash = hashString(password);
  return findUser(hash);
}
` });

  files.push({ path: 'src/services/user-service.ts', content: `
import type { User, Result } from '../types.js';
import { findUser, createUser } from '../data/user-repo.js';
import { formatUser } from '../utils/formatter.js';
import { validateUser, validateEmail } from '../utils/validator.js';
import { createLogger } from '../utils/logger.js';
const log = createLogger('user');
export async function getUser(id: string): Promise<Result<User>> {
  const result = await findUser(id);
  if (result.ok) log.info(\`Found: \${formatUser(result.data)}\`);
  return result;
}
export async function registerUser(name: string, email: string): Promise<Result<User>> {
  if (!validateEmail(email)) return { ok: false, error: 'Invalid email' };
  const user = await createUser(name, email);
  log.info(\`Registered: \${formatUser(user)}\`);
  return { ok: true, data: user };
}
` });

  files.push({ path: 'src/services/post-service.ts', content: `
import type { Post, Result } from '../types.js';
import { findPost, createPost } from '../data/post-repo.js';
import { formatPost } from '../utils/formatter.js';
import { validatePost } from '../utils/validator.js';
import { createLogger } from '../utils/logger.js';
const log = createLogger('post');
export async function getPost(id: string): Promise<Result<Post>> {
  const result = await findPost(id);
  if (result.ok) log.info(\`Found: \${formatPost(result.data)}\`);
  return result;
}
` });

  files.push({ path: 'src/services/search-service.ts', content: `
import { findUser } from '../data/user-repo.js';
import { findPost } from '../data/post-repo.js';
import { formatUser, formatPost } from '../utils/formatter.js';
import { createLogger } from '../utils/logger.js';
const log = createLogger('search');
export async function search(query: string) {
  log.info(\`Searching: \${query}\`);
  const user = await findUser(query);
  const post = await findPost(query);
  return { user: user.ok ? formatUser(user.data) : null, post: post.ok ? formatPost(post.data) : null };
}
` });

  files.push({ path: 'src/services/analytics-service.ts', content: `
import { createLogger } from '../utils/logger.js';
const log = createLogger('analytics');
export function trackEvent(event: string, data: Record<string, string>) {
  log.info(\`Event: \${event} \${JSON.stringify(data)}\`);
}
export function trackPageView(page: string) { trackEvent('pageview', { page }); }
` });

  files.push({ path: 'src/api/user-handler.ts', content: `
import { getUser, registerUser } from '../services/user-service.js';
import { createLogger } from '../utils/logger.js';
const log = createLogger('user-handler');
export async function handleGetUser(id: string) {
  log.info(\`GET /users/\${id}\`);
  return getUser(id);
}
export async function handleCreateUser(name: string, email: string) {
  return registerUser(name, email);
}
` });

  files.push({ path: 'src/api/post-handler.ts', content: `
import { getPost } from '../services/post-service.js';
export async function handleGetPost(id: string) { return getPost(id); }
export async function handleCreatePost(title: string, authorId: string) { return { title, authorId }; }
` });

  files.push({ path: 'src/api/auth-handler.ts', content: `
import { authenticate } from '../services/auth-service.js';
export async function handleLogin(email: string, password: string) {
  return authenticate(email, password);
}
` });

  files.push({ path: 'src/middleware/cors.ts', content: `
export function corsMiddleware(origin: string) { return { 'Access-Control-Allow-Origin': origin }; }
` });

  files.push({ path: 'src/middleware/rate-limiter.ts', content: `
const requests = new Map<string, number>();
export function checkRateLimit(ip: string, max: number): boolean {
  const count = (requests.get(ip) ?? 0) + 1;
  requests.set(ip, count);
  return count <= max;
}
` });

  files.push({ path: 'src/middleware/error-handler.ts', content: `
import { createLogger } from '../utils/logger.js';
const log = createLogger('error');
export function handleError(err: Error) { log.error(err.message); return { status: 500, body: 'Internal Error' }; }
` });

  files.push({ path: 'src/router.ts', content: `
import { handleGetUser, handleCreateUser } from './api/user-handler.js';
import { handleGetPost, handleCreatePost } from './api/post-handler.js';
import { handleLogin } from './api/auth-handler.js';
import { trackPageView } from './services/analytics-service.js';
import { corsMiddleware } from './middleware/cors.js';
import { checkRateLimit } from './middleware/rate-limiter.js';
import { handleError } from './middleware/error-handler.js';
export type Route = { method: string; path: string; handler: Function };
export const routes: Route[] = [
  { method: 'GET', path: '/users/:id', handler: handleGetUser },
  { method: 'POST', path: '/users', handler: handleCreateUser },
  { method: 'GET', path: '/posts/:id', handler: handleGetPost },
  { method: 'POST', path: '/posts', handler: handleCreatePost },
  { method: 'POST', path: '/login', handler: handleLogin },
];
export function processRequest(route: Route, ip: string) {
  trackPageView(route.path);
  const cors = corsMiddleware('*');
  if (!checkRateLimit(ip, 100)) return { status: 429, body: 'Too Many Requests' };
  return cors;
}
` });

  files.push({ path: 'src/index.ts', content: `
import { db } from './data/database.js';
import { routes, processRequest } from './router.js';
import { createLogger } from './utils/logger.js';
const log = createLogger('main');
export async function start() {
  await db.connect();
  log.info(\`Loaded \${routes.length} routes\`);
}
` });

  for (const f of files) {
    await writeFile(dir, f.path, f.content);
  }
}

/**
 * Apply modifications: add cache-service, modify validator/formatter/router,
 * delete analytics-service.
 */
async function applyModifications(dir: string) {
  await writeFile(dir, 'src/services/cache-service.ts', `
import { createLogger } from '../utils/logger.js';
const log = createLogger('cache');
const store = new Map<string, { data: any; expires: number }>();
export function cacheGet(key: string): any | undefined {
  const entry = store.get(key);
  if (!entry || entry.expires < Date.now()) { store.delete(key); return undefined; }
  log.info(\`Cache hit: \${key}\`);
  return entry.data;
}
export function cacheSet(key: string, data: any, ttlMs = 60000): void {
  store.set(key, { data, expires: Date.now() + ttlMs });
}
`);

  await writeFile(dir, 'src/services/user-service.ts', `
import type { User, Result } from '../types.js';
import { findUser, createUser } from '../data/user-repo.js';
import { formatUser } from '../utils/formatter.js';
import { validateUser, validateEmail } from '../utils/validator.js';
import { cacheGet, cacheSet } from './cache-service.js';
import { createLogger } from '../utils/logger.js';
const log = createLogger('user');
export async function getUser(id: string): Promise<Result<User>> {
  const cached = cacheGet(\`user:\${id}\`);
  if (cached) return { ok: true, data: cached };
  const result = await findUser(id);
  if (result.ok) {
    cacheSet(\`user:\${result.data.id}\`, result.data);
    log.info(\`Found: \${formatUser(result.data)}\`);
  }
  return result;
}
export async function registerUser(name: string, email: string): Promise<Result<User>> {
  if (!validateEmail(email)) return { ok: false, error: 'Invalid email' };
  const user = await createUser(name, email);
  cacheSet(\`user:\${user.id}\`, user);
  log.info(\`Registered: \${formatUser(user)}\`);
  return { ok: true, data: user };
}
`);

  await writeFile(dir, 'src/utils/validator.ts', `
import type { User, Post } from '../types.js';
export function validateUser(u: unknown): u is User {
  return typeof u === 'object' && u !== null && 'id' in u && 'name' in u && 'email' in u;
}
export function validatePost(p: unknown): p is Post {
  return typeof p === 'object' && p !== null && 'id' in p && 'title' in p && 'authorId' in p;
}
export function validateEmail(email: string): boolean {
  return /^[^@]+@[^@]+\\.[^@]+$/.test(email);
}
export function sanitizeInput(s: string): string { return s.replace(/[<>]/g, ''); }
`);

  await writeFile(dir, 'src/utils/formatter.ts', `
import type { User, Post } from '../types.js';
export function formatUser(u: User): string { return \`\${u.name} <\${u.email}>\`; }
export function formatPost(p: Post): string { return \`[\${p.id}] \${p.title}\`; }
export function formatDate(d: Date): string { return d.toISOString(); }
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return bytes + 'B';
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + 'KB';
  return (bytes / 1048576).toFixed(1) + 'MB';
}
`);

  await fs.rm(path.join(dir, 'src/services/analytics-service.ts'));

  await writeFile(dir, 'src/router.ts', `
import { handleGetUser, handleCreateUser } from './api/user-handler.js';
import { handleGetPost, handleCreatePost } from './api/post-handler.js';
import { handleLogin } from './api/auth-handler.js';
import { corsMiddleware } from './middleware/cors.js';
import { checkRateLimit } from './middleware/rate-limiter.js';
import { handleError } from './middleware/error-handler.js';
export type Route = { method: string; path: string; handler: Function };
export const routes: Route[] = [
  { method: 'GET', path: '/users/:id', handler: handleGetUser },
  { method: 'POST', path: '/users', handler: handleCreateUser },
  { method: 'GET', path: '/posts/:id', handler: handleGetPost },
  { method: 'POST', path: '/posts', handler: handleCreatePost },
  { method: 'POST', path: '/login', handler: handleLogin },
];
export function processRequest(route: Route, ip: string) {
  const cors = corsMiddleware('*');
  if (!checkRateLimit(ip, 100)) return { status: 429, body: 'Too Many Requests' };
  return cors;
}
`);
}

// ═══════════════════════════════════════════════════════════════════════
// Test suite
// ═══════════════════════════════════════════════════════════════════════

describe('incremental equivalence', () => {
  let tmpDir: string;
  let repoDir: string;

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-equiv-'));
    repoDir = path.join(tmpDir, 'repo');
    await fs.mkdir(repoDir, { recursive: true });
  }, 10000);

  afterAll(async () => {
    try { await fs.rm(tmpDir, { recursive: true, force: true }); } catch {}
  }, 30000);

  it('incremental reindex produces the same graph as full rebuild', async () => {
    // --- Step 1: Create git repo with initial files ---
    git('init --initial-branch=main', repoDir);
    await generateFixtureRepo(repoDir);
    git('add -A', repoDir);
    git('commit -m "initial commit"', repoDir);

    const initialCommit = git('rev-parse HEAD', repoDir);

    // --- Step 2: Full pipeline → snapshot A (baseline) ---
    const storageA = path.join(tmpDir, 'storage-a');
    const dbA = path.join(storageA, 'lbug');
    await fs.mkdir(storageA, { recursive: true });
    const snapA = runWorker({
      EQUIV_MODE: 'full-rebuild',
      EQUIV_REPO: repoDir,
      EQUIV_DB: dbA,
      EQUIV_STORAGE: storageA,
    });

    expect(snapA.nodes.length).toBeGreaterThan(20);
    expect(snapA.edges.length).toBeGreaterThan(10);

    // --- Step 3: Apply modifications and commit ---
    await applyModifications(repoDir);
    git('add -A', repoDir);
    git('commit -m "modifications"', repoDir);

    const modifiedCommit = git('rev-parse HEAD', repoDir);

    const diffOutput = execSync(
      `git diff --name-status ${initialCommit} ${modifiedCommit}`,
      { cwd: repoDir, encoding: 'utf8' },
    ).trim();
    const changedFiles: ChangedFile[] = diffOutput.split('\n').filter(Boolean).map(line => {
      const parts = line.split('\t');
      const status = parts[0] as ChangedFile['status'];
      if (status === 'R' || status.startsWith('R')) {
        return { status: 'R' as const, oldPath: parts[1], path: parts[2] };
      }
      return { status, path: parts[1] };
    });

    // --- Step 4: Full rebuild from scratch → snapshot B (expected) ---
    const storageB = path.join(tmpDir, 'storage-b');
    const dbB = path.join(storageB, 'lbug');
    await fs.mkdir(storageB, { recursive: true });
    const snapB = runWorker({
      EQUIV_MODE: 'full-rebuild',
      EQUIV_REPO: repoDir,
      EQUIV_DB: dbB,
      EQUIV_STORAGE: storageB,
    });

    // --- Step 5: Copy DB A → DB C, run incremental → snapshot C (actual) ---
    const storageC = path.join(tmpDir, 'storage-c');
    const dbC = path.join(storageC, 'lbug');
    await fs.mkdir(storageC, { recursive: true });
    await fs.copyFile(dbA, dbC);
    try { await fs.copyFile(dbA + '.wal', dbC + '.wal'); } catch {}

    const snapC = runWorker({
      EQUIV_MODE: 'incremental',
      EQUIV_REPO: repoDir,
      EQUIV_DB: dbC,
      EQUIV_STORAGE: storageC,
      EQUIV_CHANGED: JSON.stringify(changedFiles),
    });

    // --- Step 6: Compare B and C ---
    const normB = normalizeSnapshot(snapB, repoDir);
    const normC = normalizeSnapshot(snapC, repoDir);

    const nodeIdsB = new Set(normB.nodes.map(n => n.id));
    const nodeIdsC = new Set(normC.nodes.map(n => n.id));

    const onlyInFull = normB.nodes.filter(n => !nodeIdsC.has(n.id));
    const onlyInIncr = normC.nodes.filter(n => !nodeIdsB.has(n.id));

    if (onlyInFull.length > 0 || onlyInIncr.length > 0) {
      const msg = [
        `Node mismatch: full=${normB.nodes.length}, incremental=${normC.nodes.length}`,
        onlyInFull.length > 0 ? `  Only in full: ${onlyInFull.map(n => `${n.label}:${n.name}`).join(', ')}` : '',
        onlyInIncr.length > 0 ? `  Only in incremental: ${onlyInIncr.map(n => `${n.label}:${n.name}`).join(', ')}` : '',
      ].filter(Boolean).join('\n');
      expect.soft(onlyInFull.length, msg).toBe(0);
      expect.soft(onlyInIncr.length, msg).toBe(0);
    }

    const edgeKeyB = new Set(normB.edges.map(e => `${e.sourceId}|${e.targetId}|${e.type}`));
    const edgeKeyC = new Set(normC.edges.map(e => `${e.sourceId}|${e.targetId}|${e.type}`));

    const edgesOnlyInFull = normB.edges.filter(e => !edgeKeyC.has(`${e.sourceId}|${e.targetId}|${e.type}`));
    const edgesOnlyInIncr = normC.edges.filter(e => !edgeKeyB.has(`${e.sourceId}|${e.targetId}|${e.type}`));

    if (edgesOnlyInFull.length > 0 || edgesOnlyInIncr.length > 0) {
      const msg = [
        `Edge mismatch: full=${normB.edges.length}, incremental=${normC.edges.length}`,
        edgesOnlyInFull.length > 0 ? `  Only in full (first 10): ${edgesOnlyInFull.slice(0, 10).map(e => `${e.type}:${e.sourceId}->${e.targetId}`).join(', ')}` : '',
        edgesOnlyInIncr.length > 0 ? `  Only in incremental (first 10): ${edgesOnlyInIncr.slice(0, 10).map(e => `${e.type}:${e.sourceId}->${e.targetId}`).join(', ')}` : '',
      ].filter(Boolean).join('\n');
      expect.soft(edgesOnlyInFull.length, msg).toBe(0);
      expect.soft(edgesOnlyInIncr.length, msg).toBe(0);
    }

    expect(normC.nodes.length).toBe(normB.nodes.length);
    expect(normC.edges.length).toBe(normB.edges.length);
  }, 120000);
});

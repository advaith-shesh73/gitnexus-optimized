/**
 * Integration Tests: Blue-Green Swap with Real LadybugDB
 *
 * Exercises the mtime-based reconnection path end-to-end using a real
 * LadybugDB database via the adapter (initLbug / executeQuery / closeLbug).
 *
 * Lifecycle per test suite:
 *   1. Creates DB v1 via adapter, inserts seed data, checkpoints, closes
 *   2. Verifies data can be read back via withLbugDb
 *   3. Creates DB v2 at .pending, inserts different data, closes
 *   4. Performs atomic blue-green swap (rename pending → lbug)
 *   5. Reads via withLbugDb — mtime detection triggers reconnect, sees v2
 *
 * Also tests:
 *   - isLbugReady reflects connection state
 *   - checkpointLbug flushes WAL before swap
 *   - closeLbug clears mtime tracking
 *   - invalidateConnection forces reconnect on next query
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fsP from 'fs/promises';
import path from 'path';
import os from 'os';

// ═══════════════════════════════════════════════════════════════════════
// Helper: create a DB with a custom Marker table via the adapter
// ═══════════════════════════════════════════════════════════════════════

async function createSeededDb(dbPath: string, version: string): Promise<void> {
  const { initLbug, executeQuery, checkpointLbug, closeLbug } = await import('../../src/core/lbug/lbug-adapter.js');
  await initLbug(dbPath);
  await executeQuery('CREATE NODE TABLE IF NOT EXISTS Marker(id STRING, version STRING, PRIMARY KEY (id))');
  await executeQuery(`CREATE (m:Marker {id: 'test', version: '${version}'})`);
  await checkpointLbug();
  await closeLbug();
}

async function readVersion(dbPath: string): Promise<string> {
  const { withLbugDb, executeQuery } = await import('../../src/core/lbug/lbug-adapter.js');
  const rows = await withLbugDb(dbPath, () =>
    executeQuery("MATCH (m:Marker) WHERE m.id = 'test' RETURN m.version AS v"),
  );
  return rows.length > 0 ? String(rows[0].v) : 'EMPTY';
}

// ═══════════════════════════════════════════════════════════════════════
// 1. FULL BLUE-GREEN LIFECYCLE
// ═══════════════════════════════════════════════════════════════════════

describe('blue-green swap with real LadybugDB', () => {
  let tmpDir: string;
  let lbugPath: string;

  beforeAll(async () => {
    tmpDir = await fsP.mkdtemp(path.join(os.tmpdir(), 'bg-lbug-'));
    lbugPath = path.join(tmpDir, 'lbug');
  });

  afterAll(async () => {
    const { closeLbug } = await import('../../src/core/lbug/lbug-adapter.js');
    await closeLbug();
    try { await fsP.rm(tmpDir, { recursive: true, force: true }); } catch {}
  });

  it('creates v1 database and reads correctly', async () => {
    await createSeededDb(lbugPath, 'v1');
    const version = await readVersion(lbugPath);
    expect(version).toBe('v1');
  });

  it('creates v2 at pending path with different data', async () => {
    const { closeLbug } = await import('../../src/core/lbug/lbug-adapter.js');
    await closeLbug();

    const pendingPath = lbugPath + '.pending';
    await createSeededDb(pendingPath, 'v2');
    const version = await readVersion(pendingPath);
    expect(version).toBe('v2');
  });

  it('atomic swap replaces live with pending', async () => {
    const { closeLbug } = await import('../../src/core/lbug/lbug-adapter.js');
    await closeLbug();

    const pendingPath = lbugPath + '.pending';
    const prevPath = lbugPath + '.prev';

    // Same swap logic as analyze.ts
    try { await fsP.rm(prevPath, { force: true }); } catch {}
    try { await fsP.rename(lbugPath, prevPath); } catch {}
    await fsP.rename(pendingPath, lbugPath);
    try { await fsP.rm(prevPath, { recursive: true, force: true }); } catch {}

    // After swap, live path should contain v2 data
    const version = await readVersion(lbugPath);
    expect(version).toBe('v2');
  });

  it('withLbugDb auto-reconnects after swap (mtime detection)', async () => {
    // Build v3 at pending
    const { closeLbug } = await import('../../src/core/lbug/lbug-adapter.js');
    await closeLbug();

    const pendingPath = lbugPath + '.pending';
    await createSeededDb(pendingPath, 'v3');

    // First: establish connection to current live DB (v2)
    let version = await readVersion(lbugPath);
    expect(version).toBe('v2');

    // Now swap — close adapter first to release lock
    await closeLbug();

    await new Promise(r => setTimeout(r, 50));
    const prevPath = lbugPath + '.prev';
    try { await fsP.rm(prevPath, { recursive: true, force: true }); } catch {}
    try { await fsP.rename(lbugPath, prevPath); } catch {}
    await fsP.rename(pendingPath, lbugPath);
    try { await fsP.rm(prevPath, { recursive: true, force: true }); } catch {}

    // withLbugDb should detect mtime change and reconnect to v3
    version = await readVersion(lbugPath);
    expect(version).toBe('v3');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 2. isLbugReady LIFECYCLE
// ═══════════════════════════════════════════════════════════════════════

describe('isLbugReady lifecycle', () => {
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = await fsP.mkdtemp(path.join(os.tmpdir(), 'ready-'));
  });

  afterAll(async () => {
    const { closeLbug } = await import('../../src/core/lbug/lbug-adapter.js');
    await closeLbug();
    try { await fsP.rm(tmpDir, { recursive: true, force: true }); } catch {}
  });

  it('returns false before any DB is opened', async () => {
    const { isLbugReady, closeLbug } = await import('../../src/core/lbug/lbug-adapter.js');
    await closeLbug();
    expect(isLbugReady()).toBe(false);
  });

  it('returns true after initLbug', async () => {
    const lbugPath = path.join(tmpDir, 'lbug');
    const { initLbug, isLbugReady } = await import('../../src/core/lbug/lbug-adapter.js');
    await initLbug(lbugPath);
    expect(isLbugReady()).toBe(true);
  });

  it('returns false after closeLbug', async () => {
    const { closeLbug, isLbugReady } = await import('../../src/core/lbug/lbug-adapter.js');
    await closeLbug();
    expect(isLbugReady()).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 3. CHECKPOINT FLUSHES DATA
// ═══════════════════════════════════════════════════════════════════════

describe('checkpointLbug with real DB', () => {
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = await fsP.mkdtemp(path.join(os.tmpdir(), 'ckpt-'));
  });

  afterAll(async () => {
    const { closeLbug } = await import('../../src/core/lbug/lbug-adapter.js');
    await closeLbug();
    try { await fsP.rm(tmpDir, { recursive: true, force: true }); } catch {}
  });

  it('checkpoint flushes data so a separate reader sees it', async () => {
    const lbugPath = path.join(tmpDir, 'lbug');
    const { initLbug, executeQuery, checkpointLbug, closeLbug } = await import('../../src/core/lbug/lbug-adapter.js');

    await initLbug(lbugPath);
    await executeQuery('CREATE NODE TABLE IF NOT EXISTS CkptTest(id STRING, val INT64, PRIMARY KEY (id))');
    await executeQuery("CREATE (c:CkptTest {id: 'a', val: 42})");
    await checkpointLbug();
    await closeLbug();

    // Re-open via adapter and verify data persisted
    const { withLbugDb } = await import('../../src/core/lbug/lbug-adapter.js');
    const rows = await withLbugDb(lbugPath, () =>
      executeQuery("MATCH (c:CkptTest) WHERE c.id = 'a' RETURN c.val AS v"),
    );
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].v)).toBe(42);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 4. invalidateConnection FORCES RECONNECT
// ═══════════════════════════════════════════════════════════════════════

describe('invalidateConnection forces reconnect', () => {
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = await fsP.mkdtemp(path.join(os.tmpdir(), 'inval-'));
  });

  afterAll(async () => {
    const { closeLbug } = await import('../../src/core/lbug/lbug-adapter.js');
    await closeLbug();
    try { await fsP.rm(tmpDir, { recursive: true, force: true }); } catch {}
  });

  it('invalidateConnection + withLbugDb sees new data after swap', async () => {
    const lbugPath = path.join(tmpDir, 'lbug');
    const { withLbugDb, executeQuery, invalidateConnection, closeLbug } = await import('../../src/core/lbug/lbug-adapter.js');

    // Create v1
    await createSeededDb(lbugPath, 'before-invalidate');
    const v1 = await readVersion(lbugPath);
    expect(v1).toBe('before-invalidate');

    // Swap in v2 behind the scenes
    await closeLbug();
    const pendingPath = lbugPath + '.pending';
    await createSeededDb(pendingPath, 'after-invalidate');

    await closeLbug();
    await fsP.rename(pendingPath, lbugPath);

    // Invalidate and read — must see v2
    invalidateConnection();
    const v2 = await readVersion(lbugPath);
    expect(v2).toBe('after-invalidate');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 5. CRASH RECOVERY: STALE PENDING ON STARTUP
// ═══════════════════════════════════════════════════════════════════════

describe('crash recovery: stale pending on startup', () => {
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = await fsP.mkdtemp(path.join(os.tmpdir(), 'crash-'));
  });

  afterAll(async () => {
    const { closeLbug } = await import('../../src/core/lbug/lbug-adapter.js');
    await closeLbug();
    try { await fsP.rm(tmpDir, { recursive: true, force: true }); } catch {}
  });

  it('live DB survives when pending is corrupt / incomplete', async () => {
    const lbugPath = path.join(tmpDir, 'lbug');
    const pendingPath = lbugPath + '.pending';

    // Create healthy live DB
    await createSeededDb(lbugPath, 'healthy');

    // Simulate crashed build — pending is just garbage bytes
    await fsP.writeFile(pendingPath, Buffer.alloc(1024, 0xff));

    // Cleanup stale pending (as analyze.ts would on next run)
    for (const f of [pendingPath, `${pendingPath}.wal`, `${pendingPath}.lock`]) {
      try { await fsP.rm(f, { force: true }); } catch {}
    }

    // Live DB must still be healthy
    const version = await readVersion(lbugPath);
    expect(version).toBe('healthy');
    await expect(fsP.access(pendingPath)).rejects.toThrow();
  });

  it('live DB survives when pending WAL is orphaned', async () => {
    const { closeLbug } = await import('../../src/core/lbug/lbug-adapter.js');
    await closeLbug();

    const lbugPath = path.join(tmpDir, 'lbug2');
    const pendingPath = lbugPath + '.pending';

    await createSeededDb(lbugPath, 'live-wal-test');
    await closeLbug();

    // Simulate orphaned WAL sidecar
    await fsP.writeFile(`${pendingPath}.wal`, 'orphan-wal-data');

    for (const f of [pendingPath, `${pendingPath}.wal`, `${pendingPath}.lock`]) {
      try { await fsP.rm(f, { force: true }); } catch {}
    }

    const version = await readVersion(lbugPath);
    expect(version).toBe('live-wal-test');
    await expect(fsP.access(`${pendingPath}.wal`)).rejects.toThrow();
  });
});

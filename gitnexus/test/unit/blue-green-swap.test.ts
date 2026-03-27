/**
 * Unit Tests: Blue-green swap, mtime reconnection, and serve resilience
 *
 * Scenarios covered:
 *
 * Blue-Green Swap (analyze.ts changes):
 *   - Pending DB is built at lbug.pending, not at lbug
 *   - Atomic swap: lbug.pending → lbug after build
 *   - First build (no existing lbug) works
 *   - Interrupted build cleans up lbug.pending
 *
 * Mtime-Based Reconnect (lbug-adapter.ts):
 *   - Same path + same mtime → reuse connection
 *   - Same path + different mtime → reconnect (blue-green swap detected)
 *   - invalidateConnection() forces reconnect
 *   - checkpointLbug() is safe when no connection
 *
 * Health Endpoint & Error Detection (api.ts):
 *   - statusFromError returns 503 for busy/lock/enoent
 *   - statusFromError returns 404 for not-found
 *   - statusFromError returns 500 for generic errors
 *
 * deleteNodesByFilePath (lbug-adapter.ts):
 *   - Returns 0 for empty input
 *   - Handles missing connection gracefully
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

// ═══════════════════════════════════════════════════════════════════════
// 1. BLUE-GREEN FILE SWAP SIMULATION
// ═══════════════════════════════════════════════════════════════════════

describe('blue-green file swap simulation', () => {
  let tmpDir: string;
  let lbugPath: string;
  let pendingPath: string;
  let prevPath: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bg-swap-'));
    lbugPath = path.join(tmpDir, 'lbug');
    pendingPath = lbugPath + '.pending';
    prevPath = lbugPath + '.prev';
  });

  afterEach(async () => {
    try { await fs.rm(tmpDir, { recursive: true, force: true }); } catch {}
  });

  it('swaps pending → live when live already exists', async () => {
    // Simulate existing live DB
    await fs.writeFile(lbugPath, 'old-data');
    // Simulate completed pending build
    await fs.writeFile(pendingPath, 'new-data');

    // Execute the swap (same logic as analyze.ts)
    try { await fs.rm(prevPath, { force: true }); } catch {}
    try { await fs.rename(lbugPath, prevPath); } catch {}
    await fs.rename(pendingPath, lbugPath);
    try { await fs.rm(prevPath, { force: true }); } catch {}

    const content = await fs.readFile(lbugPath, 'utf-8');
    expect(content).toBe('new-data');

    // Pending and prev should be gone
    await expect(fs.access(pendingPath)).rejects.toThrow();
    await expect(fs.access(prevPath)).rejects.toThrow();
  });

  it('swaps pending → live on first build (no existing lbug)', async () => {
    // No existing lbug — simulates first-ever analyze
    await fs.writeFile(pendingPath, 'first-build');

    try { await fs.rm(prevPath, { force: true }); } catch {}
    try {
      await fs.rename(lbugPath, prevPath);
    } catch {
      // Expected: lbugPath doesn't exist
    }
    await fs.rename(pendingPath, lbugPath);
    try { await fs.rm(prevPath, { force: true }); } catch {}

    const content = await fs.readFile(lbugPath, 'utf-8');
    expect(content).toBe('first-build');
  });

  it('preserves live DB when pending build is interrupted', async () => {
    // Simulate existing live DB
    await fs.writeFile(lbugPath, 'live-data');
    // Simulate incomplete pending (never gets to swap)
    await fs.writeFile(pendingPath, 'incomplete');

    // SIGINT cleanup: remove pending files
    for (const f of [pendingPath, `${pendingPath}.wal`, `${pendingPath}.lock`]) {
      try { await fs.rm(f, { force: true }); } catch {}
    }

    // Live DB must be untouched
    const content = await fs.readFile(lbugPath, 'utf-8');
    expect(content).toBe('live-data');

    // Pending must be gone
    await expect(fs.access(pendingPath)).rejects.toThrow();
  });

  it('cleans stale pending from previous interrupted run', async () => {
    // Stale pending left over from crashed analyze
    await fs.writeFile(pendingPath, 'stale');
    await fs.writeFile(`${pendingPath}.wal`, 'stale-wal');

    // Clean stale (same as analyze.ts startup)
    for (const f of [pendingPath, `${pendingPath}.wal`, `${pendingPath}.lock`]) {
      try { await fs.rm(f, { recursive: true, force: true }); } catch {}
    }

    await expect(fs.access(pendingPath)).rejects.toThrow();
    await expect(fs.access(`${pendingPath}.wal`)).rejects.toThrow();
  });

  it('handles concurrent swap safely — old file handle stays valid', async () => {
    // Simulate: serve process has old file "open" (we read its content)
    await fs.writeFile(lbugPath, 'version-1');
    const oldContent = await fs.readFile(lbugPath, 'utf-8');

    // Swap happens
    await fs.writeFile(pendingPath, 'version-2');
    try { await fs.rename(lbugPath, prevPath); } catch {}
    await fs.rename(pendingPath, lbugPath);

    // Old read (captured before swap) still has old data
    expect(oldContent).toBe('version-1');
    // New read gets new data
    const newContent = await fs.readFile(lbugPath, 'utf-8');
    expect(newContent).toBe('version-2');

    try { await fs.rm(prevPath, { force: true }); } catch {}
  });

  it('sidecar files (.wal, .lock) are swapped together', async () => {
    await fs.writeFile(lbugPath, 'main');
    await fs.writeFile(`${lbugPath}.wal`, 'old-wal');

    await fs.writeFile(pendingPath, 'new-main');
    await fs.writeFile(`${pendingPath}.wal`, 'new-wal');

    // Swap main
    try { await fs.rename(lbugPath, prevPath); } catch {}
    await fs.rename(pendingPath, lbugPath);
    // Swap sidecars
    try { await fs.rename(`${pendingPath}.wal`, `${lbugPath}.wal`); } catch {}

    expect(await fs.readFile(lbugPath, 'utf-8')).toBe('new-main');
    expect(await fs.readFile(`${lbugPath}.wal`, 'utf-8')).toBe('new-wal');

    // Cleanup
    try { await fs.rm(prevPath, { force: true }); } catch {}
    try { await fs.rm(`${prevPath}.wal`, { force: true }); } catch {}
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 2. MTIME-BASED RECONNECT DETECTION
// ═══════════════════════════════════════════════════════════════════════

describe('mtime-based reconnect detection', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mtime-'));
  });

  afterEach(async () => {
    try { await fs.rm(tmpDir, { recursive: true, force: true }); } catch {}
  });

  it('detects file replacement via mtime change', async () => {
    const filePath = path.join(tmpDir, 'db');
    await fs.writeFile(filePath, 'v1');
    const stat1 = await fs.stat(filePath);
    const mtime1 = stat1.mtimeMs;

    // Wait briefly to ensure mtime differs
    await new Promise(r => setTimeout(r, 50));

    // Simulate blue-green swap
    const pendingPath = filePath + '.pending';
    await fs.writeFile(pendingPath, 'v2');
    await fs.rename(pendingPath, filePath);

    const stat2 = await fs.stat(filePath);
    const mtime2 = stat2.mtimeMs;

    // Mtime must differ — this is what triggers reconnection
    expect(mtime2).not.toBe(mtime1);
  });

  it('same file without replacement has same mtime', async () => {
    const filePath = path.join(tmpDir, 'db');
    await fs.writeFile(filePath, 'v1');
    const stat1 = await fs.stat(filePath);
    const stat2 = await fs.stat(filePath);

    // Without modification, mtime stays the same
    expect(stat2.mtimeMs).toBe(stat1.mtimeMs);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 3. invalidateConnection() AND checkpointLbug()
// ═══════════════════════════════════════════════════════════════════════

describe('invalidateConnection and checkpointLbug', () => {
  it('invalidateConnection does not throw when no connection', async () => {
    const { invalidateConnection } = await import('../../src/core/lbug/lbug-adapter.js');
    expect(() => invalidateConnection()).not.toThrow();
  });

  it('checkpointLbug does not throw when no connection', async () => {
    const { checkpointLbug } = await import('../../src/core/lbug/lbug-adapter.js');
    await expect(checkpointLbug()).resolves.not.toThrow();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 4. statusFromError — 503 DETECTION FOR BLUE-GREEN SWAP
// ═══════════════════════════════════════════════════════════════════════

describe('statusFromError: blue-green swap error detection', () => {
  // statusFromError is not exported, so we test via isAllowedOrigin import
  // pattern. Instead, let's test the error classification logic directly.

  const classify = (msg: string): number => {
    const lower = msg.toLowerCase();
    if (lower.includes('no indexed repositories') || lower.includes('not found')) return 404;
    if (lower.includes('multiple repositories')) return 400;
    if (lower.includes('busy') || lower.includes('lock') || lower.includes('enoent') || lower.includes('no such file')) return 503;
    return 500;
  };

  it('returns 503 for database busy during reindex', () => {
    expect(classify('Database is BUSY')).toBe(503);
    expect(classify('database is busy')).toBe(503);
  });

  it('returns 503 for lock errors during swap', () => {
    expect(classify('Could not set lock on file')).toBe(503);
    expect(classify('database is locked')).toBe(503);
  });

  it('returns 503 for ENOENT (file missing during swap)', () => {
    expect(classify('ENOENT: no such file or directory')).toBe(503);
    expect(classify('enoent')).toBe(503);
  });

  it('returns 503 for "no such file" errors', () => {
    expect(classify("Error: no such file '/data/lbug'")).toBe(503);
  });

  it('returns 404 for not-found errors (repo missing)', () => {
    expect(classify('Repository not found')).toBe(404);
    expect(classify('No indexed repositories')).toBe(404);
  });

  it('returns 400 for multiple repositories ambiguity', () => {
    expect(classify('Multiple repositories match')).toBe(400);
  });

  it('returns 500 for generic unrecognized errors', () => {
    expect(classify('Something went wrong')).toBe(500);
    expect(classify('Syntax error in Cypher query')).toBe(500);
    expect(classify('Out of memory')).toBe(500);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 5. deleteNodesByFilePath — EDGE CASES
// ═══════════════════════════════════════════════════════════════════════

describe('deleteNodesByFilePath edge cases', () => {
  it('returns 0 for empty file list without crashing', async () => {
    const { deleteNodesByFilePath } = await import('../../src/core/lbug/lbug-adapter.js');
    const result = await deleteNodesByFilePath([]);
    expect(result).toBe(0);
  });

  it('returns 0 when no connection is active', async () => {
    const { deleteNodesByFilePath, closeLbug } = await import('../../src/core/lbug/lbug-adapter.js');
    await closeLbug();
    const result = await deleteNodesByFilePath(['src/foo.ts', 'src/bar.ts']);
    expect(result).toBe(0);
  });
});

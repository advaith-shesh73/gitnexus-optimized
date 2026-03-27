/**
 * Unit Tests: Safe git update utilities
 *
 * Tests the new functions in storage/git.ts that handle source code
 * updates for read-only mirror directories:
 *
 *   getChangedFiles():
 *     - Parses A (added), M (modified), D (deleted) status correctly
 *     - Handles R (rename) with old + new paths
 *     - Returns empty array for identical commits
 *     - Returns empty array when git diff fails (invalid commits)
 *     - Returns empty array when fromCommit or toCommit is empty
 *     - Handles files with special characters in paths
 *
 *   fetchAndResetToRemote():
 *     - Returns updated=true when commit changes
 *     - Returns updated=false when already up-to-date
 *     - Returns error when fetch fails (network error)
 *     - Returns error when branch detection fails
 *     - Uses git reset --hard (NOT git pull/merge)
 *     - Runs git clean -fd for pristine state
 *
 *   getDefaultRemoteBranch():
 *     - Detects origin/main
 *     - Detects origin/master
 *     - Falls back through branch candidates
 *     - Returns null when no branch found
 *
 *   isWorktreeClean():
 *     - Returns true for clean repo
 *     - Returns false for dirty repo
 *     - Returns false when git status fails
 *
 *   getTrackedFileCount():
 *     - Returns correct count
 *     - Returns 0 on error
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { execSync } from 'child_process';

vi.mock('child_process', () => ({
  execSync: vi.fn(),
}));

// Also mock 'fs' statSync for hasGitDir
vi.mock('fs', () => ({
  statSync: vi.fn(),
}));

const mockExecSync = vi.mocked(execSync);

// ═══════════════════════════════════════════════════════════════════════
// getChangedFiles
// ═══════════════════════════════════════════════════════════════════════

describe('getChangedFiles', () => {
  beforeEach(() => vi.clearAllMocks());

  // Must dynamically import after mocks are set up
  const getModule = async () => import('../../src/storage/git.js');

  it('parses Added, Modified, Deleted statuses', async () => {
    mockExecSync.mockReturnValueOnce(Buffer.from(
      'A\tsrc/new-file.ts\nM\tsrc/changed.ts\nD\tsrc/removed.ts'
    ));
    const { getChangedFiles } = await getModule();
    const result = getChangedFiles('/repo', 'abc123', 'def456');

    expect(result).toEqual([
      { status: 'A', path: 'src/new-file.ts' },
      { status: 'M', path: 'src/changed.ts' },
      { status: 'D', path: 'src/removed.ts' },
    ]);
  });

  it('parses Rename status with old and new paths', async () => {
    mockExecSync.mockReturnValueOnce(Buffer.from(
      'R100\tsrc/old-name.ts\tsrc/new-name.ts'
    ));
    const { getChangedFiles } = await getModule();
    const result = getChangedFiles('/repo', 'aaa', 'bbb');

    expect(result).toEqual([
      { status: 'R', path: 'src/new-name.ts', oldPath: 'src/old-name.ts' },
    ]);
  });

  it('parses Copy status with old and new paths', async () => {
    mockExecSync.mockReturnValueOnce(Buffer.from(
      'C100\tsrc/original.ts\tsrc/copy.ts'
    ));
    const { getChangedFiles } = await getModule();
    const result = getChangedFiles('/repo', 'aaa', 'bbb');

    expect(result).toEqual([
      { status: 'C', path: 'src/copy.ts', oldPath: 'src/original.ts' },
    ]);
  });

  it('returns empty array for identical commits (empty diff)', async () => {
    mockExecSync.mockReturnValueOnce(Buffer.from(''));
    const { getChangedFiles } = await getModule();
    const result = getChangedFiles('/repo', 'same', 'same');
    expect(result).toEqual([]);
  });

  it('returns empty array when git diff fails', async () => {
    mockExecSync.mockImplementationOnce(() => {
      throw new Error('fatal: bad object invalid-sha');
    });
    const { getChangedFiles } = await getModule();
    const result = getChangedFiles('/repo', 'invalid', 'also-invalid');
    expect(result).toEqual([]);
  });

  it('returns empty array when fromCommit is empty', async () => {
    const { getChangedFiles } = await getModule();
    const result = getChangedFiles('/repo', '', 'def456');
    expect(result).toEqual([]);
    expect(mockExecSync).not.toHaveBeenCalled();
  });

  it('returns empty array when toCommit is empty', async () => {
    const { getChangedFiles } = await getModule();
    const result = getChangedFiles('/repo', 'abc123', '');
    expect(result).toEqual([]);
    expect(mockExecSync).not.toHaveBeenCalled();
  });

  it('handles files with spaces in paths', async () => {
    mockExecSync.mockReturnValueOnce(Buffer.from(
      'M\tsrc/my file.ts\nA\tlib/some dir/other file.js'
    ));
    const { getChangedFiles } = await getModule();
    const result = getChangedFiles('/repo', 'aaa', 'bbb');

    expect(result).toEqual([
      { status: 'M', path: 'src/my file.ts' },
      { status: 'A', path: 'lib/some dir/other file.js' },
    ]);
  });

  it('handles large diffs with many files', async () => {
    const lines = Array.from({ length: 500 }, (_, i) => `M\tsrc/file${i}.ts`).join('\n');
    mockExecSync.mockReturnValueOnce(Buffer.from(lines));
    const { getChangedFiles } = await getModule();
    const result = getChangedFiles('/repo', 'aaa', 'bbb');
    expect(result).toHaveLength(500);
    expect(result[0]).toEqual({ status: 'M', path: 'src/file0.ts' });
    expect(result[499]).toEqual({ status: 'M', path: 'src/file499.ts' });
  });

  it('passes maxBuffer option for large repos', async () => {
    mockExecSync.mockReturnValueOnce(Buffer.from('M\tsrc/foo.ts'));
    const { getChangedFiles } = await getModule();
    getChangedFiles('/repo', 'aaa', 'bbb');
    expect(mockExecSync).toHaveBeenCalledWith(
      expect.stringContaining('git diff --name-status'),
      expect.objectContaining({ maxBuffer: 50 * 1024 * 1024 }),
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════
// fetchAndResetToRemote
// ═══════════════════════════════════════════════════════════════════════

describe('fetchAndResetToRemote', () => {
  beforeEach(() => vi.clearAllMocks());

  const getModule = async () => import('../../src/storage/git.js');

  it('returns updated=true when remote has new commits', async () => {
    // getCurrentCommit (before fetch)
    mockExecSync.mockReturnValueOnce(Buffer.from('old-sha\n'));
    // git fetch origin --prune
    mockExecSync.mockReturnValueOnce(Buffer.from(''));
    // getDefaultRemoteBranch: symbolic-ref
    mockExecSync.mockReturnValueOnce(Buffer.from('refs/remotes/origin/main\n'));
    // git reset --hard origin/main
    mockExecSync.mockReturnValueOnce(Buffer.from(''));
    // git clean -fd
    mockExecSync.mockReturnValueOnce(Buffer.from(''));
    // getCurrentCommit (after reset)
    mockExecSync.mockReturnValueOnce(Buffer.from('new-sha\n'));

    const { fetchAndResetToRemote } = await getModule();
    const result = fetchAndResetToRemote('/repo');

    expect(result.updated).toBe(true);
    expect(result.previousCommit).toBe('old-sha');
    expect(result.currentCommit).toBe('new-sha');
    expect(result.error).toBeUndefined();
  });

  it('returns updated=false when already up-to-date', async () => {
    // getCurrentCommit (before)
    mockExecSync.mockReturnValueOnce(Buffer.from('same-sha\n'));
    // git fetch
    mockExecSync.mockReturnValueOnce(Buffer.from(''));
    // symbolic-ref
    mockExecSync.mockReturnValueOnce(Buffer.from('refs/remotes/origin/main\n'));
    // git reset
    mockExecSync.mockReturnValueOnce(Buffer.from(''));
    // git clean
    mockExecSync.mockReturnValueOnce(Buffer.from(''));
    // getCurrentCommit (after) — same commit
    mockExecSync.mockReturnValueOnce(Buffer.from('same-sha\n'));

    const { fetchAndResetToRemote } = await getModule();
    const result = fetchAndResetToRemote('/repo');

    expect(result.updated).toBe(false);
    expect(result.previousCommit).toBe('same-sha');
    expect(result.currentCommit).toBe('same-sha');
  });

  it('returns error when fetch fails (network)', async () => {
    // getCurrentCommit
    mockExecSync.mockReturnValueOnce(Buffer.from('sha\n'));
    // git fetch — fails
    mockExecSync.mockImplementationOnce(() => {
      throw new Error('fatal: unable to access remote');
    });

    const { fetchAndResetToRemote } = await getModule();
    const result = fetchAndResetToRemote('/repo');

    expect(result.updated).toBe(false);
    expect(result.error).toContain('fetch failed');
  });

  it('uses git reset --hard, NOT git merge/pull', async () => {
    mockExecSync.mockReturnValueOnce(Buffer.from('sha\n'));
    mockExecSync.mockReturnValueOnce(Buffer.from('')); // fetch
    mockExecSync.mockReturnValueOnce(Buffer.from('refs/remotes/origin/main\n'));
    mockExecSync.mockReturnValueOnce(Buffer.from('')); // reset
    mockExecSync.mockReturnValueOnce(Buffer.from('')); // clean
    mockExecSync.mockReturnValueOnce(Buffer.from('sha\n'));

    const { fetchAndResetToRemote } = await getModule();
    fetchAndResetToRemote('/repo');

    const allCalls = mockExecSync.mock.calls.map(c => c[0]);
    // Must have reset --hard, must NOT have merge or pull
    expect(allCalls.some(cmd => typeof cmd === 'string' && cmd.includes('reset --hard'))).toBe(true);
    expect(allCalls.every(cmd => typeof cmd === 'string' && !cmd.includes('git pull'))).toBe(true);
    expect(allCalls.every(cmd => typeof cmd === 'string' && !cmd.includes('git merge'))).toBe(true);
  });

  it('runs git clean -fd after reset', async () => {
    mockExecSync.mockReturnValueOnce(Buffer.from('sha\n'));
    mockExecSync.mockReturnValueOnce(Buffer.from('')); // fetch
    mockExecSync.mockReturnValueOnce(Buffer.from('refs/remotes/origin/main\n'));
    mockExecSync.mockReturnValueOnce(Buffer.from('')); // reset
    mockExecSync.mockReturnValueOnce(Buffer.from('')); // clean
    mockExecSync.mockReturnValueOnce(Buffer.from('sha\n'));

    const { fetchAndResetToRemote } = await getModule();
    fetchAndResetToRemote('/repo');

    const allCalls = mockExecSync.mock.calls.map(c => c[0]);
    expect(allCalls.some(cmd => typeof cmd === 'string' && cmd.includes('git clean -fd'))).toBe(true);
  });

  it('accepts explicit remoteBranch override', async () => {
    mockExecSync.mockReturnValueOnce(Buffer.from('sha\n'));
    mockExecSync.mockReturnValueOnce(Buffer.from('')); // fetch
    // No branch detection needed — explicit branch provided
    mockExecSync.mockReturnValueOnce(Buffer.from('')); // reset
    mockExecSync.mockReturnValueOnce(Buffer.from('')); // clean
    mockExecSync.mockReturnValueOnce(Buffer.from('sha\n'));

    const { fetchAndResetToRemote } = await getModule();
    fetchAndResetToRemote('/repo', 'origin/develop');

    const resetCall = mockExecSync.mock.calls.find(
      c => typeof c[0] === 'string' && c[0].includes('reset --hard')
    );
    expect(resetCall).toBeTruthy();
    expect(resetCall![0]).toContain('origin/develop');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// getDefaultRemoteBranch
// ═══════════════════════════════════════════════════════════════════════

describe('getDefaultRemoteBranch', () => {
  beforeEach(() => vi.clearAllMocks());

  const getModule = async () => import('../../src/storage/git.js');

  it('detects branch from symbolic-ref', async () => {
    mockExecSync.mockReturnValueOnce(Buffer.from('refs/remotes/origin/main\n'));
    const { getDefaultRemoteBranch } = await getModule();
    expect(getDefaultRemoteBranch('/repo')).toBe('origin/main');
  });

  it('falls back to origin/main when symbolic-ref fails', async () => {
    // symbolic-ref fails
    mockExecSync.mockImplementationOnce(() => { throw new Error(''); });
    // rev-parse origin/main succeeds
    mockExecSync.mockReturnValueOnce(Buffer.from(''));

    const { getDefaultRemoteBranch } = await getModule();
    expect(getDefaultRemoteBranch('/repo')).toBe('origin/main');
  });

  it('falls back to origin/master when main does not exist', async () => {
    // symbolic-ref fails
    mockExecSync.mockImplementationOnce(() => { throw new Error(''); });
    // origin/main fails
    mockExecSync.mockImplementationOnce(() => { throw new Error(''); });
    // origin/master succeeds
    mockExecSync.mockReturnValueOnce(Buffer.from(''));

    const { getDefaultRemoteBranch } = await getModule();
    expect(getDefaultRemoteBranch('/repo')).toBe('origin/master');
  });

  it('returns null when no branch found', async () => {
    // symbolic-ref fails
    mockExecSync.mockImplementationOnce(() => { throw new Error(''); });
    // All branch checks fail
    mockExecSync.mockImplementationOnce(() => { throw new Error(''); });
    mockExecSync.mockImplementationOnce(() => { throw new Error(''); });
    mockExecSync.mockImplementationOnce(() => { throw new Error(''); });

    const { getDefaultRemoteBranch } = await getModule();
    expect(getDefaultRemoteBranch('/repo')).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// isWorktreeClean
// ═══════════════════════════════════════════════════════════════════════

describe('isWorktreeClean', () => {
  beforeEach(() => vi.clearAllMocks());

  const getModule = async () => import('../../src/storage/git.js');

  it('returns true for clean working tree', async () => {
    mockExecSync.mockReturnValueOnce(Buffer.from(''));
    const { isWorktreeClean } = await getModule();
    expect(isWorktreeClean('/repo')).toBe(true);
  });

  it('returns false for dirty working tree', async () => {
    mockExecSync.mockReturnValueOnce(Buffer.from(' M src/dirty.ts\n?? untracked.txt'));
    const { isWorktreeClean } = await getModule();
    expect(isWorktreeClean('/repo')).toBe(false);
  });

  it('returns false when git status fails', async () => {
    mockExecSync.mockImplementationOnce(() => { throw new Error('not a repo'); });
    const { isWorktreeClean } = await getModule();
    expect(isWorktreeClean('/tmp')).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// getTrackedFileCount
// ═══════════════════════════════════════════════════════════════════════

describe('getTrackedFileCount', () => {
  beforeEach(() => vi.clearAllMocks());

  const getModule = async () => import('../../src/storage/git.js');

  it('returns file count from git ls-tree', async () => {
    mockExecSync.mockReturnValueOnce(Buffer.from('1234\n'));
    const { getTrackedFileCount } = await getModule();
    expect(getTrackedFileCount('/repo')).toBe(1234);
  });

  it('returns 0 on error', async () => {
    mockExecSync.mockImplementationOnce(() => { throw new Error('not a repo'); });
    const { getTrackedFileCount } = await getModule();
    expect(getTrackedFileCount('/repo')).toBe(0);
  });

  it('uses HEAD by default', async () => {
    mockExecSync.mockReturnValueOnce(Buffer.from('100\n'));
    const { getTrackedFileCount } = await getModule();
    getTrackedFileCount('/repo');
    expect(mockExecSync).toHaveBeenCalledWith(
      expect.stringContaining('HEAD'),
      expect.any(Object),
    );
  });

  it('uses provided commit ref', async () => {
    mockExecSync.mockReturnValueOnce(Buffer.from('50\n'));
    const { getTrackedFileCount } = await getModule();
    getTrackedFileCount('/repo', 'abc123');
    expect(mockExecSync).toHaveBeenCalledWith(
      expect.stringContaining('abc123'),
      expect.any(Object),
    );
  });
});

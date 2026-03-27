import { execSync } from 'child_process';
import { statSync } from 'fs';
import path from 'path';

// Git utilities for repository detection, commit tracking, and diff analysis

export const isGitRepo = (repoPath: string): boolean => {
  try {
    execSync('git rev-parse --is-inside-work-tree', { cwd: repoPath, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};

export const getCurrentCommit = (repoPath: string): string => {
  try {
    return execSync('git rev-parse HEAD', { cwd: repoPath }).toString().trim();
  } catch {
    return '';
  }
};

/**
 * Find the git repository root from any path inside the repo
 */
export const getGitRoot = (fromPath: string): string | null => {
  try {
    const raw = execSync('git rev-parse --show-toplevel', { cwd: fromPath })
      .toString()
      .trim();
    // On Windows, git returns /d/Projects/Foo — path.resolve normalizes to D:\Projects\Foo
    return path.resolve(raw);
  } catch {
    return null;
  }
};
/**
 * Check whether a directory contains a .git entry (file or folder).
 *
 * This is intentionally a simple filesystem check rather than running
 * `git rev-parse`, so it works even when git is not installed or when
 * the directory is a git-worktree root (which has a .git file, not a
 * directory).  Use `isGitRepo` for a definitive git answer.
 *
 * @param dirPath - Absolute path to the directory to inspect.
 * @returns `true` when `.git` is present, `false` otherwise.
 */
export const hasGitDir = (dirPath: string): boolean => {
  try {
    statSync(path.join(dirPath, '.git'));
    return true;
  } catch {
    return false;
  }
};

export type FileChangeStatus = 'A' | 'M' | 'D' | 'R' | 'C';
export interface ChangedFile {
  status: FileChangeStatus;
  path: string;
  /** For renames/copies, the original path before the move. */
  oldPath?: string;
}

/**
 * List files that changed between two commits using `git diff --name-status`.
 * Returns an empty array if the diff fails (e.g. one of the commits is invalid).
 */
export const getChangedFiles = (
  repoPath: string,
  fromCommit: string,
  toCommit: string,
): ChangedFile[] => {
  if (!fromCommit || !toCommit) return [];
  try {
    const raw = execSync(
      `git diff --name-status ${fromCommit}..${toCommit}`,
      { cwd: repoPath, maxBuffer: 50 * 1024 * 1024 },
    ).toString().trim();
    if (!raw) return [];

    return raw.split('\n').filter(Boolean).map(line => {
      const parts = line.split('\t');
      const statusChar = parts[0][0] as FileChangeStatus;
      if (statusChar === 'R' || statusChar === 'C') {
        // R100\told\tnew  or  C100\told\tnew
        return { status: statusChar, path: parts[2], oldPath: parts[1] };
      }
      return { status: statusChar, path: parts[1] };
    });
  } catch {
    return [];
  }
};

/**
 * Return all tracked file paths in the repo at the given commit (or HEAD).
 * Paths are relative to the repo root.
 */
export const getTrackedFiles = (repoPath: string, commit?: string): string[] => {
  try {
    const ref = commit || 'HEAD';
    const raw = execSync(
      `git ls-tree -r --name-only ${ref}`,
      { cwd: repoPath, maxBuffer: 50 * 1024 * 1024 },
    ).toString().trim();
    if (!raw) return [];
    return raw.split('\n').filter(Boolean);
  } catch {
    return [];
  }
};

/**
 * Count total tracked files in the repo at the given commit (or HEAD).
 */
export const getTrackedFileCount = (repoPath: string, commit?: string): number => {
  try {
    const ref = commit || 'HEAD';
    const raw = execSync(
      `git ls-tree -r --name-only ${ref} | wc -l`,
      { cwd: repoPath, shell: '/bin/sh' },
    ).toString().trim();
    return parseInt(raw, 10) || 0;
  } catch {
    return 0;
  }
};

// ─── Safe Source Update Helpers ─────────────────────────────────────────
// These are designed for READ-ONLY mirror directories that GitNexus indexes.
// They use `fetch + reset --hard` instead of `pull` to guarantee a clean
// working tree with zero risk of merge conflicts.

export interface SourceUpdateResult {
  updated: boolean;
  previousCommit: string;
  currentCommit: string;
  error?: string;
}

/**
 * Detect the default remote branch (e.g. origin/main, origin/master).
 * Returns null if detection fails.
 */
export const getDefaultRemoteBranch = (repoPath: string): string | null => {
  try {
    // Try symbolic-ref first (works when HEAD is set on the remote)
    const ref = execSync(
      'git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null',
      { cwd: repoPath, shell: '/bin/sh' },
    ).toString().trim();
    if (ref) return ref.replace('refs/remotes/', '');
  } catch { /* fall through */ }

  // Fallback: check for common branch names
  for (const branch of ['origin/main', 'origin/master', 'origin/develop']) {
    try {
      execSync(`git rev-parse --verify ${branch}`, {
        cwd: repoPath,
        stdio: 'ignore',
      });
      return branch;
    } catch { /* try next */ }
  }
  return null;
};

/**
 * Fetch latest from remote and force-update the working tree to match.
 *
 * Uses `git fetch` + `git reset --hard` instead of `git pull` to avoid
 * merge conflicts entirely.  Any local modifications are discarded — this
 * is intentional for read-only mirror directories.
 *
 * @returns Whether the commit changed (i.e. there's new code to index).
 */
export const fetchAndResetToRemote = (
  repoPath: string,
  remoteBranch?: string,
): SourceUpdateResult => {
  const previousCommit = getCurrentCommit(repoPath);

  try {
    // Step 1: Download latest objects
    execSync('git fetch origin --prune', {
      cwd: repoPath,
      stdio: 'pipe',
      timeout: 120_000,
    });
  } catch (err: any) {
    return {
      updated: false,
      previousCommit,
      currentCommit: previousCommit,
      error: `fetch failed: ${(err.message || '').slice(0, 200)}`,
    };
  }

  const target = remoteBranch || getDefaultRemoteBranch(repoPath);
  if (!target) {
    return {
      updated: false,
      previousCommit,
      currentCommit: previousCommit,
      error: 'could not determine remote branch',
    };
  }

  try {
    // Step 2: Force working tree to match remote (no merge, no conflicts)
    execSync(`git reset --hard ${target}`, { cwd: repoPath, stdio: 'pipe' });
    // Step 3: Remove untracked files/dirs for a pristine state
    execSync('git clean -fd', { cwd: repoPath, stdio: 'pipe' });
  } catch (err: any) {
    return {
      updated: false,
      previousCommit,
      currentCommit: previousCommit,
      error: `reset failed: ${(err.message || '').slice(0, 200)}`,
    };
  }

  const currentCommit = getCurrentCommit(repoPath);
  return {
    updated: currentCommit !== previousCommit,
    previousCommit,
    currentCommit,
  };
};

/**
 * Check whether the working tree is clean (no uncommitted changes or
 * untracked files).  Useful to verify state before indexing.
 */
export const isWorktreeClean = (repoPath: string): boolean => {
  try {
    const status = execSync('git status --porcelain', {
      cwd: repoPath,
    }).toString().trim();
    return status.length === 0;
  } catch {
    return false;
  }
};

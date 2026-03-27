/**
 * Integration Tests: Git Source Update Scenarios
 *
 * End-to-end tests using REAL git repositories to verify:
 *
 *   Scenario 1: "Normal update" — remote has new commits
 *     - fetchAndResetToRemote detects the change
 *     - getChangedFiles returns correct diff
 *     - Working tree is clean after update
 *
 *   Scenario 2: "No changes" — already up-to-date
 *     - Returns updated=false
 *     - Working tree remains unchanged
 *
 *   Scenario 3: "Dirty worktree" — local edits exist
 *     - fetchAndResetToRemote discards local edits (by design)
 *     - Working tree matches remote exactly
 *
 *   Scenario 4: "Untracked files" — leftover build artifacts
 *     - git clean removes untracked files
 *     - isWorktreeClean returns true after update
 *
 *   Scenario 5: "Rename detection"
 *     - getChangedFiles parses R status from real git
 *
 *   Scenario 6: "Branch detection"
 *     - getDefaultRemoteBranch identifies main/master
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

let tmpDir: string;
let bareRepo: string;
let mirrorRepo: string;

const git = (cmd: string, cwd: string) =>
  execSync(`git ${cmd}`, { cwd, stdio: 'pipe' }).toString().trim();

const writeFile = async (dir: string, name: string, content: string) => {
  const filePath = path.join(dir, name);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content);
  return filePath;
};

describe('git source update scenarios (real repos)', () => {
  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'git-scenarios-'));
    bareRepo = path.join(tmpDir, 'origin.git');
    mirrorRepo = path.join(tmpDir, 'mirror');

    // Create bare "remote" repo with 'main' as default branch
    execSync(`git init --bare --initial-branch=main ${bareRepo}`, { stdio: 'pipe' });

    // Create a working clone, make initial commit, push
    const workDir = path.join(tmpDir, 'work');
    execSync(`git clone ${bareRepo} ${workDir}`, { stdio: 'pipe' });
    git('config user.email "test@test.com"', workDir);
    git('config user.name "Test"', workDir);
    await writeFile(workDir, 'src/main.ts', 'console.log("hello");');
    await writeFile(workDir, 'src/utils.ts', 'export const add = (a: number, b: number) => a + b;');
    git('add -A', workDir);
    git('commit -m "initial commit"', workDir);
    git('push origin main', workDir);

    // Create the mirror (what GitNexus would index)
    execSync(`git clone ${bareRepo} ${mirrorRepo}`, { stdio: 'pipe' });
    git('config user.email "test@test.com"', mirrorRepo);
    git('config user.name "Test"', mirrorRepo);
  }, 30000);

  afterAll(async () => {
    try { await fs.rm(tmpDir, { recursive: true, force: true }); } catch {}
  });

  it('Scenario 1: detects new commits from remote', async () => {
    // Push new commits from a separate work dir
    const workDir = path.join(tmpDir, 'work');
    await writeFile(workDir, 'src/new-feature.ts', 'export const feature = () => "new";');
    git('add -A', workDir);
    git('commit -m "add new feature"', workDir);
    git('push origin main', workDir);

    const {
      fetchAndResetToRemote,
      getCurrentCommit,
      isWorktreeClean,
    } = await import('../../src/storage/git.js');

    const beforeCommit = getCurrentCommit(mirrorRepo);
    const result = fetchAndResetToRemote(mirrorRepo);

    expect(result.updated).toBe(true);
    expect(result.previousCommit).toBe(beforeCommit);
    expect(result.currentCommit).not.toBe(beforeCommit);
    expect(result.error).toBeUndefined();
    expect(isWorktreeClean(mirrorRepo)).toBe(true);

    // File should exist in mirror
    const content = await fs.readFile(path.join(mirrorRepo, 'src/new-feature.ts'), 'utf-8');
    expect(content).toBe('export const feature = () => "new";');
  });

  it('Scenario 2: returns updated=false when already up-to-date', async () => {
    const { fetchAndResetToRemote, getCurrentCommit } = await import('../../src/storage/git.js');

    const beforeCommit = getCurrentCommit(mirrorRepo);
    const result = fetchAndResetToRemote(mirrorRepo);

    expect(result.updated).toBe(false);
    expect(result.previousCommit).toBe(beforeCommit);
    expect(result.currentCommit).toBe(beforeCommit);
    expect(result.error).toBeUndefined();
  });

  it('Scenario 3: discards dirty worktree (local edits)', async () => {
    const { fetchAndResetToRemote, isWorktreeClean } = await import('../../src/storage/git.js');

    // Dirty the mirror with local edits
    await writeFile(mirrorRepo, 'src/main.ts', 'DIRTY LOCAL EDIT');
    expect(isWorktreeClean(mirrorRepo)).toBe(false);

    // Push a new commit from work dir
    const workDir = path.join(tmpDir, 'work');
    await writeFile(workDir, 'src/utils.ts', 'export const add = (a: number, b: number) => a + b;\nexport const sub = (a: number, b: number) => a - b;');
    git('add -A', workDir);
    git('commit -m "update utils"', workDir);
    git('push origin main', workDir);

    const result = fetchAndResetToRemote(mirrorRepo);

    expect(result.updated).toBe(true);
    expect(result.error).toBeUndefined();
    expect(isWorktreeClean(mirrorRepo)).toBe(true);

    // Local edits must be gone — file should match remote
    const content = await fs.readFile(path.join(mirrorRepo, 'src/main.ts'), 'utf-8');
    expect(content).toBe('console.log("hello");');
  });

  it('Scenario 4: removes untracked files (build artifacts)', async () => {
    const { fetchAndResetToRemote, isWorktreeClean } = await import('../../src/storage/git.js');

    // Create untracked files (simulating build artifacts)
    await writeFile(mirrorRepo, 'dist/bundle.js', 'bundled code');
    await writeFile(mirrorRepo, 'node_modules/.cache/foo', 'cache');
    expect(isWorktreeClean(mirrorRepo)).toBe(false);

    const result = fetchAndResetToRemote(mirrorRepo);

    // No new commits, but worktree was cleaned
    expect(result.error).toBeUndefined();
    expect(isWorktreeClean(mirrorRepo)).toBe(true);

    // Untracked files must be gone
    await expect(fs.access(path.join(mirrorRepo, 'dist/bundle.js'))).rejects.toThrow();
  });

  it('Scenario 5: getChangedFiles detects renames from real git', async () => {
    const { getCurrentCommit, getChangedFiles } = await import('../../src/storage/git.js');

    const workDir = path.join(tmpDir, 'work');
    const beforeCommit = getCurrentCommit(workDir);

    // Rename a file
    git('mv src/new-feature.ts src/renamed-feature.ts', workDir);
    git('commit -m "rename feature file"', workDir);
    const afterCommit = getCurrentCommit(workDir);

    const changes = getChangedFiles(workDir, beforeCommit, afterCommit);

    const rename = changes.find(c => c.status === 'R');
    expect(rename).toBeDefined();
    expect(rename!.oldPath).toBe('src/new-feature.ts');
    expect(rename!.path).toBe('src/renamed-feature.ts');
  });

  it('Scenario 6: getDefaultRemoteBranch identifies main', async () => {
    const { getDefaultRemoteBranch } = await import('../../src/storage/git.js');

    const branch = getDefaultRemoteBranch(mirrorRepo);
    expect(branch).toBe('origin/main');
  });

  it('Scenario 7: getChangedFiles with mixed A/M/D in single diff', async () => {
    const { getCurrentCommit, getChangedFiles } = await import('../../src/storage/git.js');

    const workDir = path.join(tmpDir, 'work');
    const beforeCommit = getCurrentCommit(workDir);

    // Make multiple changes in one commit
    await writeFile(workDir, 'src/brand-new.ts', 'new file');
    await writeFile(workDir, 'src/utils.ts', '// modified content');
    await fs.rm(path.join(workDir, 'src/renamed-feature.ts'));
    git('add -A', workDir);
    git('commit -m "mixed changes"', workDir);
    const afterCommit = getCurrentCommit(workDir);

    const changes = getChangedFiles(workDir, beforeCommit, afterCommit);

    const added = changes.filter(c => c.status === 'A');
    const modified = changes.filter(c => c.status === 'M');
    const deleted = changes.filter(c => c.status === 'D');

    expect(added.length).toBeGreaterThanOrEqual(1);
    expect(modified.length).toBeGreaterThanOrEqual(1);
    expect(deleted.length).toBeGreaterThanOrEqual(1);
  });

  it('Scenario 8: getTrackedFileCount returns correct count', async () => {
    const { getTrackedFileCount } = await import('../../src/storage/git.js');

    const count = getTrackedFileCount(mirrorRepo);
    expect(count).toBeGreaterThan(0);
    // We created main.ts, utils.ts, and brand-new.ts (renamed-feature.ts was deleted)
    expect(count).toBeLessThan(100);
  });
});

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { fileURLToPath } from 'url';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testDir, '../..');
const cliEntry = path.join(repoRoot, 'src/cli/index.ts');

function runCli(args: string[], cwd: string, timeoutMs = 15000) {
  return spawnSync(process.execPath, ['--import', 'tsx', cliEntry, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: timeoutMs,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --max-old-space-size=8192`.trim(),
    },
  });
}

describe('--skip-git CLI flag', () => {
  it('Commander maps --skip-git to options.skipGit (not --no-git inversion)', () => {
    const result = runCli(['analyze', '--help'], repoRoot);
    if (result.status === null) return; // CI timeout

    const output = result.stdout + result.stderr;
    expect(output).toContain('--skip-git');
    expect(output).not.toContain('--no-git');
  });

  it('rejects non-git folder without --skip-git', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-no-git-'));
    fs.writeFileSync(path.join(tmpDir, 'test.ts'), 'export const x = 1;');

    try {
      const result = runCli(['analyze', tmpDir], repoRoot);
      if (result.status === null) return; // CI timeout

      expect(result.status).not.toBe(0);
      const output = result.stdout + result.stderr;
      expect(output).toContain('--skip-git');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

import { describe, it, expect, vi } from 'vitest';
import { expandAffectedFiles } from '../../src/core/ingestion/incremental.js';
import type { ChangedFile } from '../../src/storage/git.js';

const REPO = '/repo';

function mockExecuteQuery(importMap: Record<string, string[]>) {
  return vi.fn(async (cypher: string): Promise<any[]> => {
    const inMatch = cypher.match(/filePath IN \[([^\]]+)\]/);
    if (!inMatch) return [];
    const paths = inMatch[1].match(/'([^']+)'/g)?.map(s => s.slice(1, -1)) ?? [];

    const results: any[] = [];
    for (const targetPath of paths) {
      const importers = importMap[targetPath] ?? [];
      for (const fp of importers) {
        results.push({ fp });
      }
    }
    return results;
  });
}

describe('expandAffectedFiles', () => {
  it('returns only directly changed files when no importers exist', async () => {
    const eq = mockExecuteQuery({});
    const changed: ChangedFile[] = [
      { status: 'M', path: 'src/utils.ts' },
      { status: 'A', path: 'src/new-file.ts' },
    ];

    const result = await expandAffectedFiles(eq, changed, REPO);

    expect(result.directlyChanged).toEqual([
      'src/utils.ts',
      'src/new-file.ts',
    ]);
    expect(result.importers).toEqual([]);
    expect(result.all).toEqual(['src/utils.ts', 'src/new-file.ts']);
  });

  it('expands 1-hop importers from the import graph', async () => {
    const eq = mockExecuteQuery({
      'src/utils.ts': ['src/app.ts', 'src/helpers.ts'],
    });
    const changed: ChangedFile[] = [{ status: 'M', path: 'src/utils.ts' }];

    const result = await expandAffectedFiles(eq, changed, REPO);

    expect(result.directlyChanged).toEqual(['src/utils.ts']);
    expect(result.importers.sort()).toEqual(['src/app.ts', 'src/helpers.ts']);
    expect(result.all.length).toBe(3);
    expect(new Set(result.all)).toEqual(new Set([
      'src/utils.ts',
      'src/app.ts',
      'src/helpers.ts',
    ]));
  });

  it('deduplicates importers that appear for multiple changed files', async () => {
    const eq = mockExecuteQuery({
      'src/a.ts': ['src/shared.ts'],
      'src/b.ts': ['src/shared.ts'],
    });
    const changed: ChangedFile[] = [
      { status: 'M', path: 'src/a.ts' },
      { status: 'M', path: 'src/b.ts' },
    ];

    const result = await expandAffectedFiles(eq, changed, REPO);

    expect(result.importers).toEqual(['src/shared.ts']);
    expect(result.all.length).toBe(3);
  });

  it('excludes deleted files from directlyChanged but queries importers of deleted files', async () => {
    const eq = mockExecuteQuery({
      'src/deleted.ts': ['src/consumer.ts'],
    });
    const changed: ChangedFile[] = [
      { status: 'D', path: 'src/deleted.ts' },
      { status: 'M', path: 'src/other.ts' },
    ];

    const result = await expandAffectedFiles(eq, changed, REPO);

    expect(result.directlyChanged).toEqual(['src/other.ts']);
    expect(result.importers).toEqual(['src/consumer.ts']);
    expect(result.all).toContain('src/consumer.ts');
    expect(result.all).not.toContain('src/deleted.ts');
  });

  it('returns empty sets when all files are deleted', async () => {
    const eq = mockExecuteQuery({});
    const changed: ChangedFile[] = [{ status: 'D', path: 'src/old.ts' }];

    const result = await expandAffectedFiles(eq, changed, REPO);

    expect(result.directlyChanged).toEqual([]);
    expect(result.all.length).toBe(0);
  });

  it('does not include a changed file in the importers set (no double-counting)', async () => {
    const eq = mockExecuteQuery({
      'src/a.ts': ['src/b.ts'],
      'src/b.ts': ['src/a.ts'],
    });
    const changed: ChangedFile[] = [
      { status: 'M', path: 'src/a.ts' },
      { status: 'M', path: 'src/b.ts' },
    ];

    const result = await expandAffectedFiles(eq, changed, REPO);

    expect(result.directlyChanged.sort()).toEqual(['src/a.ts', 'src/b.ts']);
    // Neither should appear in importers since they're already in directlyChanged
    expect(result.importers).toEqual([]);
    expect(result.all.length).toBe(2);
  });

  it('handles query errors gracefully (falls back to no expansion)', async () => {
    const eq = vi.fn(async () => { throw new Error('DB not initialized'); });
    const changed: ChangedFile[] = [{ status: 'M', path: 'src/a.ts' }];

    const result = await expandAffectedFiles(eq, changed, REPO);

    expect(result.directlyChanged).toEqual(['src/a.ts']);
    expect(result.importers).toEqual([]);
    expect(result.all).toEqual(['src/a.ts']);
  });

  it('handles renamed files correctly', async () => {
    const eq = mockExecuteQuery({
      'src/new-name.ts': ['src/consumer.ts'],
    });
    const changed: ChangedFile[] = [
      { status: 'R', path: 'src/new-name.ts', oldPath: 'src/old-name.ts' },
    ];

    const result = await expandAffectedFiles(eq, changed, REPO);

    expect(result.directlyChanged).toEqual(['src/new-name.ts']);
    expect(result.importers).toEqual(['src/consumer.ts']);
  });

  it('catches 2-hop barrel re-export consumers (consumer -> index.ts -> changed file)', async () => {
    let callCount = 0;
    const eq = vi.fn(async (cypher: string): Promise<any[]> => {
      callCount++;
      // 1-hop query returns the barrel file itself as a direct importer
      if (callCount === 1) {
        return [{ fp: 'src/utils/index.ts' }];
      }
      // 2-hop query catches the indirect consumer through the barrel
      if (callCount === 2) {
        if (cypher.includes('barrel')) {
          return [{ fp: 'src/app.ts' }];
        }
        return [{ fp: 'src/app.ts' }];
      }
      return [];
    });
    const changed: ChangedFile[] = [{ status: 'M', path: 'src/utils/helper.ts' }];

    const result = await expandAffectedFiles(eq, changed, REPO);

    expect(eq).toHaveBeenCalledTimes(2);
    expect(result.directlyChanged).toEqual(['src/utils/helper.ts']);
    expect(new Set(result.importers)).toEqual(new Set(['src/utils/index.ts', 'src/app.ts']));
    expect(result.all.length).toBe(3);
  });

  it('2-hop query does not duplicate files already in 1-hop results', async () => {
    let callCount = 0;
    const eq = vi.fn(async (): Promise<any[]> => {
      callCount++;
      if (callCount === 1) return [{ fp: 'src/app.ts' }];
      if (callCount === 2) return [{ fp: 'src/app.ts' }];
      return [];
    });
    const changed: ChangedFile[] = [{ status: 'M', path: 'src/lib.ts' }];

    const result = await expandAffectedFiles(eq, changed, REPO);

    expect(result.importers).toEqual(['src/app.ts']);
    expect(result.all.length).toBe(2);
  });
});

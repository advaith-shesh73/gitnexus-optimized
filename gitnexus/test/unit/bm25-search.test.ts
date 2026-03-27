import { describe, it, expect } from 'vitest';
import { searchFTSFromLbug, type BM25SearchResult, type FTSSearchReport } from '../../src/core/search/bm25-index.js';

describe('BM25 search', () => {
  describe('searchFTSFromLbug', () => {
    it('returns empty array when LadybugDB is not initialized', async () => {
      const report = await searchFTSFromLbug('test query');
      expect(report).toHaveProperty('results');
      expect(report).toHaveProperty('tablesQueried');
      expect(report).toHaveProperty('tablesErrored');
      expect(Array.isArray(report.results)).toBe(true);
      expect(report.results).toHaveLength(0);
    });

    it('handles empty query', async () => {
      const report = await searchFTSFromLbug('');
      expect(Array.isArray(report.results)).toBe(true);
    });

    it('accepts custom limit parameter', async () => {
      const report = await searchFTSFromLbug('test', 5);
      expect(Array.isArray(report.results)).toBe(true);
    });
  });

  describe('BM25SearchResult type', () => {
    it('has correct shape', () => {
      const result: BM25SearchResult = {
        nodeId: 'fn:src/index.ts:main',
        filePath: 'src/index.ts',
        name: 'main',
        label: 'Function',
        score: 1.5,
        rank: 1,
      };
      expect(result.filePath).toBe('src/index.ts');
      expect(result.nodeId).toBe('fn:src/index.ts:main');
      expect(result.name).toBe('main');
      expect(result.label).toBe('Function');
      expect(result.score).toBe(1.5);
      expect(result.rank).toBe(1);
    });
  });
});

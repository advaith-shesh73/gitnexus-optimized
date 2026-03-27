/**
 * Hybrid Search with Reciprocal Rank Fusion (RRF)
 * 
 * Combines BM25 (keyword) and semantic (embedding) search results.
 * Uses RRF to merge rankings without needing score normalization.
 * Keyed by nodeId for symbol-level granularity (not filePath).
 */

import { searchFTSFromLbug, type BM25SearchResult } from './bm25-index.js';
import type { SemanticSearchResult } from '../embeddings/types.js';

const RRF_K = 60;

export interface HybridSearchResult {
  filePath: string;
  score: number;
  rank: number;
  sources: ('bm25' | 'semantic')[];

  nodeId?: string;
  name?: string;
  label?: string;
  startLine?: number;
  endLine?: number;

  bm25Score?: number;
  semanticScore?: number;
}

/**
 * Merge BM25 and semantic results via RRF.
 * Keyed by nodeId (falls back to filePath) so two symbols in the same file
 * retain independent scores.
 */
export const mergeWithRRF = (
  bm25Results: BM25SearchResult[],
  semanticResults: SemanticSearchResult[],
  limit: number = 10
): HybridSearchResult[] => {
  const merged = new Map<string, HybridSearchResult>();

  for (let i = 0; i < bm25Results.length; i++) {
    const r = bm25Results[i];
    const key = r.nodeId || r.filePath;
    const rrfScore = 1 / (RRF_K + i + 1);

    merged.set(key, {
      filePath: r.filePath,
      score: rrfScore,
      rank: 0,
      sources: ['bm25'],
      nodeId: r.nodeId,
      name: r.name,
      label: r.label,
      bm25Score: r.score,
    });
  }

  for (let i = 0; i < semanticResults.length; i++) {
    const r = semanticResults[i];
    const key = r.nodeId || r.filePath;
    const rrfScore = 1 / (RRF_K + i + 1);

    const existing = merged.get(key);
    if (existing) {
      existing.score += rrfScore;
      existing.sources.push('semantic');
      existing.semanticScore = 1 - r.distance;
      if (!existing.nodeId) existing.nodeId = r.nodeId;
      if (!existing.name) existing.name = r.name;
      if (!existing.label) existing.label = r.label;
      existing.startLine = r.startLine;
      existing.endLine = r.endLine;
    } else {
      merged.set(key, {
        filePath: r.filePath,
        score: rrfScore,
        rank: 0,
        sources: ['semantic'],
        semanticScore: 1 - r.distance,
        nodeId: r.nodeId,
        name: r.name,
        label: r.label,
        startLine: r.startLine,
        endLine: r.endLine,
      });
    }
  }

  const sorted = Array.from(merged.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  sorted.forEach((r, i) => { r.rank = i + 1; });
  return sorted;
};

export const isHybridSearchReady = (): boolean => true;

export const formatHybridResults = (results: HybridSearchResult[]): string => {
  if (results.length === 0) return 'No results found.';

  const formatted = results.map((r, i) => {
    const sources = r.sources.join(' + ');
    const location = r.startLine ? ` (lines ${r.startLine}-${r.endLine})` : '';
    const label = r.label ? `${r.label}: ` : 'File: ';
    const name = r.name || r.filePath.split('/').pop() || r.filePath;

    return `[${i + 1}] ${label}${name}
    File: ${r.filePath}${location}
    Found by: ${sources}
    Relevance: ${r.score.toFixed(4)}`;
  });

  return `Found ${results.length} results:\n\n${formatted.join('\n\n')}`;
};

/**
 * Execute BM25 + semantic search and merge with RRF.
 */
export const hybridSearch = async (
  query: string,
  limit: number,
  executeQuery: (cypher: string) => Promise<any[]>,
  semanticSearch: (executeQuery: (cypher: string) => Promise<any[]>, query: string, k?: number) => Promise<SemanticSearchResult[]>
): Promise<HybridSearchResult[]> => {
  const report = await searchFTSFromLbug(query, limit);
  const semanticResults = await semanticSearch(executeQuery, query, limit);
  return mergeWithRRF(report.results, semanticResults, limit);
};

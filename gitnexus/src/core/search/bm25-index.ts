/**
 * Full-Text Search via LadybugDB FTS
 *
 * Uses LadybugDB's built-in full-text search indexes for keyword-based search.
 * Always reads from the database (no cached state to drift).
 */

import { queryFTS } from '../lbug/lbug-adapter.js';
import { FTS_TABLES } from './searchable-types.js';

export interface BM25SearchResult {
  nodeId: string;
  filePath: string;
  name: string;
  label: string;
  score: number;
  rank: number;
}

export interface FTSSearchReport {
  results: BM25SearchResult[];
  tablesQueried: number;
  tablesWithResults: number;
  tablesErrored: number;
}

interface FTSHit {
  nodeId: string;
  filePath: string;
  name: string;
  label: string;
  score: number;
}

async function queryFTSViaExecutor(
  executor: (cypher: string) => Promise<any[]>,
  tableName: string,
  indexName: string,
  query: string,
  limit: number,
): Promise<FTSHit[]> {
  const escapedQuery = query.replace(/\\/g, '\\\\').replace(/'/g, "''");
  const cypher = `
    CALL QUERY_FTS_INDEX('${tableName}', '${indexName}', '${escapedQuery}', conjunctive := false)
    RETURN node, score
    ORDER BY score DESC
    LIMIT ${limit}
  `;
  const rows = await executor(cypher);
  return rows.map((row: any) => {
    const node = row.node || row[0] || {};
    const score = row.score ?? row[1] ?? 0;
    return {
      nodeId: node.id || '',
      filePath: node.filePath || '',
      name: node.name || '',
      label: tableName,
      score: typeof score === 'number' ? score : parseFloat(score) || 0,
    };
  });
}

/**
 * Search using LadybugDB's built-in FTS (always fresh, reads from disk).
 *
 * All 15 FTS tables are queried in parallel. Results are keyed by nodeId
 * (symbol-level granularity) so two different functions in the same file
 * retain independent scores.
 */
export const searchFTSFromLbug = async (query: string, limit: number = 20, repoId?: string): Promise<FTSSearchReport> => {
  let tablesErrored = 0;

  const queryOne = async (table: string, index: string): Promise<{ table: string; results: FTSHit[] }> => {
    try {
      if (repoId) {
        const { executeQuery } = await import('../../mcp/core/lbug-adapter.js');
        const executor = (cypher: string) => executeQuery(repoId, cypher);
        return { table, results: await queryFTSViaExecutor(executor, table, index, query, limit) };
      } else {
        const results = await queryFTS(table, index, query, limit, false);
        const hits: FTSHit[] = results.map((r: any) => ({
          nodeId: r.nodeId ?? r.id ?? '',
          filePath: r.filePath ?? '',
          name: r.name ?? '',
          label: table,
          score: typeof r.score === 'number' ? r.score : parseFloat(r.score) || 0,
        }));
        return { table, results: hits };
      }
    } catch {
      tablesErrored++;
      return { table, results: [] };
    }
  };

  const allResults = await Promise.all(
    FTS_TABLES.map(({ table, index }) => queryOne(table, index)),
  );

  const tablesWithResults = allResults.filter(r => r.results.length > 0).length;

  const merged = new Map<string, { nodeId: string; filePath: string; name: string; label: string; score: number }>();

  for (const { results } of allResults) {
    for (const r of results) {
      const key = r.nodeId || r.filePath;
      const existing = merged.get(key);
      if (existing) {
        existing.score += r.score;
      } else {
        merged.set(key, { nodeId: r.nodeId, filePath: r.filePath, name: r.name, label: r.label, score: r.score });
      }
    }
  }

  const sorted = Array.from(merged.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  return {
    results: sorted.map((r, index) => ({
      nodeId: r.nodeId,
      filePath: r.filePath,
      name: r.name,
      label: r.label,
      score: r.score,
      rank: index + 1,
    })),
    tablesQueried: FTS_TABLES.length,
    tablesWithResults,
    tablesErrored,
  };
};

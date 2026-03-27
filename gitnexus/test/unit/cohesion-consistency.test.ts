/**
 * Unit tests for processCommunitiesInDB.
 *
 * Uses a mock executeQuery to validate the processing logic
 * without requiring a running LadybugDB instance.
 */
import { describe, it, expect, vi } from 'vitest';
import { processCommunitiesInDB, type CommunityDetectionResult } from '../../src/core/ingestion/community-processor.js';

/**
 * Build a mock executeQuery that returns canned responses for
 * the specific Cypher patterns used by processCommunitiesInDB.
 */
function buildMockExecuteQuery(opts: {
  symbolCounts?: Record<string, number>;
  louvainRows?: Array<{ nodeId: string; communityId: number }>;
  nodeInfo?: Array<{ id: string; name: string; filePath: string; table: string }>;
  edges?: Array<{ src: string; dst: string }>;
}) {
  const symbolCounts = opts.symbolCounts ?? {};
  const louvainRows = opts.louvainRows ?? [];
  const nodeInfo = opts.nodeInfo ?? [];
  const edges = opts.edges ?? [];

  return vi.fn(async (cypher: string): Promise<any[]> => {
    // INSTALL / LOAD EXTENSION — no-op
    if (cypher.startsWith('INSTALL') || cypher.startsWith('LOAD EXTENSION')) return [];

    // Symbol count queries
    const countMatch = cypher.match(/MATCH \(n:(\w+)\) RETURN count/);
    if (countMatch) {
      return [{ cnt: symbolCounts[countMatch[1]] ?? 0 }];
    }

    // PROJECT_GRAPH / DROP_PROJECTED_GRAPH — no-op
    if (cypher.includes('PROJECT_GRAPH') || cypher.includes('DROP_PROJECTED_GRAPH')) return [];

    // Louvain
    if (cypher.includes('louvain')) {
      return louvainRows;
    }

    // Node info query
    const infoMatch = cypher.match(/MATCH \(n:(\w+)\) RETURN n\.id/);
    if (infoMatch) {
      const table = infoMatch[1];
      return nodeInfo
        .filter(n => n.table === table)
        .map(n => ({ id: n.id, name: n.name, filePath: n.filePath }));
    }

    // Edge queries for cohesion
    if (cypher.includes('CodeRelation') && cypher.includes('RETURN a.id AS src')) {
      return edges;
    }

    // CREATE Community node
    if (cypher.includes('CREATE (:Community')) return [];

    // CREATE MEMBER_OF edge
    if (cypher.includes('MEMBER_OF')) return [];

    return [];
  });
}

describe('processCommunitiesInDB', () => {
  it('returns empty result when no symbol nodes exist', async () => {
    const mockExec = buildMockExecuteQuery({});
    const result = await processCommunitiesInDB(mockExec);

    expect(result.communities).toEqual([]);
    expect(result.memberships).toEqual([]);
    expect(result.stats.totalCommunities).toBe(0);
    expect(result.stats.nodesProcessed).toBe(0);
  });

  it('creates communities from Louvain results and skips singletons', async () => {
    const mockExec = buildMockExecuteQuery({
      symbolCounts: { Function: 5, Class: 0, Method: 0, Interface: 0 },
      louvainRows: [
        { nodeId: 'fn:a', communityId: 0 },
        { nodeId: 'fn:b', communityId: 0 },
        { nodeId: 'fn:c', communityId: 0 },
        { nodeId: 'fn:d', communityId: 1 },
        { nodeId: 'fn:e', communityId: 2 }, // singleton — should be skipped
      ],
      nodeInfo: [
        { id: 'fn:a', name: 'handleRequest', filePath: '/src/api/handler.ts', table: 'Function' },
        { id: 'fn:b', name: 'validateInput', filePath: '/src/api/validator.ts', table: 'Function' },
        { id: 'fn:c', name: 'formatResponse', filePath: '/src/api/formatter.ts', table: 'Function' },
        { id: 'fn:d', name: 'parseConfig', filePath: '/src/config/parser.ts', table: 'Function' },
        { id: 'fn:e', name: 'utils', filePath: '/src/utils/index.ts', table: 'Function' },
      ],
      edges: [],
    });

    const result = await processCommunitiesInDB(mockExec);

    // Only community 0 has >=2 members (3 members), community 1 has 1, community 2 has 1
    expect(result.communities).toHaveLength(1);
    expect(result.communities[0].symbolCount).toBe(3);
    expect(result.communities[0].id).toBe('comm_0');
    expect(result.communities[0].heuristicLabel).toBe('Api');

    // All 5 nodes get memberships (singletons included for skill-gen file clustering)
    expect(result.memberships).toHaveLength(5);
    expect(result.stats.totalCommunities).toBe(1);
    expect(result.stats.nodesProcessed).toBe(5);
  });

  it('produces multiple communities with correct heuristic labels', async () => {
    const mockExec = buildMockExecuteQuery({
      symbolCounts: { Function: 4, Class: 2, Method: 0, Interface: 0 },
      louvainRows: [
        { nodeId: 'fn:a', communityId: 0 },
        { nodeId: 'fn:b', communityId: 0 },
        { nodeId: 'fn:c', communityId: 0 },
        { nodeId: 'cls:x', communityId: 1 },
        { nodeId: 'cls:y', communityId: 1 },
        { nodeId: 'fn:d', communityId: 1 },
      ],
      nodeInfo: [
        { id: 'fn:a', name: 'parse', filePath: '/src/ingestion/parser.ts', table: 'Function' },
        { id: 'fn:b', name: 'transform', filePath: '/src/ingestion/transform.ts', table: 'Function' },
        { id: 'fn:c', name: 'load', filePath: '/src/ingestion/loader.ts', table: 'Function' },
        { id: 'fn:d', name: 'queryGraph', filePath: '/src/query/graph.ts', table: 'Function' },
        { id: 'cls:x', name: 'QueryEngine', filePath: '/src/query/engine.ts', table: 'Class' },
        { id: 'cls:y', name: 'QueryParser', filePath: '/src/query/parser.ts', table: 'Class' },
      ],
      edges: [],
    });

    const result = await processCommunitiesInDB(mockExec);

    expect(result.communities).toHaveLength(2);
    // Sorted by size descending — both have 3 members so order may vary
    const labels = result.communities.map(c => c.heuristicLabel).sort();
    expect(labels).toEqual(['Ingestion', 'Query']);
    expect(result.memberships).toHaveLength(6);
  });

  it('falls back to file-based clustering when Louvain fails, still cleans up projection', async () => {
    const calls: string[] = [];
    const mockExec = vi.fn(async (cypher: string): Promise<any[]> => {
      calls.push(cypher);
      if (cypher.startsWith('INSTALL') || cypher.startsWith('LOAD EXTENSION')) return [];
      if (cypher.includes('count(n)')) return [{ cnt: 10 }];
      if (cypher.includes('PROJECT_GRAPH') && !cypher.includes('DROP')) return [];
      if (cypher.includes('louvain')) throw new Error('Louvain failed');
      if (cypher.includes('DROP_PROJECTED_GRAPH')) return [];
      if (cypher.match(/MATCH \(n:(\w+)\) RETURN n\.id/)) return [];
      return [];
    });

    const result = await processCommunitiesInDB(mockExec);

    // Louvain error is caught — function resolves with empty fallback
    expect(result.communities).toEqual([]);
    expect(result.memberships).toEqual([]);
    expect(result.stats.nodesProcessed).toBe(40);

    // Verify DROP_PROJECTED_GRAPH was still called in the finally block
    expect(calls.some(c => c.includes('DROP_PROJECTED_GRAPH'))).toBe(true);
  });

  it('returns cohesion 1.0 when there are no edges', async () => {
    const mockExec = buildMockExecuteQuery({
      symbolCounts: { Function: 4, Class: 0, Method: 0, Interface: 0 },
      louvainRows: [
        { nodeId: 'fn:a', communityId: 0 },
        { nodeId: 'fn:b', communityId: 0 },
        { nodeId: 'fn:c', communityId: 0 },
        { nodeId: 'fn:d', communityId: 0 },
      ],
      nodeInfo: [
        { id: 'fn:a', name: 'a', filePath: '/src/group/a.ts', table: 'Function' },
        { id: 'fn:b', name: 'b', filePath: '/src/group/b.ts', table: 'Function' },
        { id: 'fn:c', name: 'c', filePath: '/src/group/c.ts', table: 'Function' },
        { id: 'fn:d', name: 'd', filePath: '/src/group/d.ts', table: 'Function' },
      ],
      edges: [],
    });

    const result = await processCommunitiesInDB(mockExec);
    expect(result.communities[0].cohesion).toBe(1.0);
  });
});

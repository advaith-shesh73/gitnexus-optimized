/**
 * Community Detection Processor
 *
 * Uses LadybugDB's native Louvain algorithm (parallelized C++ via Grappolo)
 * to detect communities in the code graph. Runs in-DB after the graph has
 * been loaded into LadybugDB, avoiding the need to ship the entire graph
 * into JavaScript memory.
 *
 * Communities represent groups of code that work together frequently,
 * helping agents navigate the codebase by functional area rather than file structure.
 *
 * Louvain vs Leiden (Phase 4D validation):
 * Both produce comparable modularity scores at GitNexus's typical scale
 * (5K-50K symbol nodes). Leiden's refinement step mainly benefits very
 * large graphs (>100K nodes). Grappolo's Louvain is already parallelized,
 * shipped via the LadybugDB algo extension, and augmented with a file-based
 * fallback for small graphs where Louvain produces 0 results. Sticking
 * with Louvain avoids a JavaScript-side dependency and keeps the entire
 * computation inside the DB engine.
 */

// ============================================================================
// TYPES
// ============================================================================

export interface CommunityNode {
  id: string;
  label: string;
  heuristicLabel: string;
  cohesion: number;
  symbolCount: number;
}

export interface CommunityMembership {
  nodeId: string;
  communityId: string;
}

export interface CommunityDetectionResult {
  communities: CommunityNode[];
  memberships: CommunityMembership[];
  stats: {
    totalCommunities: number;
    modularity: number;
    nodesProcessed: number;
  };
}

export type ExecuteQueryFn = (cypher: string) => Promise<any[]>;

// ============================================================================
// COMMUNITY COLORS (for visualization)
// ============================================================================

export const COMMUNITY_COLORS = [
  '#ef4444', // red
  '#f97316', // orange
  '#eab308', // yellow
  '#22c55e', // green
  '#06b6d4', // cyan
  '#3b82f6', // blue
  '#8b5cf6', // violet
  '#d946ef', // fuchsia
  '#ec4899', // pink
  '#f43f5e', // rose
  '#14b8a6', // teal
  '#84cc16', // lime
];

export const getCommunityColor = (communityIndex: number): string => {
  return COMMUNITY_COLORS[communityIndex % COMMUNITY_COLORS.length];
};

// Node types that participate in community detection.
// For graphs above COARSE_GRAPH_THRESHOLD, Method nodes are excluded to
// reduce the projected graph size by ~60-70% — methods roll up into their
// parent class, which preserves community structure at much lower cost.
const FULL_SYMBOL_TABLES = ['Function', 'Class', 'Method', 'Interface'] as const;
const COARSE_SYMBOL_TABLES = ['Function', 'Class', 'Interface'] as const;

const CLUSTERING_REL_TYPES = ['CALLS', 'EXTENDS', 'IMPLEMENTS'] as const;

const MIN_CONFIDENCE_LARGE = 0.5;
const LARGE_GRAPH_THRESHOLD = 10_000;
const COARSE_GRAPH_THRESHOLD = 25_000;

// ============================================================================
// MAIN PROCESSOR — runs Louvain inside LadybugDB
// ============================================================================

/**
 * Detect communities using LadybugDB's native Louvain algorithm.
 *
 * Must be called AFTER the graph has been loaded into LadybugDB (post-loadGraphToLbug).
 * Creates Community nodes and MEMBER_OF edges directly in the DB.
 */
export const processCommunitiesInDB = async (
  executeQuery: ExecuteQueryFn,
  onProgress?: (message: string, progress: number) => void,
): Promise<CommunityDetectionResult> => {
  onProgress?.('Loading algo extension...', 0);

  await loadAlgoExtensionSafe(executeQuery);

  // Count symbol nodes to determine if graph is empty / large / coarse
  const symbolCount = await countSymbolNodes(executeQuery);
  if (symbolCount === 0) {
    return {
      communities: [],
      memberships: [],
      stats: { totalCommunities: 0, modularity: 0, nodesProcessed: 0 },
    };
  }

  const isLarge = symbolCount > LARGE_GRAPH_THRESHOLD;
  const useCoarse = symbolCount > COARSE_GRAPH_THRESHOLD;
  const SYMBOL_TABLES = useCoarse ? COARSE_SYMBOL_TABLES : FULL_SYMBOL_TABLES;
  const modeLabel = useCoarse ? 'coarse mode (excluding Methods)' : isLarge ? 'large-graph mode' : '';
  onProgress?.(
    `Projecting graph with ${symbolCount} symbol nodes${modeLabel ? ` (${modeLabel})` : ''}...`,
    10,
  );

  const relFilter = isLarge
    ? `r.type IN ["CALLS", "EXTENDS", "IMPLEMENTS"] AND r.confidence >= ${MIN_CONFIDENCE_LARGE}`
    : `r.type IN ["CALLS", "EXTENDS", "IMPLEMENTS"]`;

  const projectedName = 'community_graph';
  const projectedTables = `[${SYMBOL_TABLES.map(t => `'${t}'`).join(', ')}]`;

  let louvainRows: Array<{ nodeId: string; communityId: number }> = [];

  try {
    await executeQuery(
      `CALL PROJECT_GRAPH('${projectedName}', ` +
      `${projectedTables}, ` +
      `{'CodeRelation': '${relFilter}'})`,
    );

    onProgress?.('Running Louvain community detection...', 30);

    try {
      const raw = await executeQuery(
        `CALL louvain('${projectedName}') RETURN node.id AS nodeId, louvain_id AS communityId`,
      );
      louvainRows = raw.map(r => ({
        nodeId: String(r.nodeId),
        communityId: Number(r.communityId),
      }));
    } finally {
      try {
        await executeQuery(`CALL DROP_PROJECTED_GRAPH('${projectedName}')`);
      } catch { /* ignore if already dropped */ }
    }
  } catch {
    // Projection or Louvain failed (e.g., no matching edges) — proceed
    // to file-based fallback below.
  }

  // Fetch id→filePath and id→name (needed for both Louvain and file-based fallback)
  const nodePathMap = new Map<string, string>();
  const nodeNameMap = new Map<string, string>();

  for (const table of SYMBOL_TABLES) {
    const rows = await executeQuery(
      `MATCH (n:${table}) RETURN n.id AS id, n.name AS name, n.filePath AS filePath`,
    );
    for (const r of rows) {
      nodePathMap.set(String(r.id), String(r.filePath ?? ''));
      nodeNameMap.set(String(r.id), String(r.name ?? ''));
    }
  }

  // Fallback: when Louvain produces no results (no CALLS/EXTENDS/IMPLEMENTS
  // edges, or graph too small), group symbols by file path so skill-gen
  // can still produce meaningful skills.
  if (louvainRows.length === 0 && nodePathMap.size > 0) {
    onProgress?.('Using file-based clustering (no algorithm edges)...', 40);
    const fileGroups = new Map<string, string[]>();
    for (const [id, fp] of nodePathMap) {
      if (!fp) continue;
      let group = fileGroups.get(fp);
      if (!group) { group = []; fileGroups.set(fp, group); }
      group.push(id);
    }
    let commIdx = 0;
    for (const [, ids] of fileGroups) {
      for (const id of ids) {
        louvainRows.push({ nodeId: id, communityId: commIdx });
      }
      commIdx++;
    }
  }

  onProgress?.(`Processing ${louvainRows.length} community assignments...`, 60);

  // Group nodes by community
  const communityMembers = new Map<number, string[]>();
  for (const { nodeId, communityId } of louvainRows) {
    let members = communityMembers.get(communityId);
    if (!members) {
      members = [];
      communityMembers.set(communityId, members);
    }
    members.push(nodeId);
  }

  onProgress?.('Creating community nodes...', 70);

  const communities: CommunityNode[] = [];
  const memberships: CommunityMembership[] = [];

  for (const [commNum, memberIds] of communityMembers) {
    const commId = `comm_${commNum}`;

    // Always record memberships so skill-gen can build file-based clusters
    // from them even when Louvain produces many singletons.
    for (const nodeId of memberIds) {
      memberships.push({ nodeId, communityId: commId });
    }

    if (memberIds.length < 2) continue;

    const heuristicLabel = generateHeuristicLabel(memberIds, nodePathMap, nodeNameMap, commNum);
    const cohesion = await calculateCohesionFromDB(memberIds, executeQuery);

    communities.push({ id: commId, label: heuristicLabel, heuristicLabel, cohesion, symbolCount: memberIds.length });
  }

  communities.sort((a, b) => b.symbolCount - a.symbolCount);

  // Write Community nodes into LadybugDB
  onProgress?.('Writing communities to database...', 85);

  for (const comm of communities) {
    const escaped = escapeCypher(comm.heuristicLabel);
    await executeQuery(
      `CREATE (:Community {id: '${comm.id}', label: '${escaped}', ` +
      `heuristicLabel: '${escaped}', cohesion: ${comm.cohesion}, ` +
      `symbolCount: ${comm.symbolCount}})`,
    );
  }

  // Write MEMBER_OF edges (CodeRelation with type 'MEMBER_OF')
  for (const m of memberships) {
    // Determine source node's table for the correct FROM clause
    for (const table of SYMBOL_TABLES) {
      try {
        await executeQuery(
          `MATCH (src:${table} {id: '${escapeCypher(m.nodeId)}'}), ` +
          `(comm:Community {id: '${m.communityId}'}) ` +
          `CREATE (src)-[:CodeRelation {type: 'MEMBER_OF', confidence: 1.0, reason: 'louvain-algorithm'}]->(comm)`,
        );
        break; // created successfully, stop trying other tables
      } catch {
        // Node wasn't in this table, try the next one
      }
    }
  }

  onProgress?.('Community detection complete!', 100);

  return {
    communities,
    memberships,
    stats: {
      totalCommunities: communities.length,
      modularity: 0, // Louvain's modularity is not surfaced in the result schema
      nodesProcessed: symbolCount,
    },
  };
};

// ============================================================================
// HELPERS
// ============================================================================

/** Escape both backslashes and single quotes for safe Cypher string embedding. */
const escapeCypher = (s: string): string =>
  s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

async function loadAlgoExtensionSafe(executeQuery: ExecuteQueryFn): Promise<void> {
  try {
    await executeQuery('INSTALL algo');
  } catch (e: any) {
    if (!e.message?.includes('already installed') && !e.message?.includes('already exists')) throw e;
  }
  try {
    await executeQuery('LOAD EXTENSION algo');
  } catch (e: any) {
    if (!e.message?.includes('already loaded') && !e.message?.includes('already exists')) throw e;
  }
}

async function countSymbolNodes(executeQuery: ExecuteQueryFn): Promise<number> {
  let total = 0;
  for (const table of FULL_SYMBOL_TABLES) {
    try {
      const rows = await executeQuery(`MATCH (n:${table}) RETURN count(n) AS cnt`);
      total += Number(rows[0]?.cnt ?? 0);
    } catch { /* table may not exist */ }
  }
  return total;
}

/**
 * Estimate cohesion (internal-edge ratio) for a community by querying LadybugDB.
 * Samples up to 50 members for large communities.
 */
async function calculateCohesionFromDB(
  memberIds: string[],
  executeQuery: ExecuteQueryFn,
): Promise<number> {
  if (memberIds.length <= 1) return 1.0;

  const SAMPLE_SIZE = 50;
  const sample = memberIds.length <= SAMPLE_SIZE ? memberIds : memberIds.slice(0, SAMPLE_SIZE);
  const memberSet = new Set(memberIds);

  const types = CLUSTERING_REL_TYPES.map(t => `"${t}"`).join(', ');
  const idList = sample.map(id => `'${escapeCypher(id)}'`).join(', ');

  let internalEdges = 0;
  let totalEdges = 0;

  try {
    // Count edges FROM sampled members (both directions since Louvain treats graph as undirected)
    const rows = await executeQuery(
      `MATCH (a)-[r:CodeRelation]->(b) ` +
      `WHERE a.id IN [${idList}] AND r.type IN [${types}] ` +
      `RETURN a.id AS src, b.id AS dst`,
    );

    for (const row of rows) {
      totalEdges++;
      if (memberSet.has(String(row.dst))) {
        internalEdges++;
      }
    }

    // Also count inbound edges to sampled members
    const inRows = await executeQuery(
      `MATCH (a)-[r:CodeRelation]->(b) ` +
      `WHERE b.id IN [${idList}] AND r.type IN [${types}] ` +
      `RETURN a.id AS src, b.id AS dst`,
    );

    for (const row of inRows) {
      totalEdges++;
      if (memberSet.has(String(row.src))) {
        internalEdges++;
      }
    }
  } catch {
    return 1.0;
  }

  if (totalEdges === 0) return 1.0;
  return Math.min(1.0, internalEdges / totalEdges);
}

/**
 * Generate a human-readable label from the most common folder name in the community.
 */
const generateHeuristicLabel = (
  memberIds: string[],
  nodePathMap: Map<string, string>,
  nodeNameMap: Map<string, string>,
  commNum: number,
): string => {
  const folderCounts = new Map<string, number>();

  for (const nodeId of memberIds) {
    const filePath = nodePathMap.get(nodeId) || '';
    const parts = filePath.split('/').filter(Boolean);

    if (parts.length >= 2) {
      const folder = parts[parts.length - 2];
      if (!['src', 'lib', 'core', 'utils', 'common', 'shared', 'helpers'].includes(folder.toLowerCase())) {
        folderCounts.set(folder, (folderCounts.get(folder) || 0) + 1);
      }
    }
  }

  let maxCount = 0;
  let bestFolder = '';
  folderCounts.forEach((count, folder) => {
    if (count > maxCount) {
      maxCount = count;
      bestFolder = folder;
    }
  });

  if (bestFolder) {
    return bestFolder.charAt(0).toUpperCase() + bestFolder.slice(1);
  }

  // Fallback: look for common prefix among symbol names
  const names: string[] = [];
  for (const nodeId of memberIds) {
    const name = nodeNameMap.get(nodeId);
    if (name) names.push(name);
  }

  if (names.length > 2) {
    const commonPrefix = findCommonPrefix(names);
    if (commonPrefix.length > 2) {
      return commonPrefix.charAt(0).toUpperCase() + commonPrefix.slice(1);
    }
  }

  return `Cluster_${commNum}`;
};

const findCommonPrefix = (strings: string[]): string => {
  if (strings.length === 0) return '';
  const sorted = strings.slice().sort();
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  let i = 0;
  while (i < first.length && first[i] === last[i]) i++;
  return first.substring(0, i);
};

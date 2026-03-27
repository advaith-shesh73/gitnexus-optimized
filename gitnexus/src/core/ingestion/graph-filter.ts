/**
 * Graph filtering utilities for incremental reindex.
 *
 * Extracted from cli/analyze.ts so that tests and other consumers
 * can import the filter without pulling in the entire CLI entry point.
 */
import type { KnowledgeGraph } from '../graph/types.js';

/**
 * Remove every node whose filePath is NOT in the affected set.
 *
 * After the incremental pipeline re-parses only the affected files,
 * the resulting in-memory graph may contain nodes that were pulled in
 * by the full pipeline (e.g. type references to files that already
 * exist in the DB).
 *
 * Cross-file edges are preserved when BOTH endpoints satisfy one of:
 *   (a) the node is in the affected set (will be re-inserted), OR
 *   (b) the node's ID is deterministic and already exists in the DB
 *       (i.e. the other endpoint was NOT deleted).
 *
 * Node IDs are deterministic (`Label:filePath:name`), so an edge from
 * an unaffected node A to an affected node B uses the same ID that A
 * already has in the DB. COPY will insert the edge referencing both IDs.
 *
 * IMPORTANT: We only keep edges where at least one endpoint is a kept
 * node (affected file). Edges between two removed nodes are dropped.
 * Edges where the non-kept endpoint references a node that should exist
 * in the DB are preserved — correctness depends on deterministic IDs.
 */
export function filterGraphForIncremental(graph: KnowledgeGraph, affectedFilePaths: Set<string>): void {
  const keepNodeIds = new Set<string>();
  graph.forEachNode(node => {
    const fp = node.properties?.filePath;
    if (fp && affectedFilePaths.has(fp)) {
      keepNodeIds.add(node.id);
    }
  });

  const relsToRestore: Array<{ id: string; sourceId: string; targetId: string; type: any; confidence: number; reason: string; step?: number }> = [];
  graph.forEachRelationship(rel => {
    if (keepNodeIds.has(rel.sourceId) || keepNodeIds.has(rel.targetId)) {
      relsToRestore.push({ ...rel });
    }
  });

  const idsToRemove: string[] = [];
  graph.forEachNode(node => {
    if (keepNodeIds.has(node.id)) return;
    idsToRemove.push(node.id);
  });
  for (const id of idsToRemove) {
    graph.removeNode(id);
  }

  for (const rel of relsToRestore) {
    graph.addRelationship(rel);
  }
}

/**
 * C# Partial Class Linker
 *
 * C# allows splitting a class across multiple files using the `partial`
 * keyword.  Each file creates a separate Class node in the graph with no
 * edges linking them.  This means:
 *   - Impact analysis for "UserService" misses half the methods
 *   - Process detection can't trace across partial boundaries
 *   - Queries return fragmented results
 *
 * This post-processing pass:
 *   1. Groups Class nodes by qualified name (namespace.ClassName) within .cs files
 *   2. When multiple Class nodes share the same qualified name, designates the
 *      first (by file path sort) as canonical and creates bidirectional
 *      PARTIAL_OF edges from the others
 *   3. Propagates CALLS adjacency across partials in process detection via
 *      PARTIAL_OF edge handling in buildCallsGraph/buildReverseCallsGraph
 */

import type { KnowledgeGraph, GraphRelationship } from '../graph/types.js';
import { generateId } from '../../lib/utils.js';

/**
 * Extract the qualified class name from a node ID.
 * Node ID format: `Class:path/to/file.cs:Namespace.ClassName`
 */
function extractQualifiedName(nodeId: string, filePath: string): string | null {
  const labelEnd = nodeId.indexOf(':');
  if (labelEnd < 0) return null;
  const afterLabel = nodeId.slice(labelEnd + 1);
  if (!afterLabel.startsWith(filePath)) return null;
  const rest = afterLabel.slice(filePath.length);
  if (rest.startsWith(':')) return rest.slice(1);
  return rest || null;
}

export function linkCSharpPartials(graph: KnowledgeGraph): number {
  // Group Class nodes from .cs files by qualified name
  const classesByQName = new Map<string, { id: string; filePath: string }[]>();

  for (const node of graph.iterNodes()) {
    if (node.label !== 'Class') continue;
    const fp = node.properties.filePath;
    if (!fp || !fp.endsWith('.cs')) continue;

    const qname = extractQualifiedName(node.id, fp);
    if (!qname) continue;

    let group = classesByQName.get(qname);
    if (!group) { group = []; classesByQName.set(qname, group); }
    group.push({ id: node.id, filePath: fp });
  }

  let edgesAdded = 0;

  for (const [, group] of classesByQName) {
    if (group.length < 2) continue;

    // Sort by filePath for deterministic canonical selection
    group.sort((a, b) => a.filePath.localeCompare(b.filePath));
    const canonical = group[0];

    for (let i = 1; i < group.length; i++) {
      const partial = group[i];

      const toCanonical: GraphRelationship = {
        id: generateId('PARTIAL_OF', `${partial.id}->${canonical.id}`),
        sourceId: partial.id,
        targetId: canonical.id,
        type: 'PARTIAL_OF',
        confidence: 1.0,
        reason: 'csharp-partial-class',
      };

      const fromCanonical: GraphRelationship = {
        id: generateId('PARTIAL_OF', `${canonical.id}->${partial.id}`),
        sourceId: canonical.id,
        targetId: partial.id,
        type: 'PARTIAL_OF',
        confidence: 1.0,
        reason: 'csharp-partial-class',
      };

      graph.addRelationship(toCanonical);
      graph.addRelationship(fromCanonical);
      edgesAdded += 2;
    }
  }

  return edgesAdded;
}

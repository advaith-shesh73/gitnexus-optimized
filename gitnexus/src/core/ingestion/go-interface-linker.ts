/**
 * Go Structural Interface Satisfaction Linker
 *
 * Go uses structural typing — a struct satisfies an interface if it has all
 * the required methods, with no explicit "implements" keyword.  The heritage
 * processor only recognises explicit keywords, so Go IMPLEMENTS edges are
 * never created.
 *
 * This post-processing pass:
 *   1. Collects Interface nodes (from .go files) and their Method children
 *   2. Collects Struct nodes (from .go files) and their Method children
 *   3. Builds an inverted index: methodName → Set<structId>
 *   4. For each interface, intersects method-name sets to find satisfying structs
 *   5. Creates IMPLEMENTS edges (confidence 0.85 — name-only, no signature check)
 *
 * Skips empty interfaces (satisfied by everything — no useful signal).
 */

import type { KnowledgeGraph, GraphRelationship } from '../graph/types.js';
import { generateId } from '../../lib/utils.js';

export function linkGoInterfaces(graph: KnowledgeGraph): number {
  const methodsByOwner = new Map<string, Set<string>>();

  for (const node of graph.iterNodes()) {
    if (node.label !== 'Method') continue;
    const ownerId = node.properties.ownerId;
    const name = node.properties.name;
    if (!ownerId || !name) continue;
    let set = methodsByOwner.get(ownerId);
    if (!set) { set = new Set(); methodsByOwner.set(ownerId, set); }
    set.add(name);
  }

  const interfaces: { id: string; methods: Set<string> }[] = [];
  const structIds: string[] = [];

  for (const node of graph.iterNodes()) {
    const fp = node.properties.filePath;
    if (!fp || !fp.endsWith('.go')) continue;

    if (node.label === 'Interface') {
      const methods = methodsByOwner.get(node.id);
      if (methods && methods.size > 0) {
        interfaces.push({ id: node.id, methods });
      }
    } else if (node.label === 'Struct') {
      if (methodsByOwner.has(node.id)) {
        structIds.push(node.id);
      }
    }
  }

  if (interfaces.length === 0 || structIds.length === 0) return 0;

  // Inverted index: methodName → Set<structId>
  const structsByMethod = new Map<string, Set<string>>();
  for (const sid of structIds) {
    const methods = methodsByOwner.get(sid)!;
    for (const m of methods) {
      let set = structsByMethod.get(m);
      if (!set) { set = new Set(); structsByMethod.set(m, set); }
      set.add(sid);
    }
  }

  let edgesAdded = 0;

  for (const iface of interfaces) {
    const methodNames = [...iface.methods];
    let candidates = structsByMethod.get(methodNames[0]);
    if (!candidates) continue;
    candidates = new Set(candidates);

    for (let i = 1; i < methodNames.length; i++) {
      const set = structsByMethod.get(methodNames[i]);
      if (!set) { candidates.clear(); break; }
      for (const id of candidates) {
        if (!set.has(id)) candidates.delete(id);
      }
      if (candidates.size === 0) break;
    }

    for (const structId of candidates) {
      const edge: GraphRelationship = {
        id: generateId('IMPLEMENTS', `${structId}->${iface.id}`),
        sourceId: structId,
        targetId: iface.id,
        type: 'IMPLEMENTS',
        confidence: 0.85,
        reason: 'go-structural-interface-satisfaction',
      };
      graph.addRelationship(edge);
      edgesAdded++;
    }
  }

  return edgesAdded;
}

/**
 * Rust Trait Implementation Linker
 *
 * Rust separates trait definitions from implementations (`impl Trait for Struct`),
 * often across files.  The heritage processor may not create IMPLEMENTS edges
 * because it primarily looks for explicit extends/implements keywords in
 * tree-sitter heritage queries.
 *
 * This post-processing pass uses the same method-name-set approach as the
 * Go interface linker:
 *   1. Collect Trait nodes (.rs files) and their Method children
 *   2. Collect Struct nodes (.rs files) and their Method children
 *   3. Match by method-name superset (confidence 0.85)
 *
 * This is a heuristic — Rust allows multiple traits with the same method name
 * on the same struct, which this doesn't disambiguate.  The 0.85 confidence
 * signals consumers that these edges are inferred, not syntactic.
 *
 * Edges that duplicate existing IMPLEMENTS relationships (from heritage
 * processor) are idempotent via generateId.
 */

import type { KnowledgeGraph, GraphRelationship } from '../graph/types.js';
import { generateId } from '../../lib/utils.js';

export function linkRustTraitImpls(graph: KnowledgeGraph): number {
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

  const traits: { id: string; methods: Set<string> }[] = [];
  const structIds: string[] = [];

  for (const node of graph.iterNodes()) {
    const fp = node.properties.filePath;
    if (!fp || !fp.endsWith('.rs')) continue;

    if (node.label === 'Trait') {
      const methods = methodsByOwner.get(node.id);
      if (methods && methods.size > 0) {
        traits.push({ id: node.id, methods });
      }
    } else if (node.label === 'Struct') {
      if (methodsByOwner.has(node.id)) {
        structIds.push(node.id);
      }
    }
  }

  if (traits.length === 0 || structIds.length === 0) return 0;

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

  // Check for pre-existing IMPLEMENTS edges so we only count genuinely new ones
  const existingImpl = new Set<string>();
  for (const rel of graph.iterRelationships()) {
    if (rel.type === 'IMPLEMENTS') {
      existingImpl.add(`${rel.sourceId}->${rel.targetId}`);
    }
  }

  for (const trait of traits) {
    const methodNames = [...trait.methods];
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
      const pairKey = `${structId}->${trait.id}`;
      if (existingImpl.has(pairKey)) continue;

      const edge: GraphRelationship = {
        id: generateId('IMPLEMENTS', pairKey),
        sourceId: structId,
        targetId: trait.id,
        type: 'IMPLEMENTS',
        confidence: 0.85,
        reason: 'rust-trait-method-set-match',
      };
      graph.addRelationship(edge);
      edgesAdded++;
    }
  }

  return edgesAdded;
}

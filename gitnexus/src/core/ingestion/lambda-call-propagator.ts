/**
 * Lambda / Anonymous Class Call Propagator
 *
 * Anonymous classes and lambdas create invisible call paths:
 *
 *   executor.submit(() -> db.connect());    // Java lambda
 *   service.execute(new Runnable() {        // Java anonymous class
 *     public void run() { db.connect(); }
 *   });
 *
 * The `db.connect()` call is attributed to the lambda/anonymous scope, which
 * has no external callers.  Process detection can't trace through it.
 *
 * This post-processing pass:
 *   1. Finds Function/Method nodes whose name matches anonymous patterns
 *      (lambda$..., anonymous, <anonymous>, __anon, or contains "$lambda$")
 *   2. Finds their CALLS edges (outgoing)
 *   3. Locates the nearest enclosing named function in the same file
 *      (by line range containment)
 *   4. Propagates the anonymous node's CALLS to the enclosing function
 *
 * This is a heuristic — line-range containment assumes the enclosing
 * function's startLine/endLine brackets the lambda.  Confidence 0.75
 * signals that these are inferred, not syntactic.
 */

import type { KnowledgeGraph, GraphRelationship } from '../graph/types.js';
import { generateId } from '../../lib/utils.js';

const ANON_PATTERNS = [
  /^lambda\$/,
  /\$lambda\$/,
  /^<lambda>/,
  /^anonymous$/i,
  /^<anonymous>$/,
  /^__anon/,
  /^\(anonymous\)$/,
  /^lambda\d*$/,
];

function isAnonymousName(name: string): boolean {
  return ANON_PATTERNS.some(p => p.test(name));
}

export function propagateLambdaCalls(graph: KnowledgeGraph): number {
  // Step 1: Collect named functions grouped by (filePath, line range)
  interface NamedFn { id: string; startLine: number; endLine: number }
  const namedByFile = new Map<string, NamedFn[]>();

  // Step 2: Collect anonymous functions with their outgoing CALLS
  interface AnonFn { id: string; filePath: string; startLine: number; endLine: number }
  const anonFunctions: AnonFn[] = [];

  for (const node of graph.iterNodes()) {
    if (node.label !== 'Function' && node.label !== 'Method') continue;
    const fp = node.properties.filePath;
    const start = node.properties.startLine;
    const end = node.properties.endLine;
    if (!fp || start == null || end == null) continue;

    if (isAnonymousName(node.properties.name)) {
      anonFunctions.push({ id: node.id, filePath: fp, startLine: start, endLine: end });
    } else {
      let list = namedByFile.get(fp);
      if (!list) { list = []; namedByFile.set(fp, list); }
      list.push({ id: node.id, startLine: start, endLine: end });
    }
  }

  if (anonFunctions.length === 0) return 0;

  // Build CALLS adjacency from the graph
  const callsFrom = new Map<string, string[]>();
  for (const rel of graph.iterRelationships()) {
    if (rel.type !== 'CALLS') continue;
    let targets = callsFrom.get(rel.sourceId);
    if (!targets) { targets = []; callsFrom.set(rel.sourceId, targets); }
    targets.push(rel.targetId);
  }

  // Sort named functions by line range (narrowest encloser = best match)
  for (const [, fns] of namedByFile) {
    fns.sort((a, b) => (a.endLine - a.startLine) - (b.endLine - b.startLine));
  }

  let edgesAdded = 0;

  for (const anon of anonFunctions) {
    const anonCallees = callsFrom.get(anon.id);
    if (!anonCallees || anonCallees.length === 0) continue;

    const namedFns = namedByFile.get(anon.filePath);
    if (!namedFns) continue;

    // Find the narrowest enclosing named function
    let encloser: NamedFn | null = null;
    for (const fn of namedFns) {
      if (fn.startLine <= anon.startLine && fn.endLine >= anon.endLine) {
        encloser = fn;
        break;
      }
    }

    if (!encloser) continue;

    for (const calleeId of anonCallees) {
      const edge: GraphRelationship = {
        id: generateId('CALLS', `${encloser.id}->${calleeId}[lambda-prop]`),
        sourceId: encloser.id,
        targetId: calleeId,
        type: 'CALLS',
        confidence: 0.75,
        reason: 'lambda-call-propagation',
      };
      graph.addRelationship(edge);
      edgesAdded++;
    }
  }

  return edgesAdded;
}

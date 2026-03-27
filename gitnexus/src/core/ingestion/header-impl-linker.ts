/**
 * C/C++ Header-Implementation Linker
 *
 * Post-processing pass that creates DECLARES/DEFINED_BY edges between
 * matching symbol nodes in header (.h, .hpp) and implementation (.c, .cc,
 * .cpp, .cxx) files.
 *
 * Matching strategy:
 *   - Group nodes by (normalizedBasename, qualifiedName).
 *   - normalizedBasename strips common impl suffixes (_impl, _internal, etc.)
 *     and ignores directory structure, so `include/minerva/store.h` matches
 *     `src/minerva/store.cc` and `store_impl.cc`.
 *   - qualifiedName is everything after Label:filePath: in the node ID
 *     (e.g. "Namespace::Class::Method").
 */

import type { KnowledgeGraph, GraphRelationship } from '../graph/types.js';
import { generateId } from '../../lib/utils.js';

const HEADER_EXTS = new Set(['.h', '.hh', '.hpp', '.hxx', '.h++']);
const IMPL_EXTS = new Set(['.c', '.cc', '.cpp', '.cxx', '.c++']);

const LINKABLE_LABELS = new Set(['Function', 'Method', 'Class', 'Struct', 'Variable']);

const IMPL_SUFFIX_RE = /_(impl|internal|private|detail|inl)$/;

function getExtension(filePath: string): string {
  const dot = filePath.lastIndexOf('.');
  return dot >= 0 ? filePath.slice(dot) : '';
}

/**
 * Normalized basename for grouping: strip directory, extension, and
 * common impl suffixes so `store.h` and `store_impl.cc` both yield "store".
 */
function normalizedBasename(filePath: string): string {
  const slash = filePath.lastIndexOf('/');
  const name = slash >= 0 ? filePath.slice(slash + 1) : filePath;
  const dot = name.lastIndexOf('.');
  const base = dot >= 0 ? name.slice(0, dot) : name;
  return base.replace(IMPL_SUFFIX_RE, '');
}

/**
 * Extract the qualified symbol name from a node ID.
 * ID format: `Label:filePath:QualifiedName`
 */
function extractQualifiedName(nodeId: string, filePath: string): string | null {
  const labelEnd = nodeId.indexOf(':');
  if (labelEnd < 0) return null;
  const afterLabel = nodeId.slice(labelEnd + 1);
  if (!afterLabel.startsWith(filePath)) return null;
  const qname = afterLabel.slice(filePath.length);
  if (qname.startsWith(':')) return qname.slice(1);
  return qname || null;
}

interface NodeInfo { nodeId: string; filePath: string }

/**
 * Scan the graph for C/C++ header/implementation file pairs and create
 * bidirectional DECLARES/DEFINED_BY edges for matching symbols.
 *
 * Returns the number of edges added.
 */
export function linkHeaderImplementations(graph: KnowledgeGraph): number {
  // Key: "normalizedBasename\0qualifiedName"
  const headerByKey = new Map<string, NodeInfo[]>();
  const implByKey = new Map<string, NodeInfo[]>();

  graph.forEachNode((node) => {
    const label = node.id.split(':')[0];
    if (!LINKABLE_LABELS.has(label)) return;

    const fp = node.properties.filePath;
    if (!fp) return;
    const ext = getExtension(fp);

    const qname = extractQualifiedName(node.id, fp);
    if (!qname) return;

    const base = normalizedBasename(fp);
    const key = `${base}\0${qname}`;
    const info: NodeInfo = { nodeId: node.id, filePath: fp };

    if (HEADER_EXTS.has(ext)) {
      let list = headerByKey.get(key);
      if (!list) { list = []; headerByKey.set(key, list); }
      list.push(info);
    } else if (IMPL_EXTS.has(ext)) {
      let list = implByKey.get(key);
      if (!list) { list = []; implByKey.set(key, list); }
      list.push(info);
    }
  });

  let edgesAdded = 0;

  for (const [key, headers] of headerByKey) {
    const impls = implByKey.get(key);
    if (!impls) continue;

    for (const header of headers) {
      for (const impl of impls) {
        if (header.filePath === impl.filePath) continue;

        const declaresEdge: GraphRelationship = {
          id: generateId('DECLARES', `${header.nodeId}->${impl.nodeId}`),
          sourceId: header.nodeId,
          targetId: impl.nodeId,
          type: 'DECLARES',
          confidence: 1.0,
          reason: 'header-impl-match',
        };

        const definedByEdge: GraphRelationship = {
          id: generateId('DEFINED_BY', `${impl.nodeId}->${header.nodeId}`),
          sourceId: impl.nodeId,
          targetId: header.nodeId,
          type: 'DEFINED_BY',
          confidence: 1.0,
          reason: 'header-impl-match',
        };

        graph.addRelationship(declaresEdge);
        graph.addRelationship(definedByEdge);
        edgesAdded += 2;
      }
    }
  }

  return edgesAdded;
}

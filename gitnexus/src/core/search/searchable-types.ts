/**
 * Single source of truth for all searchable/embeddable node types.
 *
 * Every other module that needs a list of FTS tables, embeddable labels,
 * or backtick-escaped labels MUST derive from this registry.
 * Adding a new searchable type requires exactly one change: add an entry here.
 */

export interface SearchableNodeType {
  /** LadybugDB node table name (e.g. 'Function', 'Struct') */
  table: string;
  /** FTS index name (e.g. 'function_fts') */
  ftsIndex: string;
  /** Properties indexed for full-text search */
  ftsProps: readonly string[];
  /** Whether this type should have embeddings generated */
  embeddable: boolean;
  /** Whether the table name needs backtick-escaping in LadybugDB Cypher */
  backtick: boolean;
}

const SEARCHABLE_NODE_TYPES: readonly SearchableNodeType[] = [
  { table: 'File',        ftsIndex: 'file_fts',        ftsProps: ['name', 'content'], embeddable: true,  backtick: false },
  { table: 'Function',    ftsIndex: 'function_fts',    ftsProps: ['name', 'content'], embeddable: true,  backtick: false },
  { table: 'Class',       ftsIndex: 'class_fts',       ftsProps: ['name', 'content'], embeddable: true,  backtick: false },
  { table: 'Method',      ftsIndex: 'method_fts',      ftsProps: ['name', 'content'], embeddable: true,  backtick: false },
  { table: 'Interface',   ftsIndex: 'interface_fts',   ftsProps: ['name', 'content'], embeddable: true,  backtick: false },
  { table: 'Struct',      ftsIndex: 'struct_fts',      ftsProps: ['name', 'content'], embeddable: true,  backtick: true  },
  { table: 'Enum',        ftsIndex: 'enum_fts',        ftsProps: ['name', 'content'], embeddable: true,  backtick: true  },
  { table: 'Macro',       ftsIndex: 'macro_fts',       ftsProps: ['name', 'content'], embeddable: true,  backtick: true  },
  { table: 'Typedef',     ftsIndex: 'typedef_fts',     ftsProps: ['name', 'content'], embeddable: true,  backtick: true  },
  { table: 'Const',       ftsIndex: 'const_fts',       ftsProps: ['name', 'content'], embeddable: true,  backtick: true  },
  { table: 'Property',    ftsIndex: 'property_fts',    ftsProps: ['name', 'content'], embeddable: true,  backtick: true  },
  { table: 'Constructor', ftsIndex: 'constructor_fts', ftsProps: ['name', 'content'], embeddable: true,  backtick: true  },
  { table: 'Trait',       ftsIndex: 'trait_fts',       ftsProps: ['name', 'content'], embeddable: true,  backtick: true  },
  { table: 'Namespace',   ftsIndex: 'namespace_fts',   ftsProps: ['name', 'content'], embeddable: true,  backtick: true  },
  { table: 'Union',       ftsIndex: 'union_fts',       ftsProps: ['name', 'content'], embeddable: true,  backtick: true  },
] as const;

export default SEARCHABLE_NODE_TYPES;

/** FTS table/index pairs for BM25 search queries. */
export const FTS_TABLES: ReadonlyArray<{ table: string; index: string }> =
  SEARCHABLE_NODE_TYPES.map(t => ({ table: t.table, index: t.ftsIndex }));

/** FTS index definitions for LadybugDB index creation/rebuild. */
export const FTS_INDEX_DEFS: ReadonlyArray<{ table: string; name: string; props: string[] }> =
  SEARCHABLE_NODE_TYPES.map(t => ({ table: t.table, name: t.ftsIndex, props: [...t.ftsProps] }));

/** Node labels that should be embedded for semantic search. */
export const EMBEDDABLE_LABELS = SEARCHABLE_NODE_TYPES
  .filter(t => t.embeddable)
  .map(t => t.table) as readonly string[];

/** Labels that require backtick-escaping in LadybugDB Cypher. */
export const BACKTICK_LABELS: ReadonlySet<string> = new Set(
  SEARCHABLE_NODE_TYPES.filter(t => t.backtick).map(t => t.table),
);

export const escapeLbugLabel = (label: string): string =>
  BACKTICK_LABELS.has(label) ? `\`${label}\`` : label;

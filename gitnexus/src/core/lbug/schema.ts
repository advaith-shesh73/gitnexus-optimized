/**
 * LadybugDB Schema Definitions
 * 
 * Hybrid Schema:
 * - Separate node tables for each code element type (File, Function, Class, etc.)
 * - Single CodeRelation table with 'type' property for all relationships
 * 
 * This allows LLMs to write natural Cypher queries like:
 *   MATCH (f:Function)-[r:CodeRelation {type: 'CALLS'}]->(g:Function) RETURN f, g
 */

// ============================================================================
// NODE TABLE NAMES
// ============================================================================
export const NODE_TABLES = [
  'File', 'Folder', 'Function', 'Class', 'Interface', 'Method', 'CodeElement', 'Community', 'Process', 'Section',
  // Multi-language support
  'Struct', 'Enum', 'Macro', 'Typedef', 'Union', 'Namespace', 'Trait', 'Impl',
  'TypeAlias', 'Const', 'Static', 'Property', 'Record', 'Delegate', 'Annotation', 'Constructor', 'Template', 'Module',
  'Route',
  'Tool'
] as const;
export type NodeTableName = typeof NODE_TABLES[number];

// ============================================================================
// RELATION TABLE
// ============================================================================
export const REL_TABLE_NAME = 'CodeRelation';

// Valid relation types
// Note: WRAPS is reserved for future middleware graph traversal (not yet emitted)
// DECLARES/DEFINED_BY are created by header-impl-linker for C/C++ .h↔.cc pairs
export const REL_TYPES = ['CONTAINS', 'DEFINES', 'IMPORTS', 'CALLS', 'EXTENDS', 'IMPLEMENTS', 'HAS_METHOD', 'HAS_PROPERTY', 'ACCESSES', 'OVERRIDES', 'MEMBER_OF', 'STEP_IN_PROCESS', 'HANDLES_ROUTE', 'FETCHES', 'HANDLES_TOOL', 'ENTRY_POINT_OF', 'WRAPS', 'DECLARES', 'DEFINED_BY'] as const;
export type RelType = typeof REL_TYPES[number];

// ============================================================================
// EMBEDDING TABLE
// ============================================================================
export const EMBEDDING_TABLE_NAME = 'CodeEmbedding';

// ============================================================================
// NODE TABLE SCHEMAS
// ============================================================================

export const FILE_SCHEMA = `
CREATE NODE TABLE File (
  id STRING,
  name STRING,
  filePath STRING,
  content STRING,
  PRIMARY KEY (id)
)`;

export const FOLDER_SCHEMA = `
CREATE NODE TABLE Folder (
  id STRING,
  name STRING,
  filePath STRING,
  PRIMARY KEY (id)
)`;

export const FUNCTION_SCHEMA = `
CREATE NODE TABLE Function (
  id STRING,
  name STRING,
  filePath STRING,
  startLine INT64,
  endLine INT64,
  isExported BOOLEAN,
  content STRING,
  description STRING,
  PRIMARY KEY (id)
)`;

export const CLASS_SCHEMA = `
CREATE NODE TABLE Class (
  id STRING,
  name STRING,
  filePath STRING,
  startLine INT64,
  endLine INT64,
  isExported BOOLEAN,
  content STRING,
  description STRING,
  PRIMARY KEY (id)
)`;

export const INTERFACE_SCHEMA = `
CREATE NODE TABLE Interface (
  id STRING,
  name STRING,
  filePath STRING,
  startLine INT64,
  endLine INT64,
  isExported BOOLEAN,
  content STRING,
  description STRING,
  PRIMARY KEY (id)
)`;

export const METHOD_SCHEMA = `
CREATE NODE TABLE Method (
  id STRING,
  name STRING,
  filePath STRING,
  startLine INT64,
  endLine INT64,
  isExported BOOLEAN,
  content STRING,
  description STRING,
  parameterCount INT32,
  returnType STRING,
  PRIMARY KEY (id)
)`;

export const CODE_ELEMENT_SCHEMA = `
CREATE NODE TABLE CodeElement (
  id STRING,
  name STRING,
  filePath STRING,
  startLine INT64,
  endLine INT64,
  isExported BOOLEAN,
  content STRING,
  description STRING,
  PRIMARY KEY (id)
)`;

// ============================================================================
// COMMUNITY NODE TABLE (for Leiden algorithm clusters)
// ============================================================================

export const COMMUNITY_SCHEMA = `
CREATE NODE TABLE Community (
  id STRING,
  label STRING,
  heuristicLabel STRING,
  keywords STRING[],
  description STRING,
  enrichedBy STRING,
  cohesion DOUBLE,
  symbolCount INT32,
  PRIMARY KEY (id)
)`;

// ============================================================================
// PROCESS NODE TABLE (for execution flow detection)
// ============================================================================

export const PROCESS_SCHEMA = `
CREATE NODE TABLE Process (
  id STRING,
  label STRING,
  heuristicLabel STRING,
  processType STRING,
  stepCount INT32,
  communities STRING[],
  entryPointId STRING,
  terminalId STRING,
  PRIMARY KEY (id)
)`;

// ============================================================================
// MULTI-LANGUAGE NODE TABLE SCHEMAS
// ============================================================================

// Generic code element with startLine/endLine for C, C++, Rust, Go, Java, C#
// description: optional metadata (e.g. Eloquent $fillable fields, relationship targets)
const CODE_ELEMENT_BASE = (name: string) => `
CREATE NODE TABLE \`${name}\` (
  id STRING,
  name STRING,
  filePath STRING,
  startLine INT64,
  endLine INT64,
  content STRING,
  description STRING,
  PRIMARY KEY (id)
)`;

export const STRUCT_SCHEMA = CODE_ELEMENT_BASE('Struct');
export const ENUM_SCHEMA = CODE_ELEMENT_BASE('Enum');
export const MACRO_SCHEMA = CODE_ELEMENT_BASE('Macro');
export const TYPEDEF_SCHEMA = CODE_ELEMENT_BASE('Typedef');
export const UNION_SCHEMA = CODE_ELEMENT_BASE('Union');
export const NAMESPACE_SCHEMA = CODE_ELEMENT_BASE('Namespace');
export const TRAIT_SCHEMA = CODE_ELEMENT_BASE('Trait');
export const IMPL_SCHEMA = CODE_ELEMENT_BASE('Impl');
export const TYPE_ALIAS_SCHEMA = CODE_ELEMENT_BASE('TypeAlias');
export const CONST_SCHEMA = CODE_ELEMENT_BASE('Const');
export const STATIC_SCHEMA = CODE_ELEMENT_BASE('Static');
export const PROPERTY_SCHEMA = CODE_ELEMENT_BASE('Property');
export const RECORD_SCHEMA = CODE_ELEMENT_BASE('Record');
export const DELEGATE_SCHEMA = CODE_ELEMENT_BASE('Delegate');
export const ANNOTATION_SCHEMA = CODE_ELEMENT_BASE('Annotation');
export const CONSTRUCTOR_SCHEMA = CODE_ELEMENT_BASE('Constructor');
export const TEMPLATE_SCHEMA = CODE_ELEMENT_BASE('Template');
export const MODULE_SCHEMA = CODE_ELEMENT_BASE('Module');
// API route endpoints (Next.js, Express, etc.)
export const ROUTE_SCHEMA = `
CREATE NODE TABLE Route (
  id STRING,
  name STRING,
  filePath STRING,
  responseKeys STRING[],
  errorKeys STRING[],
  middleware STRING[],
  PRIMARY KEY (id)
)`;

// MCP tool definitions
export const TOOL_SCHEMA = `
CREATE NODE TABLE Tool (
  id STRING,
  name STRING,
  filePath STRING,
  description STRING,
  PRIMARY KEY (id)
)`;

// Markdown heading sections
export const SECTION_SCHEMA = `
CREATE NODE TABLE Section (
  id STRING,
  name STRING,
  filePath STRING,
  startLine INT64,
  endLine INT64,
  level INT64,
  content STRING,
  description STRING,
  PRIMARY KEY (id)
)`;

// ============================================================================
// RELATION TABLE SCHEMA
// Single table with 'type' property - connects all node tables
//
// Generated programmatically: every non-Community/Process source can target
// every node table. This ensures that when new node types are added to
// NODE_TABLES, the schema auto-expands without manually maintaining FROM→TO pairs.
// ============================================================================

const BACKTICK_NAMES = new Set([
  'Struct', 'Enum', 'Macro', 'Typedef', 'Union', 'Namespace', 'Trait', 'Impl',
  'TypeAlias', 'Const', 'Static', 'Property', 'Record', 'Delegate', 'Annotation',
  'Constructor', 'Template', 'Module',
]);

const escapeNodeTable = (t: string): string =>
  BACKTICK_NAMES.has(t) ? `\`${t}\`` : t;

function generateRelationPairs(): string {
  const pairs: string[] = [];
  for (const src of NODE_TABLES) {
    for (const tgt of NODE_TABLES) {
      pairs.push(`  FROM ${escapeNodeTable(src)} TO ${escapeNodeTable(tgt)}`);
    }
  }
  return pairs.join(',\n');
}

export const RELATION_SCHEMA = `
CREATE REL TABLE ${REL_TABLE_NAME} (
${generateRelationPairs()},
  type STRING,
  confidence DOUBLE,
  reason STRING,
  step INT32
)`;

// ============================================================================
// EMBEDDING TABLE SCHEMA
// Separate table for vector storage to avoid copy-on-write overhead
// ============================================================================

/** Embedding vector dimensions. Default 384 (snowflake-arctic-embed-xs). */
const _rawDims = parseInt(process.env.GITNEXUS_EMBEDDING_DIMS ?? '384', 10);
if (Number.isNaN(_rawDims) || _rawDims <= 0) {
  throw new Error(
    `GITNEXUS_EMBEDDING_DIMS must be a positive integer, got "${process.env.GITNEXUS_EMBEDDING_DIMS}"`,
  );
}
export const EMBEDDING_DIMS = _rawDims;

export const EMBEDDING_SCHEMA = `
CREATE NODE TABLE ${EMBEDDING_TABLE_NAME} (
  nodeId STRING,
  embedding FLOAT[${EMBEDDING_DIMS}],
  PRIMARY KEY (nodeId)
)`;

/**
 * Create vector index for semantic search
 * Uses HNSW (Hierarchical Navigable Small World) algorithm with cosine similarity
 */
export const CREATE_VECTOR_INDEX_QUERY = `
CALL CREATE_VECTOR_INDEX('${EMBEDDING_TABLE_NAME}', 'code_embedding_idx', 'embedding', metric := 'cosine')
`;

// ============================================================================
// ALL SCHEMA QUERIES IN ORDER
// Node tables must be created before relationship tables that reference them
// ============================================================================

export const NODE_SCHEMA_QUERIES = [
  FILE_SCHEMA,
  FOLDER_SCHEMA,
  FUNCTION_SCHEMA,
  CLASS_SCHEMA,
  INTERFACE_SCHEMA,
  METHOD_SCHEMA,
  CODE_ELEMENT_SCHEMA,
  COMMUNITY_SCHEMA,
  PROCESS_SCHEMA,
  // Multi-language support
  STRUCT_SCHEMA,
  ENUM_SCHEMA,
  MACRO_SCHEMA,
  TYPEDEF_SCHEMA,
  UNION_SCHEMA,
  NAMESPACE_SCHEMA,
  TRAIT_SCHEMA,
  IMPL_SCHEMA,
  TYPE_ALIAS_SCHEMA,
  CONST_SCHEMA,
  STATIC_SCHEMA,
  PROPERTY_SCHEMA,
  RECORD_SCHEMA,
  DELEGATE_SCHEMA,
  ANNOTATION_SCHEMA,
  CONSTRUCTOR_SCHEMA,
  TEMPLATE_SCHEMA,
  MODULE_SCHEMA,
  // Markdown support
  SECTION_SCHEMA,
  // API routes
  ROUTE_SCHEMA,
  // MCP tools
  TOOL_SCHEMA,
];

export const REL_SCHEMA_QUERIES = [
  RELATION_SCHEMA,
];

export const SCHEMA_QUERIES = [
  ...NODE_SCHEMA_QUERIES,
  ...REL_SCHEMA_QUERIES,
  EMBEDDING_SCHEMA,
];

/**
 * Index queries for filePath columns on all node tables that have them.
 * Accelerates deleteNodesByFilePath during incremental reindex (avoids full
 * table scans across 30+ tables).
 */
export const FILEPATH_INDEX_QUERIES: string[] = NODE_TABLES
  .filter(t => t !== 'Community' && t !== 'Process')
  .map(t => {
    const escaped = ['File', 'Folder', 'Function', 'Class', 'Interface', 'Method',
      'CodeElement', 'Section', 'Route', 'Tool'].includes(t) ? t : `\`${t}\``;
    return `CREATE INDEX IF NOT EXISTS ON ${escaped}(filePath)`;
  });

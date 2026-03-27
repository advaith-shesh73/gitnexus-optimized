#![deny(clippy::all)]

//! GitNexus Core — native code analysis via tree-sitter + napi-rs
//!
//! Provides:
//! - Symbol extraction from 12+ languages (tree-sitter grammars statically linked)
//! - Import path resolution with suffix-indexed file lookup (FxHashMap)
//! - Symbol table with exact + fuzzy lookups
//! - Parallel import + call resolution via rayon
//!
//! Exposed to Node.js via napi-rs as a drop-in accelerator for the TypeScript pipeline.

mod ts_parser;
pub mod import_resolver;
pub mod symbol_table;
pub mod parallel_resolve;

use napi_derive::napi;

/// Extracted symbol from a source file.
#[derive(Debug)]
#[napi(object)]
pub struct ExtractedSymbol {
    pub name: String,
    pub kind: String,
    pub start_line: u32,
    pub end_line: u32,
    pub is_exported: bool,
}

/// Result of parsing a single source file.
#[napi(object)]
pub struct ParseResult {
    pub file_path: String,
    pub symbols: Vec<ExtractedSymbol>,
    pub error: Option<String>,
}

/// Parse a single source file and extract symbols.
///
/// Returns a `ParseResult` containing all extracted symbols. If the file
/// cannot be parsed (unsupported language, syntax error), the `error` field
/// is populated and `symbols` will contain whatever was extracted before the
/// error occurred.
#[napi]
pub fn parse_file(file_path: String, source: String) -> ParseResult {
    ts_parser::parse_file_impl(&file_path, &source)
}

/// Parse multiple files in parallel (uses rayon under the hood).
///
/// Accepts an array of `{ path, source }` objects and returns an array of
/// `ParseResult` in the same order.
#[napi(object)]
pub struct FileInput {
    pub path: String,
    pub source: String,
}

#[napi]
pub fn parse_files(files: Vec<FileInput>) -> Vec<ParseResult> {
    use rayon::prelude::*;
    files
        .par_iter()
        .map(|f| ts_parser::parse_file_impl(&f.path, &f.source))
        .collect()
}

// ============================================================================
// Import resolution — napi exports
// ============================================================================

#[napi(object)]
pub struct NapiImportEdge {
    pub source_file: String,
    pub import_path: String,
}

#[napi(object)]
pub struct NapiResolvedImport {
    pub source_file: String,
    pub target_file: String,
}

/// Resolve a batch of import edges against a known set of file paths.
/// Uses rayon for parallel suffix-indexed resolution.
#[napi]
pub fn resolve_imports(edges: Vec<NapiImportEdge>, all_files: Vec<String>) -> Vec<NapiResolvedImport> {
    let internal_edges: Vec<parallel_resolve::ImportEdge> = edges
        .into_iter()
        .map(|e| parallel_resolve::ImportEdge {
            source_file: e.source_file,
            import_path: e.import_path,
        })
        .collect();

    parallel_resolve::resolve_imports_parallel(&internal_edges, &all_files)
        .into_iter()
        .map(|r| NapiResolvedImport {
            source_file: r.source_file,
            target_file: r.target_file,
        })
        .collect()
}

// ============================================================================
// Symbol table + call resolution — napi exports
// ============================================================================

#[napi(object)]
pub struct NapiSymbolDef {
    pub node_id: String,
    pub file_path: String,
    pub name: String,
    pub kind: String,
    pub parameter_count: Option<u32>,
    pub required_parameter_count: Option<u32>,
    pub return_type: Option<String>,
    pub declared_type: Option<String>,
    pub owner_id: Option<String>,
}

#[napi(object)]
pub struct NapiCallSite {
    pub file_path: String,
    pub callee_name: String,
    pub arg_count: u32,
}

#[napi(object)]
pub struct NapiResolvedCall {
    pub source_file: String,
    pub callee_name: String,
    pub target_node_id: String,
    pub target_file: String,
    pub confidence: f64,
}

#[napi(object)]
pub struct NapiImportMapEntry {
    pub file_path: String,
    pub imports: Vec<String>,
}

/// Resolve call sites against a pre-built symbol table and import map.
/// Uses rayon for parallel resolution with tiered confidence scoring.
#[napi]
pub fn resolve_calls(
    symbols: Vec<NapiSymbolDef>,
    calls: Vec<NapiCallSite>,
    import_map_entries: Vec<NapiImportMapEntry>,
) -> Vec<NapiResolvedCall> {
    let mut st = symbol_table::SymbolTable::with_capacity(symbols.len() / 10);
    for sym in &symbols {
        st.add_named(
            &sym.file_path,
            &sym.name,
            symbol_table::SymbolDef {
                node_id: sym.node_id.clone(),
                file_path: sym.file_path.clone(),
                kind: sym.kind.clone(),
                parameter_count: sym.parameter_count.map(|v| v as u16),
                required_parameter_count: sym.required_parameter_count.map(|v| v as u16),
                return_type: sym.return_type.clone(),
                declared_type: sym.declared_type.clone(),
                owner_id: sym.owner_id.clone(),
            },
        );
    }

    let mut imap: rustc_hash::FxHashMap<String, Vec<String>> = rustc_hash::FxHashMap::default();
    for entry in import_map_entries {
        imap.insert(entry.file_path, entry.imports);
    }

    let internal_calls: Vec<parallel_resolve::CallSite> = calls
        .into_iter()
        .map(|c| parallel_resolve::CallSite {
            file_path: c.file_path,
            callee_name: c.callee_name,
            arg_count: c.arg_count as u16,
        })
        .collect();

    parallel_resolve::resolve_calls_parallel(&internal_calls, &st, &imap)
        .into_iter()
        .map(|r| NapiResolvedCall {
            source_file: r.source_file,
            callee_name: r.callee_name,
            target_node_id: r.target_node_id,
            target_file: r.target_file,
            confidence: r.confidence as f64,
        })
        .collect()
}

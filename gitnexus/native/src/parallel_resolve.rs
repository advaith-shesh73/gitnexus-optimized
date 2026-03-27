//! Parallel import + call resolution using rayon.
//!
//! Exposes batch operations that the TypeScript pipeline can call via napi
//! to offload heavy resolution work to native threads.

use rayon::prelude::*;
use rustc_hash::FxHashMap;

use crate::import_resolver::{SuffixIndex, resolve_import};
use crate::symbol_table::{SymbolDef, SymbolTable};

/// A single import edge: (source_file, import_path).
#[derive(Debug, Clone)]
pub struct ImportEdge {
    pub source_file: String,
    pub import_path: String,
}

/// A resolved import: (source_file, target_file).
#[derive(Debug, Clone)]
pub struct ResolvedImport {
    pub source_file: String,
    pub target_file: String,
}

/// A call site that needs resolution.
#[derive(Debug, Clone)]
pub struct CallSite {
    pub file_path: String,
    pub callee_name: String,
    pub arg_count: u16,
}

/// A resolved call edge.
#[derive(Debug, Clone)]
pub struct ResolvedCall {
    pub source_file: String,
    pub callee_name: String,
    pub target_node_id: String,
    pub target_file: String,
    pub confidence: f32,
}

/// Resolve imports in parallel using rayon thread pool.
///
/// Builds the suffix index once, then fans out resolution across cores.
/// Returns only successfully resolved import edges.
pub fn resolve_imports_parallel(
    edges: &[ImportEdge],
    all_files: &[String],
) -> Vec<ResolvedImport> {
    if edges.is_empty() || all_files.is_empty() {
        return vec![];
    }

    let file_set: FxHashMap<String, ()> = all_files.iter().map(|f| (f.clone(), ())).collect();
    let index = SuffixIndex::build(all_files);

    edges
        .par_iter()
        .filter_map(|edge| {
            resolve_import(&edge.source_file, &edge.import_path, &file_set, &index)
                .map(|target| ResolvedImport {
                    source_file: edge.source_file.clone(),
                    target_file: target,
                })
        })
        .collect()
}

/// Resolve call sites against a pre-built symbol table.
///
/// For each call site, attempts resolution in order:
///   1. Exact: callee_name in same file (confidence 1.0)
///   2. Import-scoped: callee_name in any imported file (confidence 0.9)
///   3. Global fuzzy: any callable with matching name + arity (confidence 0.5)
///
/// Uses rayon for parallel iteration over call sites.
pub fn resolve_calls_parallel(
    calls: &[CallSite],
    symbol_table: &SymbolTable,
    import_map: &FxHashMap<String, Vec<String>>,
) -> Vec<ResolvedCall> {
    if calls.is_empty() {
        return vec![];
    }

    calls
        .par_iter()
        .filter_map(|call| {
            // Tier 1: same-file exact match
            if let Some(def) = symbol_table.lookup_exact(&call.file_path, &call.callee_name) {
                if arity_matches(def, call.arg_count) {
                    return Some(ResolvedCall {
                        source_file: call.file_path.clone(),
                        callee_name: call.callee_name.clone(),
                        target_node_id: def.node_id.clone(),
                        target_file: def.file_path.clone(),
                        confidence: 1.0,
                    });
                }
            }

            // Tier 2: import-scoped lookup
            if let Some(imports) = import_map.get(&call.file_path) {
                for imported_file in imports {
                    if let Some(def) = symbol_table.lookup_exact(imported_file, &call.callee_name) {
                        if arity_matches(def, call.arg_count) {
                            return Some(ResolvedCall {
                                source_file: call.file_path.clone(),
                                callee_name: call.callee_name.clone(),
                                target_node_id: def.node_id.clone(),
                                target_file: def.file_path.clone(),
                                confidence: 0.9,
                            });
                        }
                    }
                }
            }

            // Tier 3: global fuzzy callable match
            let candidates = symbol_table.lookup_fuzzy_callable(&call.callee_name);
            if candidates.len() == 1 {
                let def = candidates[0];
                if arity_matches(def, call.arg_count) {
                    return Some(ResolvedCall {
                        source_file: call.file_path.clone(),
                        callee_name: call.callee_name.clone(),
                        target_node_id: def.node_id.clone(),
                        target_file: def.file_path.clone(),
                        confidence: 0.5,
                    });
                }
            }

            None
        })
        .collect()
}

fn arity_matches(def: &SymbolDef, arg_count: u16) -> bool {
    match (def.required_parameter_count, def.parameter_count) {
        (Some(min), Some(max)) => arg_count >= min && arg_count <= max,
        (None, Some(max)) => arg_count <= max,
        (Some(min), None) => arg_count >= min,
        (None, None) => true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_def(file: &str, name: &str, kind: &str, params: Option<u16>) -> SymbolDef {
        SymbolDef {
            node_id: format!("{file}::{name}"),
            file_path: file.to_string(),
            kind: kind.to_string(),
            parameter_count: params,
            required_parameter_count: params,
            return_type: None,
            declared_type: None,
            owner_id: None,
        }
    }

    #[test]
    fn parallel_import_resolution() {
        let files = vec![
            "src/a.ts".to_string(),
            "src/b.ts".to_string(),
            "src/utils/c.ts".to_string(),
        ];
        let edges = vec![
            ImportEdge { source_file: "src/a.ts".into(), import_path: "./b".into() },
            ImportEdge { source_file: "src/a.ts".into(), import_path: "./utils/c".into() },
            ImportEdge { source_file: "src/a.ts".into(), import_path: "react".into() },
        ];

        let results = resolve_imports_parallel(&edges, &files);
        assert_eq!(results.len(), 2);
    }

    #[test]
    fn call_resolution_tiers() {
        let mut st = SymbolTable::new();
        st.add_named("a.ts", "localFn", make_def("a.ts", "localFn", "Function", Some(1)));
        st.add_named("b.ts", "importedFn", make_def("b.ts", "importedFn", "Function", Some(2)));
        st.add_named("c.ts", "globalFn", make_def("c.ts", "globalFn", "Function", Some(0)));

        let mut import_map: FxHashMap<String, Vec<String>> = FxHashMap::default();
        import_map.insert("a.ts".into(), vec!["b.ts".into()]);

        let calls = vec![
            CallSite { file_path: "a.ts".into(), callee_name: "localFn".into(), arg_count: 1 },
            CallSite { file_path: "a.ts".into(), callee_name: "importedFn".into(), arg_count: 2 },
            CallSite { file_path: "a.ts".into(), callee_name: "globalFn".into(), arg_count: 0 },
            CallSite { file_path: "a.ts".into(), callee_name: "missing".into(), arg_count: 0 },
        ];

        let results = resolve_calls_parallel(&calls, &st, &import_map);
        assert_eq!(results.len(), 3, "should resolve local, imported, and global calls");

        let local = results.iter().find(|r| r.callee_name == "localFn").unwrap();
        assert_eq!(local.confidence, 1.0);

        let imported = results.iter().find(|r| r.callee_name == "importedFn").unwrap();
        assert_eq!(imported.confidence, 0.9);

        let global = results.iter().find(|r| r.callee_name == "globalFn").unwrap();
        assert_eq!(global.confidence, 0.5);
    }

    #[test]
    fn arity_mismatch_skips() {
        let mut st = SymbolTable::new();
        st.add_named("a.ts", "fn", make_def("a.ts", "fn", "Function", Some(2)));

        let calls = vec![
            CallSite { file_path: "a.ts".into(), callee_name: "fn".into(), arg_count: 5 },
        ];

        let results = resolve_calls_parallel(&calls, &st, &FxHashMap::default());
        assert_eq!(results.len(), 0, "arity mismatch should not resolve");
    }

    #[test]
    fn empty_inputs() {
        let results = resolve_imports_parallel(&[], &[]);
        assert!(results.is_empty());

        let st = SymbolTable::new();
        let results = resolve_calls_parallel(&[], &st, &FxHashMap::default());
        assert!(results.is_empty());
    }
}

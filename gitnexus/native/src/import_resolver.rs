//! Fast import path resolution using suffix-indexed file lookup.
//!
//! Mirrors the TypeScript `import-resolvers/utils.ts` SuffixIndex + resolveImportPath logic.
//! All paths are normalized to forward slashes; resolution is case-insensitive with
//! case-sensitive preference.

use rustc_hash::FxHashMap;

/// File extensions to try during resolution (order matters — prefer TS/JS first).
const EXTENSIONS: &[&str] = &[
    "",
    ".tsx", ".ts", ".jsx", ".js",
    "/index.tsx", "/index.ts", "/index.jsx", "/index.js",
    ".py", "/__init__.py",
    ".java", ".kt", ".kts",
    ".c", ".h", ".cpp", ".hpp", ".cc", ".cxx", ".hxx", ".hh",
    ".cs", ".go", ".rs", "/mod.rs",
    ".php", ".phtml", ".swift", ".rb",
];

pub struct SuffixIndex {
    exact: FxHashMap<String, String>,
    lower: FxHashMap<String, String>,
}

impl SuffixIndex {
    pub fn build(file_paths: &[String]) -> Self {
        let estimated_entries = file_paths.len() * 4;
        let mut exact = FxHashMap::with_capacity_and_hasher(estimated_entries, Default::default());
        let mut lower = FxHashMap::with_capacity_and_hasher(estimated_entries, Default::default());

        for path in file_paths {
            let normalized = path.replace('\\', "/");
            let parts: Vec<&str> = normalized.split('/').collect();
            for j in (0..parts.len()).rev() {
                let suffix: String = parts[j..].join("/");
                exact.entry(suffix.clone()).or_insert_with(|| path.clone());
                let lc = suffix.to_lowercase();
                lower.entry(lc).or_insert_with(|| path.clone());
            }
        }

        Self { exact, lower }
    }

    fn get(&self, suffix: &str) -> Option<&String> {
        self.exact.get(suffix).or_else(|| self.lower.get(&suffix.to_lowercase()))
    }
}

/// Resolve a single import path against a known file set using extension probing + suffix index.
pub fn resolve_import(
    current_file: &str,
    import_path: &str,
    all_files: &FxHashMap<String, ()>,
    index: &SuffixIndex,
) -> Option<String> {
    // Relative imports (./ or ../)
    if import_path.starts_with('.') {
        let current_dir: Vec<&str> = current_file.split('/').collect();
        let mut dir: Vec<&str> = current_dir[..current_dir.len().saturating_sub(1)].to_vec();
        for part in import_path.split('/') {
            match part {
                "." => {}
                ".." => { dir.pop(); }
                other => dir.push(other),
            }
        }
        let base = dir.join("/");
        return try_resolve_with_extensions(&base, all_files);
    }

    // Non-relative: suffix matching
    let path_like = if import_path.contains('/') {
        import_path.to_string()
    } else {
        import_path.replace('.', "/")
    };
    let parts: Vec<&str> = path_like.split('/').filter(|p| !p.is_empty()).collect();

    for i in 0..parts.len() {
        let suffix = parts[i..].join("/");
        for ext in EXTENSIONS {
            let candidate = format!("{suffix}{ext}");
            if let Some(resolved) = index.get(&candidate) {
                return Some(resolved.clone());
            }
        }
    }

    None
}

fn try_resolve_with_extensions(
    base_path: &str,
    all_files: &FxHashMap<String, ()>,
) -> Option<String> {
    for ext in EXTENSIONS {
        let candidate = format!("{base_path}{ext}");
        if all_files.contains_key(&candidate) {
            return Some(candidate);
        }
    }
    None
}

/// Batch import resolution: resolve many (file, import_path) pairs.
/// Returns Vec of (source_file, resolved_target) for successful resolutions.
pub fn resolve_imports_batch(
    pairs: &[(String, String)],
    all_files: &[String],
) -> Vec<(String, String)> {
    let file_set: FxHashMap<String, ()> = all_files.iter().map(|f| (f.clone(), ())).collect();
    let index = SuffixIndex::build(all_files);

    pairs
        .iter()
        .filter_map(|(src, imp)| {
            resolve_import(src, imp, &file_set, &index).map(|resolved| (src.clone(), resolved))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_file_set(paths: &[&str]) -> FxHashMap<String, ()> {
        paths.iter().map(|p| (p.to_string(), ())).collect()
    }

    #[test]
    fn resolves_relative_import_with_extension() {
        let files = make_file_set(&["src/utils/helper.ts", "src/index.ts"]);
        let all: Vec<String> = files.keys().cloned().collect();
        let index = SuffixIndex::build(&all);

        let result = resolve_import("src/index.ts", "./utils/helper", &files, &index);
        assert_eq!(result, Some("src/utils/helper.ts".to_string()));
    }

    #[test]
    fn resolves_parent_directory_import() {
        let files = make_file_set(&["src/shared/types.ts", "src/components/Button.tsx"]);
        let all: Vec<String> = files.keys().cloned().collect();
        let index = SuffixIndex::build(&all);

        let result = resolve_import("src/components/Button.tsx", "../shared/types", &files, &index);
        assert_eq!(result, Some("src/shared/types.ts".to_string()));
    }

    #[test]
    fn resolves_index_file() {
        let files = make_file_set(&["src/utils/index.ts", "src/app.ts"]);
        let all: Vec<String> = files.keys().cloned().collect();
        let index = SuffixIndex::build(&all);

        let result = resolve_import("src/app.ts", "./utils", &files, &index);
        assert_eq!(result, Some("src/utils/index.ts".to_string()));
    }

    #[test]
    fn resolves_absolute_by_suffix() {
        let files = make_file_set(&["src/com/example/UserService.java"]);
        let all: Vec<String> = files.keys().cloned().collect();
        let index = SuffixIndex::build(&all);

        let result = resolve_import("src/Main.java", "com.example.UserService", &files, &index);
        assert_eq!(result, Some("src/com/example/UserService.java".to_string()));
    }

    #[test]
    fn returns_none_for_external_package() {
        let files = make_file_set(&["src/app.ts"]);
        let all: Vec<String> = files.keys().cloned().collect();
        let index = SuffixIndex::build(&all);

        let result = resolve_import("src/app.ts", "react", &files, &index);
        assert_eq!(result, None);
    }

    #[test]
    fn resolves_python_dotted_import() {
        let files = make_file_set(&["lib/models/user.py"]);
        let all: Vec<String> = files.keys().cloned().collect();
        let index = SuffixIndex::build(&all);

        let result = resolve_import("lib/app.py", "models.user", &files, &index);
        assert_eq!(result, Some("lib/models/user.py".to_string()));
    }

    #[test]
    fn batch_resolution() {
        let all = vec![
            "src/a.ts".to_string(),
            "src/b.ts".to_string(),
            "src/utils/c.ts".to_string(),
        ];
        let pairs = vec![
            ("src/a.ts".to_string(), "./b".to_string()),
            ("src/a.ts".to_string(), "./utils/c".to_string()),
            ("src/a.ts".to_string(), "nonexistent".to_string()),
        ];

        let results = resolve_imports_batch(&pairs, &all);
        assert_eq!(results.len(), 2);
        assert_eq!(results[0], ("src/a.ts".to_string(), "src/b.ts".to_string()));
        assert_eq!(results[1], ("src/a.ts".to_string(), "src/utils/c.ts".to_string()));
    }
}

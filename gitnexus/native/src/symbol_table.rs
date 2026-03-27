//! FxHashMap-backed symbol table for fast exact + fuzzy symbol lookups.
//!
//! Mirrors the TypeScript `symbol-table.ts` dual-index pattern:
//!   - file_index: (FilePath, SymbolName) -> Vec<SymbolDef>   (exact lookup)
//!   - global_index: SymbolName -> Vec<SymbolDef>              (fuzzy lookup)
//!
//! Uses FxHashMap (Fx hash) for ~2x faster lookups than std HashMap on short keys.

use rustc_hash::FxHashMap;

#[derive(Debug, Clone)]
pub struct SymbolDef {
    pub node_id: String,
    pub file_path: String,
    pub kind: String,
    pub parameter_count: Option<u16>,
    pub required_parameter_count: Option<u16>,
    pub return_type: Option<String>,
    pub declared_type: Option<String>,
    pub owner_id: Option<String>,
}

pub struct SymbolTable {
    file_index: FxHashMap<String, FxHashMap<String, Vec<SymbolDef>>>,
    global_index: FxHashMap<String, Vec<SymbolDef>>,
    field_by_owner: FxHashMap<String, SymbolDef>,
}

const CALLABLE_KINDS: &[&str] = &["Function", "Method", "Constructor"];

impl SymbolTable {
    pub fn new() -> Self {
        Self {
            file_index: FxHashMap::default(),
            global_index: FxHashMap::default(),
            field_by_owner: FxHashMap::default(),
        }
    }

    pub fn with_capacity(file_count: usize) -> Self {
        Self {
            file_index: FxHashMap::with_capacity_and_hasher(file_count, Default::default()),
            global_index: FxHashMap::with_capacity_and_hasher(file_count * 10, Default::default()),
            field_by_owner: FxHashMap::default(),
        }
    }

    pub fn add(&mut self, def: SymbolDef) {
        let file_path = def.file_path.clone();
        let name = {
            let parts: Vec<&str> = def.node_id.rsplitn(2, "::").collect();
            if parts.len() > 1 { parts[0].to_string() } else { def.node_id.clone() }
        };

        let file_map = self.file_index.entry(file_path).or_default();
        file_map.entry(name.clone()).or_default().push(def.clone());

        if def.kind == "Property" {
            if let Some(ref owner_id) = def.owner_id {
                let key = format!("{owner_id}\0{name}");
                self.field_by_owner.insert(key, def);
                return;
            }
        }

        self.global_index.entry(name).or_default().push(def);
    }

    pub fn add_named(&mut self, file_path: &str, name: &str, def: SymbolDef) {
        let file_map = self.file_index.entry(file_path.to_string()).or_default();
        file_map.entry(name.to_string()).or_default().push(def.clone());

        if def.kind == "Property" {
            if let Some(ref owner_id) = def.owner_id {
                let key = format!("{owner_id}\0{name}");
                self.field_by_owner.insert(key, def);
                return;
            }
        }

        self.global_index.entry(name.to_string()).or_default().push(def);
    }

    pub fn lookup_exact(&self, file_path: &str, name: &str) -> Option<&SymbolDef> {
        self.file_index.get(file_path)?.get(name)?.first()
    }

    pub fn lookup_exact_all(&self, file_path: &str, name: &str) -> &[SymbolDef] {
        self.file_index
            .get(file_path)
            .and_then(|m| m.get(name))
            .map(|v| v.as_slice())
            .unwrap_or(&[])
    }

    pub fn lookup_fuzzy(&self, name: &str) -> &[SymbolDef] {
        self.global_index
            .get(name)
            .map(|v| v.as_slice())
            .unwrap_or(&[])
    }

    pub fn lookup_fuzzy_callable(&self, name: &str) -> Vec<&SymbolDef> {
        self.global_index
            .get(name)
            .map(|defs| {
                defs.iter()
                    .filter(|d| CALLABLE_KINDS.contains(&d.kind.as_str()))
                    .collect()
            })
            .unwrap_or_default()
    }

    pub fn lookup_field_by_owner(&self, owner_id: &str, field_name: &str) -> Option<&SymbolDef> {
        let key = format!("{owner_id}\0{field_name}");
        self.field_by_owner.get(&key)
    }

    pub fn file_count(&self) -> usize {
        self.file_index.len()
    }

    pub fn global_symbol_count(&self) -> usize {
        self.global_index.len()
    }

    pub fn clear(&mut self) {
        self.file_index.clear();
        self.global_index.clear();
        self.field_by_owner.clear();
    }
}

impl Default for SymbolTable {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_def(file: &str, name: &str, kind: &str) -> SymbolDef {
        SymbolDef {
            node_id: format!("{file}::{name}"),
            file_path: file.to_string(),
            kind: kind.to_string(),
            parameter_count: None,
            required_parameter_count: None,
            return_type: None,
            declared_type: None,
            owner_id: None,
        }
    }

    #[test]
    fn exact_lookup() {
        let mut st = SymbolTable::new();
        st.add_named("src/auth.ts", "login", make_def("src/auth.ts", "login", "Function"));
        st.add_named("src/auth.ts", "logout", make_def("src/auth.ts", "logout", "Function"));

        assert!(st.lookup_exact("src/auth.ts", "login").is_some());
        assert_eq!(st.lookup_exact("src/auth.ts", "login").unwrap().kind, "Function");
        assert!(st.lookup_exact("src/auth.ts", "missing").is_none());
        assert!(st.lookup_exact("other.ts", "login").is_none());
    }

    #[test]
    fn fuzzy_lookup() {
        let mut st = SymbolTable::new();
        st.add_named("a.ts", "User", make_def("a.ts", "User", "Class"));
        st.add_named("b.ts", "User", make_def("b.ts", "User", "Class"));

        assert_eq!(st.lookup_fuzzy("User").len(), 2);
        assert_eq!(st.lookup_fuzzy("Missing").len(), 0);
    }

    #[test]
    fn fuzzy_callable_filters_non_callables() {
        let mut st = SymbolTable::new();
        st.add_named("a.ts", "User", make_def("a.ts", "User", "Class"));
        st.add_named("a.ts", "getUser", make_def("a.ts", "getUser", "Function"));
        st.add_named("b.ts", "getUser", make_def("b.ts", "getUser", "Method"));

        let callables = st.lookup_fuzzy_callable("getUser");
        assert_eq!(callables.len(), 2);
        let callable_user = st.lookup_fuzzy_callable("User");
        assert_eq!(callable_user.len(), 0);
    }

    #[test]
    fn field_by_owner_lookup() {
        let mut st = SymbolTable::new();
        let mut def = make_def("a.ts", "name", "Property");
        def.owner_id = Some("node_User".to_string());
        def.declared_type = Some("string".to_string());
        st.add_named("a.ts", "name", def);

        assert!(st.lookup_field_by_owner("node_User", "name").is_some());
        assert!(st.lookup_field_by_owner("node_User", "missing").is_none());
        // Properties with owner skip global index
        assert_eq!(st.lookup_fuzzy("name").len(), 0);
    }

    #[test]
    fn overloaded_methods() {
        let mut st = SymbolTable::new();
        let mut def1 = make_def("a.java", "process", "Method");
        def1.parameter_count = Some(1);
        let mut def2 = make_def("a.java", "process", "Method");
        def2.parameter_count = Some(2);
        st.add_named("a.java", "process", def1);
        st.add_named("a.java", "process", def2);

        let all = st.lookup_exact_all("a.java", "process");
        assert_eq!(all.len(), 2);
    }

    #[test]
    fn stats_and_clear() {
        let mut st = SymbolTable::new();
        st.add_named("a.ts", "foo", make_def("a.ts", "foo", "Function"));
        st.add_named("b.ts", "bar", make_def("b.ts", "bar", "Function"));

        assert_eq!(st.file_count(), 2);
        assert_eq!(st.global_symbol_count(), 2);

        st.clear();
        assert_eq!(st.file_count(), 0);
        assert_eq!(st.global_symbol_count(), 0);
    }
}

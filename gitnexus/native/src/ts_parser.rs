//! Tree-sitter based symbol extraction for all supported languages.
//!
//! All 13 tree-sitter grammars are statically linked into the binary.
//! The `get_language` dispatcher maps file extensions to the correct grammar.
//! Symbol extraction uses generic CST walking that works across languages
//! (function/class/method declarations) with language-specific node-kind
//! tables for each grammar.

use tree_sitter::{Language, Parser};

use crate::{ExtractedSymbol, ParseResult};

fn get_language(file_path: &str) -> Option<Language> {
    let path = file_path.to_lowercase();
    if path.ends_with(".ts") || path.ends_with(".tsx") {
        Some(tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into())
    } else if path.ends_with(".js")
        || path.ends_with(".jsx")
        || path.ends_with(".mjs")
        || path.ends_with(".cjs")
    {
        Some(tree_sitter_javascript::LANGUAGE.into())
    } else if path.ends_with(".py") || path.ends_with(".pyw") {
        Some(tree_sitter_python::LANGUAGE.into())
    } else if path.ends_with(".java") {
        Some(tree_sitter_java::LANGUAGE.into())
    } else if path.ends_with(".c") || path.ends_with(".h") {
        Some(tree_sitter_c::LANGUAGE.into())
    } else if path.ends_with(".cpp")
        || path.ends_with(".cc")
        || path.ends_with(".cxx")
        || path.ends_with(".hpp")
        || path.ends_with(".hxx")
    {
        Some(tree_sitter_cpp::LANGUAGE.into())
    } else if path.ends_with(".cs") {
        Some(tree_sitter_c_sharp::LANGUAGE.into())
    } else if path.ends_with(".go") {
        Some(tree_sitter_go::LANGUAGE.into())
    } else if path.ends_with(".rb") || path.ends_with(".rake") {
        Some(tree_sitter_ruby::LANGUAGE.into())
    } else if path.ends_with(".rs") {
        Some(tree_sitter_rust::LANGUAGE.into())
    } else if path.ends_with(".php") {
        Some(tree_sitter_php::LANGUAGE_PHP.into())
    } else if path.ends_with(".kt") || path.ends_with(".kts") {
        Some(tree_sitter_kotlin_ng::LANGUAGE.into())
    // Swift grammar (ABI v15) requires tree-sitter 0.25+; re-enable when available
    } else {
        None
    }
}

/// Top-level node kinds that represent extractable symbols across all grammars.
fn is_symbol_node(kind: &str) -> bool {
    matches!(
        kind,
        // TS/JS
        "function_declaration"
            | "generator_function_declaration"
            | "class_declaration"
            | "abstract_class_declaration"
            | "interface_declaration"
            | "method_definition"
            | "public_field_definition"
            | "type_alias_declaration"
            | "enum_declaration"
            // Python/PHP
            | "function_definition"
            | "class_definition"
            // Java/C#/Kotlin/PHP
            | "method_declaration"
            | "constructor_declaration"
            | "record_declaration"
            | "annotation_type_declaration"
            // Go — type_declaration wraps struct/interface/alias via type_spec
            | "type_declaration"
            // C/C++
            | "class_specifier"
            | "struct_specifier"
            | "enum_specifier"
            | "union_specifier"
            | "template_declaration"
            | "namespace_definition"
            | "preproc_def"
            | "preproc_function_def"
            | "type_definition"
            // Rust
            | "function_item"
            | "struct_item"
            | "enum_item"
            | "impl_item"
            | "trait_item"
            | "type_alias"
            | "const_item"
            | "static_item"
            | "macro_definition"
            // Ruby
            | "method"
            | "singleton_method"
            // Kotlin
            | "object_declaration"
    )
}

/// Resolve Go type_declaration to the correct kind by inspecting the inner
/// type_spec's type child (struct_type, interface_type, or type alias).
fn resolve_go_type_declaration(node: &tree_sitter::Node) -> &'static str {
    for i in 0..node.named_child_count() {
        if let Some(spec) = node.named_child(i) {
            if spec.kind() == "type_spec" {
                if let Some(type_child) = spec.child_by_field_name("type") {
                    return match type_child.kind() {
                        "struct_type" => "Struct",
                        "interface_type" => "Interface",
                        _ => "TypeAlias",
                    };
                }
            }
        }
    }
    "TypeAlias"
}

fn symbol_kind(kind: &str, node: &tree_sitter::Node) -> &'static str {
    match kind {
        "function_declaration" | "generator_function_declaration" | "function_definition"
        | "function_item" => "Function",

        "class_declaration" | "abstract_class_declaration" | "class_definition"
        | "class_specifier" => "Class",

        "interface_declaration" | "protocol_declaration" => "Interface",

        "method_definition" | "method_declaration" | "method" | "singleton_method" => "Method",

        "constructor_declaration" => "Constructor",

        "type_alias_declaration" | "type_alias" => "TypeAlias",

        // Go: inspect inner type_spec to differentiate struct/interface/alias
        "type_declaration" => resolve_go_type_declaration(node),

        "enum_declaration" | "enum_specifier" | "enum_item" => "Enum",

        "struct_specifier" | "struct_item" | "record_declaration" => "Struct",

        "union_specifier" => "Union",
        "template_declaration" => "Template",
        "impl_item" => "Impl",
        "trait_item" => "Trait",

        "namespace_definition" => "Namespace",
        "preproc_def" | "preproc_function_def" | "macro_definition" => "Macro",
        "type_definition" => "Typedef",
        "const_item" => "Const",
        "static_item" => "Static",
        "annotation_type_declaration" => "Annotation",
        "object_declaration" => "Class",

        _ => "CodeElement",
    }
}

fn get_name(node: &tree_sitter::Node, source: &[u8]) -> Option<String> {
    if let Some(n) = node.child_by_field_name("name") {
        return Some(n.utf8_text(source).unwrap_or("").to_string());
    }
    // Go type_declaration: name lives inside the child type_spec
    if node.kind() == "type_declaration" {
        for i in 0..node.named_child_count() {
            if let Some(spec) = node.named_child(i) {
                if spec.kind() == "type_spec" {
                    if let Some(n) = spec.child_by_field_name("name") {
                        return Some(n.utf8_text(source).unwrap_or("").to_string());
                    }
                }
            }
        }
    }
    // C++ preproc_def: name is the first token after #define
    if node.kind() == "preproc_def" || node.kind() == "preproc_function_def" {
        if let Some(n) = node.child_by_field_name("name") {
            return Some(n.utf8_text(source).unwrap_or("").to_string());
        }
        for i in 0..node.named_child_count() {
            if let Some(child) = node.named_child(i) {
                let text = child.utf8_text(source).unwrap_or("");
                if !text.is_empty() && text != "#define" {
                    return Some(text.to_string());
                }
            }
        }
    }
    None
}

fn is_exported(node: &tree_sitter::Node, source: &[u8]) -> bool {
    if let Some(parent) = node.parent() {
        let kind = parent.kind();
        if kind == "export_statement" || kind == "export_default_declaration" {
            return true;
        }
    }
    // Check for `export` keyword prefix in the node text
    let start = node.start_byte();
    if start >= 7 {
        let prefix = &source[start.saturating_sub(20)..start];
        if let Ok(s) = std::str::from_utf8(prefix) {
            return s.contains("export");
        }
    }
    false
}

pub fn parse_file_impl(file_path: &str, source: &str) -> ParseResult {
    let lang = match get_language(file_path) {
        Some(l) => l,
        None => {
            return ParseResult {
                file_path: file_path.to_string(),
                symbols: vec![],
                error: Some(format!("Unsupported language for {file_path}")),
            }
        }
    };

    let mut parser = Parser::new();
    parser.set_language(&lang).ok();

    let tree = match parser.parse(source, None) {
        Some(t) => t,
        None => {
            return ParseResult {
                file_path: file_path.to_string(),
                symbols: vec![],
                error: Some("Parse failed".to_string()),
            }
        }
    };

    let source_bytes = source.as_bytes();
    let mut symbols = Vec::new();
    let mut cursor = tree.walk();

    extract_symbols_recursive(&tree.root_node(), source_bytes, &mut symbols, 0);

    ParseResult {
        file_path: file_path.to_string(),
        symbols,
        error: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_function_declarations() {
        let result = parse_file_impl("test.ts", "function greet(name: string): string {\n    return `Hello`;\n}\n\nexport function farewell(): void {}\n");
        assert!(result.error.is_none());
        let names: Vec<&str> = result.symbols.iter().map(|s| s.name.as_str()).collect();
        assert!(names.contains(&"greet"));
        assert!(names.contains(&"farewell"));
        let farewell = result.symbols.iter().find(|s| s.name == "farewell").unwrap();
        assert!(farewell.is_exported);
    }

    #[test]
    fn extracts_class_with_methods() {
        let src = "export class UserService {\n    async getUser(id: string) { return id; }\n    deleteUser(id: string) {}\n}\n";
        let result = parse_file_impl("service.ts", src);
        assert!(result.error.is_none());
        let names: Vec<&str> = result.symbols.iter().map(|s| s.name.as_str()).collect();
        assert!(names.contains(&"UserService"));
        assert!(names.contains(&"getUser"));
        assert!(names.contains(&"deleteUser"));
        let svc = result.symbols.iter().find(|s| s.name == "UserService").unwrap();
        assert_eq!(svc.kind, "Class");
        assert!(svc.is_exported);
    }

    #[test]
    fn extracts_interfaces() {
        let result = parse_file_impl("types.ts", "export interface Config {\n    host: string;\n    port: number;\n}\n");
        assert!(result.error.is_none());
        let cfg = result.symbols.iter().find(|s| s.name == "Config").unwrap();
        assert_eq!(cfg.kind, "Interface");
        assert!(cfg.is_exported);
    }

    #[test]
    fn handles_javascript_files() {
        let result = parse_file_impl("math.js", "function add(a, b) { return a + b; }\nclass Calculator {}\n");
        assert!(result.error.is_none());
        assert_eq!(result.symbols.len(), 2);
    }

    #[test]
    fn returns_error_for_unsupported_language() {
        let result = parse_file_impl("main.zig", "fn main() !void {}");
        assert!(result.error.is_some());
        assert!(result.symbols.is_empty());
    }

    #[test]
    fn extracts_python_symbols() {
        let src = "def greet(name):\n    return f'Hello {name}'\n\nclass UserService:\n    def get_user(self, uid):\n        pass\n";
        let result = parse_file_impl("app.py", src);
        assert!(result.error.is_none());
        let names: Vec<&str> = result.symbols.iter().map(|s| s.name.as_str()).collect();
        assert!(names.contains(&"greet"), "missing greet: {:?}", names);
        assert!(names.contains(&"UserService"), "missing UserService: {:?}", names);
        let greet = result.symbols.iter().find(|s| s.name == "greet").unwrap();
        assert_eq!(greet.kind, "Function");
        let cls = result.symbols.iter().find(|s| s.name == "UserService").unwrap();
        assert_eq!(cls.kind, "Class");
    }

    #[test]
    fn extracts_java_symbols() {
        let src = "public class Calculator {\n    public int add(int a, int b) {\n        return a + b;\n    }\n}\n";
        let result = parse_file_impl("Calculator.java", src);
        assert!(result.error.is_none());
        let names: Vec<&str> = result.symbols.iter().map(|s| s.name.as_str()).collect();
        assert!(names.contains(&"Calculator"), "missing Calculator: {:?}", names);
        assert!(names.contains(&"add"), "missing add method: {:?}", names);
    }

    #[test]
    fn extracts_go_symbols() {
        let src = "package main\n\nfunc Add(a int, b int) int {\n    return a + b\n}\n\ntype Server struct {\n    Port int\n}\n\ntype Reader interface {\n    Read(p []byte) (n int, err error)\n}\n";
        let result = parse_file_impl("main.go", src);
        assert!(result.error.is_none());
        let names: Vec<&str> = result.symbols.iter().map(|s| s.name.as_str()).collect();
        assert!(names.contains(&"Add"), "missing Add: {:?}", names);
        assert!(names.contains(&"Server"), "missing Server: {:?}", names);
        assert!(names.contains(&"Reader"), "missing Reader: {:?}", names);

        let server = result.symbols.iter().find(|s| s.name == "Server").unwrap();
        assert_eq!(server.kind, "Struct", "Go struct should be labeled Struct, not TypeAlias");

        let reader = result.symbols.iter().find(|s| s.name == "Reader").unwrap();
        assert_eq!(reader.kind, "Interface", "Go interface should be labeled Interface");
    }

    #[test]
    fn extracts_rust_symbols() {
        let src = "fn compute(x: i32) -> i32 {\n    x * 2\n}\n\nstruct Config {\n    host: String,\n}\n\nenum Status {\n    Active,\n    Inactive,\n}\n";
        let result = parse_file_impl("lib.rs", src);
        assert!(result.error.is_none());
        let names: Vec<&str> = result.symbols.iter().map(|s| s.name.as_str()).collect();
        assert!(names.contains(&"compute"), "missing compute: {:?}", names);
        assert!(names.contains(&"Config"), "missing Config: {:?}", names);
        assert!(names.contains(&"Status"), "missing Status: {:?}", names);
        let compute = result.symbols.iter().find(|s| s.name == "compute").unwrap();
        assert_eq!(compute.kind, "Function");
        let cfg = result.symbols.iter().find(|s| s.name == "Config").unwrap();
        assert_eq!(cfg.kind, "Struct");
    }

    #[test]
    fn extracts_c_symbols() {
        let src = "struct Point {\n    int x;\n    int y;\n};\n\nenum Color {\n    RED,\n    GREEN,\n    BLUE\n};\n";
        let result = parse_file_impl("geo.c", src);
        assert!(result.error.is_none());
        let kinds: Vec<&str> = result.symbols.iter().map(|s| s.kind.as_str()).collect();
        assert!(kinds.contains(&"Struct"), "missing struct: {:?}", result.symbols);
        assert!(kinds.contains(&"Enum"), "missing enum: {:?}", result.symbols);
    }

    #[test]
    fn extracts_ruby_symbols() {
        let src = "def greet(name)\n  puts \"Hello #{name}\"\nend\n";
        let result = parse_file_impl("app.rb", src);
        assert!(result.error.is_none());
        let names: Vec<&str> = result.symbols.iter().map(|s| s.name.as_str()).collect();
        assert!(names.contains(&"greet"), "missing greet: {:?}", names);
    }

    #[test]
    fn extracts_php_symbols() {
        let src = "<?php\nfunction hello($name) {\n    echo \"Hello $name\";\n}\n\nclass UserService {\n    public function getUser($id) {\n        return $id;\n    }\n}\n";
        let result = parse_file_impl("app.php", src);
        assert!(result.error.is_none());
        let names: Vec<&str> = result.symbols.iter().map(|s| s.name.as_str()).collect();
        assert!(names.contains(&"hello"), "missing hello: {:?}", names);
        assert!(names.contains(&"UserService"), "missing UserService: {:?}", names);
    }

    #[test]
    fn extracts_csharp_symbols() {
        let src = "public class Program {\n    public static void Main(string[] args) {\n    }\n}\n";
        let result = parse_file_impl("Program.cs", src);
        assert!(result.error.is_none());
        let names: Vec<&str> = result.symbols.iter().map(|s| s.name.as_str()).collect();
        assert!(names.contains(&"Program"), "missing Program: {:?}", names);
    }

    #[test]
    fn swift_returns_unsupported() {
        let result = parse_file_impl("app.swift", "func greet() {}");
        assert!(result.error.is_some(), "Swift should be unsupported until tree-sitter 0.25");
    }

    #[test]
    fn extracts_kotlin_symbols() {
        let src = "fun greet(name: String): String {\n    return \"Hello $name\"\n}\n\nclass UserService {\n    fun getUser(id: String): String = id\n}\n";
        let result = parse_file_impl("app.kt", src);
        assert!(result.error.is_none());
        let names: Vec<&str> = result.symbols.iter().map(|s| s.name.as_str()).collect();
        assert!(names.contains(&"greet"), "missing greet: {:?}", names);
        assert!(names.contains(&"UserService"), "missing UserService: {:?}", names);
    }

    #[test]
    fn extracts_cpp_symbols() {
        let src = "struct Point {\n    double x;\n    double y;\n};\n\nunion Data {\n    int i;\n    float f;\n};\n\nenum Color { RED, GREEN, BLUE };\n";
        let result = parse_file_impl("geo.cpp", src);
        assert!(result.error.is_none());
        let kinds: Vec<&str> = result.symbols.iter().map(|s| s.kind.as_str()).collect();
        assert!(kinds.contains(&"Struct"), "missing struct: {:?}", result.symbols);
        assert!(kinds.contains(&"Union"), "missing union: {:?}", result.symbols);
        assert!(kinds.contains(&"Enum"), "missing enum: {:?}", result.symbols);
    }

    #[test]
    fn extracts_cpp_classes() {
        let src = "class MyService {\npublic:\n    void doWork();\n};\n";
        let result = parse_file_impl("service.cpp", src);
        assert!(result.error.is_none());
        let svc = result.symbols.iter().find(|s| s.name == "MyService");
        assert!(svc.is_some(), "C++ class_specifier must be extracted: {:?}", result.symbols);
        assert_eq!(svc.unwrap().kind, "Class");
    }

    #[test]
    fn extracts_cpp_namespaces() {
        let src = "namespace net {\n    void send() {}\n}\n";
        let result = parse_file_impl("net.cpp", src);
        assert!(result.error.is_none());
        let ns = result.symbols.iter().find(|s| s.name == "net");
        assert!(ns.is_some(), "C++ namespace_definition must be extracted: {:?}", result.symbols);
        assert_eq!(ns.unwrap().kind, "Namespace");
    }

    #[test]
    fn extracts_cpp_macros() {
        let src = "#define MAX_SIZE 1024\n";
        let result = parse_file_impl("config.hpp", src);
        assert!(result.error.is_none());
        let mac = result.symbols.iter().find(|s| s.kind == "Macro");
        assert!(mac.is_some(), "C++ preproc_def must be extracted as Macro: {:?}", result.symbols);
    }

    #[test]
    fn extracts_cpp_typedefs() {
        let src = "typedef unsigned long ulong;\n";
        let result = parse_file_impl("types.cpp", src);
        assert!(result.error.is_none());
        let td = result.symbols.iter().find(|s| s.kind == "Typedef");
        assert!(td.is_some(), "C++ type_definition must be extracted as Typedef: {:?}", result.symbols);
    }

    #[test]
    fn extracts_nested_declarations() {
        let src = "namespace outer {\n    class Inner {\n    public:\n        void method() {}\n    };\n}\n";
        let result = parse_file_impl("nested.cpp", src);
        assert!(result.error.is_none());
        let names: Vec<&str> = result.symbols.iter().map(|s| s.name.as_str()).collect();
        assert!(names.contains(&"outer"), "missing namespace outer: {:?}", names);
        assert!(names.contains(&"Inner"), "missing nested class Inner: {:?}", names);
    }

    #[test]
    fn extracts_rust_const_and_traits() {
        let src = "const MAX: u32 = 100;\n\ntrait Drawable {\n    fn draw(&self);\n}\n";
        let result = parse_file_impl("lib.rs", src);
        assert!(result.error.is_none());
        let cst = result.symbols.iter().find(|s| s.name == "MAX");
        assert!(cst.is_some(), "Rust const_item must be extracted: {:?}", result.symbols);
        assert_eq!(cst.unwrap().kind, "Const");
        let tr = result.symbols.iter().find(|s| s.name == "Drawable");
        assert!(tr.is_some(), "Rust trait_item must be extracted: {:?}", result.symbols);
        assert_eq!(tr.unwrap().kind, "Trait");
    }
}

/// Kinds whose children should be traversed for nested symbol declarations.
fn is_container_node(kind: &str) -> bool {
    matches!(
        kind,
        "class_body"
            | "declaration_list"
            | "block"
            | "body"
            | "enum_body"
            | "class_declaration"
            | "abstract_class_declaration"
            | "class_definition"
            | "class_specifier"
            | "export_statement"
            | "export_default_declaration"
            | "namespace_definition"
            | "impl_item"
            | "trait_item"
            | "object_declaration"
            | "companion_object"
            | "source_file"
            | "program"
            | "translation_unit"
    )
}

const MAX_DEPTH: usize = 12;

/// Recursively extract symbol declarations from the entire tree.
/// This catches nested classes, functions inside namespaces, impl block methods,
/// Kotlin companion objects, Java inner classes, etc.
fn extract_symbols_recursive(
    node: &tree_sitter::Node,
    source: &[u8],
    symbols: &mut Vec<ExtractedSymbol>,
    depth: usize,
) {
    if depth > MAX_DEPTH {
        return;
    }

    let mut cursor = node.walk();
    if !cursor.goto_first_child() {
        return;
    }

    loop {
        let child = cursor.node();
        let kind = child.kind();

        if is_symbol_node(kind) {
            if let Some(name) = get_name(&child, source) {
                let is_exp = is_exported(&child, source);
                symbols.push(ExtractedSymbol {
                    name,
                    kind: symbol_kind(kind, &child).to_string(),
                    start_line: child.start_position().row as u32 + 1,
                    end_line: child.end_position().row as u32 + 1,
                    is_exported: is_exp,
                });
            }
            extract_symbols_recursive(&child, source, symbols, depth + 1);
        } else if kind == "export_statement" || kind == "export_default_declaration" {
            let mut inner = child.walk();
            if inner.goto_first_child() {
                loop {
                    let inner_child = inner.node();
                    if is_symbol_node(inner_child.kind()) {
                        if let Some(name) = get_name(&inner_child, source) {
                            symbols.push(ExtractedSymbol {
                                name,
                                kind: symbol_kind(inner_child.kind(), &inner_child).to_string(),
                                start_line: inner_child.start_position().row as u32 + 1,
                                end_line: inner_child.end_position().row as u32 + 1,
                                is_exported: true,
                            });
                        }
                        extract_symbols_recursive(&inner_child, source, symbols, depth + 1);
                    }
                    if !inner.goto_next_sibling() {
                        break;
                    }
                }
            }
        } else if is_container_node(kind) {
            extract_symbols_recursive(&child, source, symbols, depth + 1);
        }

        if !cursor.goto_next_sibling() {
            break;
        }
    }
}

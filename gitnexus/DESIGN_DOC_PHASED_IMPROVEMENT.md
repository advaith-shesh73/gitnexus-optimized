# GitNexus Phased Improvement Plan — Design Document

**Status**: Implemented  
**Date**: 2026-03-26  
**Scope**: 13 items across 3 phases (0A–0C, 1A–1E, 2A–2E)

---

## 1. Overview

This document records the design decisions, implementation details, and traceability for the GitNexus Phased Improvement Plan. The plan addressed three areas:

| Phase | Theme | Items |
|-------|-------|-------|
| **0 — Baseline** | Replace legacy algorithms, clean up stale data, add incremental skeleton | 0A, 0B, 0C |
| **1 — Incremental Pipeline** | Per-file reindex without full rebuild | 1A–1E |
| **2 — Rust/Performance** | Native Rust crate for parsing + resolution | 2A–2E |

### Test Baseline

| Metric | Before | After |
|--------|--------|-------|
| Rust unit tests | 0 | 33 |
| TS unit/integration tests | 4012 | 4030 |
| Pre-existing failures | 2 | 2 (unchanged) |
| Native benchmark: 1000 files | n/a | 15.7 ms |
| Native benchmark: 10K imports | n/a | 8.4 ms |

---

## 2. Phase 0 — Baseline

### 0A. Replace Graphology Leiden with In-DB Louvain

**Requirement**: Eliminate the Graphology dependency and its in-memory Leiden algorithm. Use LadybugDB's built-in Louvain (parallelized C++ via Grappolo) so community detection runs directly on the stored graph.

**Design Decisions**:

- **Deferred execution**: Louvain must run *after* the graph is loaded into LadybugDB (it operates on `PROJECT_GRAPH`), so community detection was moved from `runGraphAnalysisPhases()` (in-memory) to a new Phase 3.5 in `analyze.ts` (post-DB-load).
- **Projected graph**: Uses `PROJECT_GRAPH()` with edge type filter `['CALLS', 'EXTENDS', 'IMPLEMENTS']` to project only semantically meaningful CodeRelation edges.
- **Direct DB writes**: Community nodes and MEMBER_OF edges are created via `INSERT` queries inside LadybugDB, avoiding a round-trip to JavaScript.
- **Fallback resilience**: If detection fails, `communityResult` is set to an empty result object (not `undefined`) so downstream skill generation still proceeds.

**Files Changed**:

| File | Change |
|------|--------|
| `src/core/ingestion/community-processor.ts` | Rewritten: exported `processCommunitiesInDB(executeQuery, progressCallback)` replacing old `processCommunities()` |
| `src/core/lbug/lbug-adapter.ts` | Added `loadAlgoExtension()` with duplicate-load guard; `algoLoaded` flag reset in `closeLbug()` |
| `src/cli/analyze.ts` | Added Phase 3.5 block (post-DB-load) calling `loadAlgoExtension()` + `processCommunitiesInDB()` |
| `test/unit/cohesion-consistency.test.ts` | Updated mocks to use `executeQuery`-based API |
| `test/integration/pipeline.test.ts` | Updated expectation: communities are now `undefined` in the pipeline result (populated later in analyze.ts) |

---

### 0B. Stale File Cleanup via deleteNodesByFilePath

**Requirement**: After the blue-green atomic swap, detect and delete "ghost" nodes — files that exist in the DB but are no longer tracked by git (deleted, renamed, or `.gitignore`d).

**Design Decisions**:

- **Post-swap timing**: Runs as Phase 4.5 in `analyze.ts`, after the pending DB becomes live but before embeddings.
- **Set difference**: Loads all tracked files via `getTrackedFiles(repoPath)`, queries all `File` node paths from the DB, and computes the difference.
- **Best-effort**: Wrapped in try/catch so a failure doesn't block the rest of the pipeline.

**Files Changed**:

| File | Change |
|------|--------|
| `src/cli/analyze.ts` | Added Phase 4.5 stale-file cleanup block |
| `src/storage/git.ts` | Added `getTrackedFiles(repoPath, commit?)` — returns all tracked paths via `git ls-tree -r --name-only` |

---

### 0C. --incremental Flag Skeleton

**Requirement**: Add an `--incremental` CLI flag that detects which files changed since the last indexed commit, as a foundation for the incremental pipeline.

**Design Decisions**:

- **Git-based detection**: Uses `git diff --name-status` between `existingMeta.lastCommit` and `currentCommit` via `getChangedFiles()`.
- **Early exit**: If 0 files changed and commits match, prints "Already up to date" and returns.
- **Visibility**: Prints the changed file list (capped at 20) with git status codes (A/M/D/R).

**Files Changed**:

| File | Change |
|------|--------|
| `src/cli/index.ts` | Added `--incremental` option to the `analyze` command |
| `src/cli/analyze.ts` | Added `incremental?: boolean` to `AnalyzeOptions`; change detection block at lines 144–176 |

---

## 3. Phase 1 — Incremental Pipeline

### 1A. Affected-File Expansion via Import Graph

**Requirement**: When files change, expand the set to include their 1-hop importers so that edges from dependent files are also refreshed.

**Design Decisions**:

- **Cypher query**: `MATCH (n)-[r:CodeRelation]->(target) WHERE r.type = 'IMPORTS' AND target.filePath IN [...]` — collects `n.filePath` as importers.
- **Batch safety**: Queries in batches of 100 file paths to avoid overly long `IN` clauses.
- **Deleted files included**: Files with status `D` are excluded from `directlyChanged` (nothing to re-parse) but included in the query target set (their importers need edge cleanup).
- **Deduplication**: Returns `{directlyChanged, importers, all}` with `all` being the union.

**Files Changed**:

| File | Change |
|------|--------|
| `src/core/ingestion/incremental.ts` | Created: `expandAffectedFiles()`, `AffectedFileSet` interface |
| `src/cli/analyze.ts` | Opens existing DB, calls `expandAffectedFiles()`, displays importer count |
| `test/unit/incremental-expansion.test.ts` | 8 unit tests (no importers, 1-hop, dedup, deleted, JS, batching, renamed, error) |

---

### 1B. Per-File DETACH DELETE + Re-Parse + Re-Insert

**Requirement**: Implement the core incremental reindex loop: delete old nodes for affected files, re-parse only those files, and re-insert into the existing DB.

**Design Decisions**:

- **7-step sequential pipeline** in `analyze.ts` (lines 178–310):
  1. `deleteNodesByFilePath(affectedFiles.all)` — removes all graph nodes for affected files
  2. `runPipelineFromRepo(repoPath, ..., {fileFilter})` — re-parses only affected files
  3. `loadGraphToLbug(pipelineResult.graph, ...)` — inserts new nodes/edges
  4. `rebuildFTSIndexes()` — drop + recreate FTS (Phase 1C)
  5. Incremental embeddings (Phase 1D)
  6. Community re-detection (Phase 1E)
  7. Save metadata
- **fileFilter**: Added `fileFilter?: Set<string>` to `PipelineOptions`. The structure phase still walks all folders (needed for import context), but the parse phase only processes files in the filter.
- **Early exit**: After the incremental path completes, `process.exit(0)` — no blue-green swap needed since we mutated the live DB.

**Files Changed**:

| File | Change |
|------|--------|
| `src/core/ingestion/pipeline.ts` | Added `fileFilter` to `PipelineOptions`; filter applied before parse chunking |
| `src/cli/analyze.ts` | Full incremental pipeline implementation (Steps 1–7) with progress bar |

---

### 1C. FTS Drop + Rebuild

**Requirement**: LadybugDB's FTS extension has no per-entry update API. After incremental mutations, all FTS indexes must be dropped and recreated.

**Design Decisions**:

- **Centralized definition**: `FTS_INDEX_DEFS` constant in `lbug-adapter.ts` defines all 5 standard indexes (File, Function, Class, Method, Interface) with their name/content properties.
- **rebuildFTSIndexes()**: Iterates `FTS_INDEX_DEFS`, drops each index, then recreates it.
- **Best-effort**: Wrapped in try/catch in the incremental path.

**Files Changed**:

| File | Change |
|------|--------|
| `src/core/lbug/lbug-adapter.ts` | Added `FTS_INDEX_DEFS` constant and `rebuildFTSIndexes()` export |
| `src/cli/analyze.ts` | Step 4 of incremental path calls `rebuildFTSIndexes()` |

---

### 1D. Embedding Delta

**Requirement**: Only generate embeddings for new/changed nodes, not the entire graph.

**Design Decisions**:

- **Pre-collect existing IDs**: Before re-parsing, query `MATCH (e:CodeEmbedding) RETURN e.nodeId` into a `Set<string>`.
- **skipNodeIds parameter**: Passed to `runEmbeddingPipeline()` — the embedding loop skips any node whose ID is in the set.
- **Cascade delete**: Deleted nodes' embeddings are automatically removed by `deleteNodesByFilePath`.

**Files Changed**:

| File | Change |
|------|--------|
| `src/cli/analyze.ts` | Step 5 of incremental path: collects existing embedding IDs, passes as `skipNodeIds` |

---

### 1E. Community Re-Detection

**Requirement**: After incremental mutations, re-run Louvain to update community assignments.

**Design Decisions**:

- **Full re-detection**: Louvain is not incremental — it re-processes the entire projected graph. This is acceptable because Louvain on LadybugDB is fast (parallelized C++) and runs on the already-loaded graph.
- **Result propagated**: Assigns to `pipelineResult.communityResult` so skill generation uses fresh communities.

**Files Changed**:

| File | Change |
|------|--------|
| `src/cli/analyze.ts` | Step 6 of incremental path: `loadAlgoExtension()` + `processCommunitiesInDB()` |

---

## 4. Phase 2 — Rust / Performance

### 2A. Scaffold @gitnexus/core Rust Crate

**Requirement**: Create a Rust crate with napi-rs bindings that can be loaded as a native Node.js addon.

**Design Decisions**:

- **Crate type**: `["cdylib", "lib"]` — `cdylib` for the `.node` binary, `lib` for unit testing without Node.js runtime.
- **napi-rs v2**: Uses `#[napi]` derive macros for zero-boilerplate JS bindings.
- **Static linking**: All tree-sitter grammars compiled directly into the binary (no runtime loading).
- **Release profile**: LTO + single codegen unit + symbol stripping for minimum binary size.
- **Build script**: `npm run build:native` compiles and copies to `gitnexus-core.node` at project root.

**Files Created**:

| File | Purpose |
|------|---------|
| `native/Cargo.toml` | Crate manifest with all dependencies |
| `native/build.rs` | napi-build setup |
| `native/.cargo/config.toml` | macOS C++ linker flags for tree-sitter grammars |
| `native/src/lib.rs` | Module root + napi exports |

**Binary**: 20 MB release build (macOS arm64) with 12 grammars.

---

### 2B. Port TS/JS Symbol Extraction to Rust

**Requirement**: Implement tree-sitter CST walking in Rust for extracting functions, classes, methods, interfaces, enums, and type aliases from TypeScript/JavaScript source files.

**Design Decisions**:

- **Generic walker**: The `parse_file_impl()` function walks top-level CST children, then recurses into class bodies. Language-agnostic by design — symbol kinds are matched via `is_symbol_node()` / `symbol_kind()` tables.
- **Export detection**: Checks for parent `export_statement` node or `export` keyword prefix in source bytes.
- **Class member extraction**: `extract_members()` recurses into `class_body` / `declaration_list` / `block` containers to find nested methods.

**Files Created**:

| File | Purpose |
|------|---------|
| `native/src/ts_parser.rs` | Symbol extraction engine with 5 TS/JS unit tests |

---

### 2C. Add Remaining Languages

**Requirement**: Extend the Rust parser to support Python, Java, C, C++, C#, Go, Ruby, Rust, PHP, Kotlin, and Swift.

**Design Decisions**:

- **12 of 13 languages**: Swift was deferred because `tree-sitter-swift` 0.7.1 uses ABI version 15, which is incompatible with `tree-sitter` 0.24 (supports up to ABI 14). A comment marks the deferred integration point.
- **Kotlin**: `tree-sitter-kotlin` (official) is stuck on `tree-sitter` 0.20. Switched to `tree-sitter-kotlin-ng` 1.1, which uses the `tree-sitter-language` LanguageFn API compatible with 0.24.
- **Unified dispatch**: `get_language()` maps file extensions to grammars. `is_symbol_node()` and `symbol_kind()` tables cover all language-specific CST node kinds.
- **Generalized member extraction**: `is_body_container()` recognizes `class_body`, `declaration_list`, `block`, `body`, and `enum_body`. `is_member_node()` matches `method_definition`, `method_declaration`, `function_declaration`, `function_definition`, `function_item`, and `constructor_declaration`.

**Language Coverage**:

| Language | Grammar Crate | Status |
|----------|--------------|--------|
| TypeScript | tree-sitter-typescript 0.23 | Active |
| JavaScript | tree-sitter-javascript 0.23 | Active |
| Python | tree-sitter-python 0.23 | Active |
| Java | tree-sitter-java 0.23 | Active |
| C | tree-sitter-c 0.23 | Active |
| C++ | tree-sitter-cpp 0.23 | Active |
| C# | tree-sitter-c-sharp 0.23 | Active |
| Go | tree-sitter-go 0.23 | Active |
| Ruby | tree-sitter-ruby 0.23 | Active |
| Rust | tree-sitter-rust 0.23 | Active |
| PHP | tree-sitter-php 0.23 | Active |
| Kotlin | tree-sitter-kotlin-ng 1.1 | Active |
| Swift | tree-sitter-swift 0.7 | **Deferred** (ABI v15 incompatibility) |

**Tests Added**: 11 new language-specific unit tests (16 total in `ts_parser::tests`).

---

### 2D. Import + Call Resolution in Rust

**Requirement**: Port the TypeScript import resolver and symbol table to Rust using FxHashMap for fast lookups and rayon for parallel resolution.

**Design Decisions**:

- **FxHashMap**: Rust's `rustc-hash` crate provides FxHashMap — a non-cryptographic hash map ~2x faster than `std::HashMap` on short string keys (typical for file paths and symbol names).
- **Suffix index**: `SuffixIndex` mirrors the TypeScript `buildSuffixIndex()` — maps every path suffix to its original file path for O(1) endsWith lookups. Case-sensitive preferred, case-insensitive fallback.
- **Extension probing**: Tries 30+ extensions (`.ts`, `.tsx`, `.js`, `.py`, `.java`, etc.) in priority order, matching the TypeScript `EXTENSIONS` array.
- **Symbol table**: Dual-index structure (`file_index` for exact lookups, `global_index` for fuzzy) plus `field_by_owner` for property resolution. Mirrors the TypeScript `createSymbolTable()` API.
- **Tiered call resolution**: Three tiers with confidence scores:
  - Tier 1 (1.0): Same-file exact match
  - Tier 2 (0.9): Import-scoped match (callee found in an imported file)
  - Tier 3 (0.5): Global fuzzy match (unique callable with matching name + arity)
- **Arity filtering**: Range-based: `argCount >= requiredParameterCount && argCount <= parameterCount`.
- **Rayon parallelism**: Both `resolve_imports_parallel()` and `resolve_calls_parallel()` use `par_iter()` for data-parallel execution across CPU cores.

**Files Created**:

| File | Purpose | Tests |
|------|---------|-------|
| `native/src/import_resolver.rs` | SuffixIndex + resolve_import() | 7 tests |
| `native/src/symbol_table.rs` | FxHashMap-backed SymbolTable | 6 tests |
| `native/src/parallel_resolve.rs` | rayon-parallel import + call resolution | 4 tests |

**Dependencies Added**: `rustc-hash = "2"`, `rayon = "1.10"`

---

### 2E. Integration + Benchmarking

**Requirement**: Wire the Rust native core into the TypeScript pipeline with graceful fallback when the binary isn't available. Benchmark against the TypeScript baseline.

**Design Decisions**:

- **Lazy loading**: `native-bridge.ts` uses `createRequire()` to load `gitnexus-core.node` on first access. A singleton `_loadAttempted` flag prevents repeated load attempts.
- **Graceful fallback**: `isNativeAvailable()` returns `false` if the binary is missing. Callers check this and use the TypeScript implementation instead.
- **Status reporting**: `analyze.ts` prints "Native core: enabled (Rust)" when the binary loads successfully.
- **napi type mapping**: All Rust structs use `#[napi(object)]` for automatic JS object conversion. `Option<String>` maps to `undefined` (not `null`) in JS. `f32` confidence is cast to `f64` for JS interop.

**Files Created/Changed**:

| File | Change |
|------|--------|
| `src/core/native-bridge.ts` | Created: NativeCore interface, lazy loader, `isNativeAvailable()` |
| `src/cli/analyze.ts` | Added `isNativeAvailable` import and startup status line |
| `test/unit/native-core.test.ts` | Created: 10 tests covering parseFile, parseFiles, resolveImports, resolveCalls, and benchmarks |

**Benchmark Results** (macOS arm64, Node.js 20.17):

| Operation | Input Size | Time | Throughput |
|-----------|-----------|------|------------|
| parseFiles | 1,000 files | 15.7 ms | 63,700 files/sec |
| resolveImports | 10,000 edges | 8.4 ms | 1.19M imports/sec |
| resolveCalls (3 tiers) | 4 calls | < 1 ms | — |

---

## 5. Architecture Diagram

```
analyze.ts (CLI entry point)
│
├─ --incremental path (Phase 1)
│  ├─ getChangedFiles()                     [0C]
│  ├─ expandAffectedFiles()                 [1A]  ← queries LadybugDB IMPORTS edges
│  ├─ deleteNodesByFilePath()               [1B]
│  ├─ runPipelineFromRepo({fileFilter})     [1B]  ← re-parses only affected files
│  ├─ loadGraphToLbug()                     [1B]
│  ├─ rebuildFTSIndexes()                   [1C]
│  ├─ runEmbeddingPipeline({skipNodeIds})   [1D]
│  └─ processCommunitiesInDB()              [1E]
│
├─ Full rebuild path
│  ├─ runPipelineFromRepo()
│  ├─ loadGraphToLbug() (blue-green swap)
│  ├─ createFTSIndex()
│  ├─ processCommunitiesInDB()              [0A]
│  ├─ Stale file cleanup                    [0B]
│  └─ runEmbeddingPipeline()
│
└─ Native core (optional)                    [2E]
   └─ gitnexus-core.node (Rust via napi-rs)
      ├─ ts_parser.rs          [2A, 2B, 2C]  ← 12-language symbol extraction
      ├─ import_resolver.rs    [2D]           ← FxHashMap suffix-indexed resolution
      ├─ symbol_table.rs       [2D]           ← dual-index exact + fuzzy lookups
      └─ parallel_resolve.rs   [2D]           ← rayon-parallel import + call resolution
```

---

## 6. Known Limitations & Future Work

| Item | Detail | Follow-up |
|------|--------|-----------|
| Swift support | tree-sitter-swift 0.7.1 requires ABI v15; tree-sitter 0.24 supports up to v14 | Re-enable when tree-sitter 0.25 ships |
| Incremental FTS | LadybugDB has no per-entry FTS update API; full drop+rebuild adds ~500ms | Monitor LadybugDB releases for incremental FTS support |
| Native pipeline integration | Native core is loaded and available but not yet wired into the hot path of `processImports` / `processCallEdges` | Wire `resolveImports()` / `resolveCalls()` into pipeline.ts behind a feature flag |
| Cross-chunk accuracy | Incremental `fileFilter` may miss cross-file references outside the affected set | `--force` provides safe fallback to full rebuild |
| Rayon thread pool | Default rayon thread count (num CPUs); not yet configurable | Add `GITNEXUS_THREADS` env var or `--threads` CLI flag |
| Pre-existing test failures | 2 CLI E2E tests fail due to runtime MODULE_NOT_FOUND for algo extension | Fix module resolution for spawned CLI processes |

---

## 7. File Inventory

### New Files (10)

| File | Phase | Language |
|------|-------|----------|
| `native/Cargo.toml` | 2A | TOML |
| `native/build.rs` | 2A | Rust |
| `native/.cargo/config.toml` | 2A | TOML |
| `native/src/lib.rs` | 2A/2D/2E | Rust |
| `native/src/ts_parser.rs` | 2B/2C | Rust |
| `native/src/import_resolver.rs` | 2D | Rust |
| `native/src/symbol_table.rs` | 2D | Rust |
| `native/src/parallel_resolve.rs` | 2D | Rust |
| `src/core/native-bridge.ts` | 2E | TypeScript |
| `src/core/ingestion/incremental.ts` | 1A | TypeScript |

### Modified Files (7)

| File | Phases |
|------|--------|
| `src/core/ingestion/community-processor.ts` | 0A |
| `src/core/lbug/lbug-adapter.ts` | 0A, 1C |
| `src/cli/analyze.ts` | 0A, 0B, 0C, 1A–1E, 2E |
| `src/cli/index.ts` | 0C |
| `src/storage/git.ts` | 0B |
| `src/core/ingestion/pipeline.ts` | 1B |
| `package.json` | 2A |

### New Test Files (3)

| File | Tests | Phase |
|------|-------|-------|
| `test/unit/incremental-expansion.test.ts` | 8 | 1A |
| `test/unit/native-core.test.ts` | 10 | 2E |
| `native/src/` (inline `#[cfg(test)]`) | 33 | 2A–2D |

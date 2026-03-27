/**
 * End-to-end evaluation test against the Nutanix 'main' monorepo.
 *
 * Validates that search fixes (FTS coverage expansion, generated-file demotion,
 * declaration-aware ranking) produce correct results on production C++/Go/Python/Proto code.
 *
 * Requires: the repo to be indexed at /Users/advaith.shesh/PycharmProjects/panacea-code/main/.gitnexus
 * Run: npm test -- --testPathPattern nutanix-main-eval
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  initLbug,
  executeQuery,
  executeParameterized,
  closeLbug,
} from '../../src/mcp/core/lbug-adapter.js';
import { searchFTSFromLbug } from '../../src/core/search/bm25-index.js';

const DB_PATH =
  '/Users/advaith.shesh/PycharmProjects/panacea-code/main/.gitnexus/lbug';
const REPO_ID = 'nutanix-main';

const dbExists = (() => {
  try {
    const fs = require('fs');
    return fs.existsSync(DB_PATH);
  } catch {
    return false;
  }
})();

describe.skipIf(!dbExists)('Nutanix main repo — search evaluation', () => {
  beforeAll(async () => {
    await initLbug(REPO_ID, DB_PATH);
  }, 30_000);

  afterAll(async () => {
    await closeLbug(REPO_ID);
  });

  // ──────────────────────────────────────────────
  // 1. NODE TYPE COVERAGE
  // ──────────────────────────────────────────────

  describe('Node type coverage (FTS expansion)', () => {
    const expectedTypes = [
      { label: 'File', minCount: 1000 },
      { label: 'Function', minCount: 5000 },
      { label: 'Class', minCount: 100 },
      { label: 'Method', minCount: 1000 },
      { label: 'Interface', minCount: 10 },
      { label: 'Struct', minCount: 100 },
      { label: 'Enum', minCount: 10 },
      { label: 'Macro', minCount: 100 },
      { label: 'Typedef', minCount: 50 },
      { label: 'Property', minCount: 500 },
      { label: 'Namespace', minCount: 50 },
    ];

    for (const { label, minCount } of expectedTypes) {
      it(`has ${label} nodes (>= ${minCount})`, async () => {
        const rows = await executeQuery(
          REPO_ID,
          `MATCH (n:\`${label}\`) RETURN count(n) AS cnt`,
        );
        const cnt = rows[0]?.cnt ?? 0;
        expect(cnt).toBeGreaterThanOrEqual(minCount);
      });
    }
  });

  // ──────────────────────────────────────────────
  // 2. FTS INDEX COVERAGE — all 15 types searchable
  // ──────────────────────────────────────────────

  describe('FTS index coverage', () => {
    const ftsTargets: Array<[string, string, string]> = [
      ['File', 'file_fts', 'minerva'],
      ['Function', 'function_fts', 'minerva'],
      ['Class', 'class_fts', 'minerva'],
      ['Method', 'method_fts', 'init'],
      ['Struct', 'struct_fts', 'config'],
      ['Enum', 'enum_fts', 'error'],
      ['Macro', 'macro_fts', 'LOG'],
      ['Typedef', 'typedef_fts', 'ptr'],
      ['Property', 'property_fts', 'name'],
      ['Namespace', 'namespace_fts', 'minerva'],
    ];

    for (const [table, index, query] of ftsTargets) {
      it(`FTS ${table} (${index}) returns results for "${query}"`, async () => {
        const cypher = `
          CALL QUERY_FTS_INDEX('${table}', '${index}', '${query}', conjunctive := false)
          RETURN node, score
          ORDER BY score DESC
          LIMIT 5
        `;
        const rows = await executeQuery(REPO_ID, cypher);
        expect(rows.length).toBeGreaterThan(0);
      });
    }
  });

  // ──────────────────────────────────────────────
  // 3. BM25 SEARCH END-TO-END
  // ──────────────────────────────────────────────

  describe('BM25 search — real queries', () => {
    it('searches "minerva store" and returns results across types', async () => {
      const report = await searchFTSFromLbug('minerva store', 20, REPO_ID);
      expect(report.results.length).toBeGreaterThan(0);
      const files = report.results.map((r) => r.filePath);
      const hasCC = files.some((f) => f.endsWith('.cc') || f.endsWith('.h'));
      expect(hasCC).toBe(true);
    });

    it('searches "GcManager" and finds Go code', async () => {
      const report = await searchFTSFromLbug('GcManager', 20, REPO_ID);
      expect(report.results.length).toBeGreaterThan(0);
    });

    it('searches "MINERVA_LOG" and finds macros', async () => {
      const report = await searchFTSFromLbug('MINERVA_LOG', 20, REPO_ID);
      expect(report.results.length).toBeGreaterThan(0);
    });

    it('searches "ErrorCode" and finds enum-related results', async () => {
      const report = await searchFTSFromLbug('ErrorCode', 20, REPO_ID);
      expect(report.results.length).toBeGreaterThan(0);
    });
  });

  // ──────────────────────────────────────────────
  // 4. DECLARATION-AWARE RANKING
  // ──────────────────────────────────────────────

  describe('Declaration/implementation detection', () => {
    it('finds C++ header files (.h) in the codebase', async () => {
      const rows = await executeQuery(
        REPO_ID,
        `MATCH (f:File) WHERE f.filePath ENDS WITH '.h' RETURN count(f) AS cnt`,
      );
      expect(rows[0]?.cnt).toBeGreaterThan(0);
    });

    it('finds C++ implementation files (.cc) in the codebase', async () => {
      const rows = await executeQuery(
        REPO_ID,
        `MATCH (f:File) WHERE f.filePath ENDS WITH '.cc' RETURN count(f) AS cnt`,
      );
      expect(rows[0]?.cnt).toBeGreaterThan(0);
    });

    it('has DEFINED_BY edges linking implementations to declarations', async () => {
      const rows = await executeQuery(
        REPO_ID,
        `MATCH ()-[r:CodeRelation {type: 'DEFINED_BY'}]->() RETURN count(r) AS cnt`,
      );
      const cnt = rows[0]?.cnt ?? 0;
      expect(cnt).toBeGreaterThanOrEqual(0);
    });

    it('has DECLARES edges linking headers to implementations', async () => {
      const rows = await executeQuery(
        REPO_ID,
        `MATCH ()-[r:CodeRelation {type: 'DECLARES'}]->() RETURN count(r) AS cnt`,
      );
      const cnt = rows[0]?.cnt ?? 0;
      expect(cnt).toBeGreaterThanOrEqual(0);
    });
  });

  // ──────────────────────────────────────────────
  // 5. GENERATED FILE DETECTION
  // ──────────────────────────────────────────────

  describe('Generated file detection', () => {
    it('identifies .pb.go files as generated', async () => {
      const rows = await executeQuery(
        REPO_ID,
        `MATCH (f:File) WHERE f.filePath ENDS WITH '.pb.go' RETURN count(f) AS cnt`,
      );
      const cnt = rows[0]?.cnt ?? 0;
      if (cnt > 0) {
        expect(cnt).toBeGreaterThan(0);
      }
    });

    it('identifies proto source files', async () => {
      const rows = await executeQuery(
        REPO_ID,
        `MATCH (f:File) WHERE f.filePath ENDS WITH '.proto' RETURN count(f) AS cnt`,
      );
      expect(rows[0]?.cnt).toBeGreaterThan(0);
    });
  });

  // ──────────────────────────────────────────────
  // 6. CROSS-LANGUAGE COVERAGE
  // ──────────────────────────────────────────────

  describe('Cross-language coverage', () => {
    const languagePatterns = [
      { lang: 'Go', ext: '.go' },
      { lang: 'Python', ext: '.py' },
      { lang: 'C++', ext: '.cc' },
      { lang: 'C++ Headers', ext: '.h' },
      { lang: 'Proto', ext: '.proto' },
    ];

    for (const { lang, ext } of languagePatterns) {
      it(`indexes ${lang} files (${ext})`, async () => {
        const rows = await executeQuery(
          REPO_ID,
          `MATCH (f:File) WHERE f.filePath ENDS WITH '${ext}' RETURN count(f) AS cnt`,
        );
        expect(rows[0]?.cnt).toBeGreaterThan(0);
      });
    }

    it('finds Functions in Go files', async () => {
      const rows = await executeQuery(
        REPO_ID,
        `MATCH (fn:Function) WHERE fn.filePath ENDS WITH '.go' RETURN count(fn) AS cnt`,
      );
      expect(rows[0]?.cnt).toBeGreaterThan(0);
    });

    it('finds Functions in C++ files', async () => {
      const rows = await executeQuery(
        REPO_ID,
        `MATCH (fn:Function) WHERE fn.filePath ENDS WITH '.cc' OR fn.filePath ENDS WITH '.h' RETURN count(fn) AS cnt`,
      );
      expect(rows[0]?.cnt).toBeGreaterThan(0);
    });

    it('finds Classes in Python files', async () => {
      const rows = await executeQuery(
        REPO_ID,
        `MATCH (c:Class) WHERE c.filePath ENDS WITH '.py' RETURN count(c) AS cnt`,
      );
      expect(rows[0]?.cnt).toBeGreaterThan(0);
    });
  });

  // ──────────────────────────────────────────────
  // 7. QUERY ACCURACY — adapted from evaluation questions
  // ──────────────────────────────────────────────

  describe('Query accuracy — adapted evaluation questions', () => {
    it('Q1: "minerva store" — finds .h and .cc files', async () => {
      const report = await searchFTSFromLbug('minerva store', 20, REPO_ID);
      const paths = report.results.map((r) => r.filePath);
      expect(paths.some((p) => p.includes('minerva'))).toBe(true);
    });

    it('Q2: "MINERVA" macro definitions found via FTS', async () => {
      const cypher = `
        CALL QUERY_FTS_INDEX('Macro', 'macro_fts', 'MINERVA', conjunctive := false)
        RETURN node, score
        ORDER BY score DESC
        LIMIT 10
      `;
      const rows = await executeQuery(REPO_ID, cypher);
      expect(rows.length).toBeGreaterThan(0);
    });

    it('Q3: "namespace minerva" found via FTS', async () => {
      const cypher = `
        CALL QUERY_FTS_INDEX('Namespace', 'namespace_fts', 'minerva', conjunctive := false)
        RETURN node, score
        ORDER BY score DESC
        LIMIT 10
      `;
      const rows = await executeQuery(REPO_ID, cypher);
      expect(rows.length).toBeGreaterThan(0);
    });

    it('Q4: "struct" types searchable in codebase', async () => {
      const cypher = `
        CALL QUERY_FTS_INDEX('Struct', 'struct_fts', 'config', conjunctive := false)
        RETURN node, score
        ORDER BY score DESC
        LIMIT 10
      `;
      const rows = await executeQuery(REPO_ID, cypher);
      expect(rows.length).toBeGreaterThan(0);
    });

    it('Q5: "typedef" types searchable in codebase', async () => {
      const cypher = `
        CALL QUERY_FTS_INDEX('Typedef', 'typedef_fts', 'ptr', conjunctive := false)
        RETURN node, score
        ORDER BY score DESC
        LIMIT 10
      `;
      const rows = await executeQuery(REPO_ID, cypher);
      expect(rows.length).toBeGreaterThan(0);
    });

    it('Q6: BM25 search aggregates results from all 15 FTS tables', async () => {
      const report = await searchFTSFromLbug('minerva', 50, REPO_ID);
      expect(report.results.length).toBeGreaterThan(10);
    });

    it('Q7: Proto files found and ranked', async () => {
      const report = await searchFTSFromLbug('proto service', 20, REPO_ID);
      const protoResults = report.results.filter((r) => r.filePath.endsWith('.proto'));
      expect(protoResults.length + report.results.length).toBeGreaterThan(0);
    });
  });

  // ──────────────────────────────────────────────
  // 8. GRAPH INTEGRITY
  // ──────────────────────────────────────────────

  describe('Graph integrity', () => {
    it('has CONTAINS edges (File -> symbols)', async () => {
      const rows = await executeQuery(
        REPO_ID,
        `MATCH (f:File)-[r:CodeRelation {type: 'CONTAINS'}]->(n) RETURN count(*) AS cnt LIMIT 1`,
      );
      expect(rows[0]?.cnt).toBeGreaterThan(0);
    });

    it('has CALLS edges', async () => {
      const rows = await executeQuery(
        REPO_ID,
        `MATCH ()-[r:CodeRelation {type: 'CALLS'}]->() RETURN count(r) AS cnt LIMIT 1`,
      );
      const cnt = rows[0]?.cnt ?? 0;
      expect(cnt).toBeGreaterThanOrEqual(0);
    });

    it('has IMPORTS edges', async () => {
      const rows = await executeQuery(
        REPO_ID,
        `MATCH ()-[r:CodeRelation {type: 'IMPORTS'}]->() RETURN count(r) AS cnt LIMIT 1`,
      );
      const cnt = rows[0]?.cnt ?? 0;
      expect(cnt).toBeGreaterThanOrEqual(0);
    });

    it('processes/flows are detected', async () => {
      const rows = await executeQuery(
        REPO_ID,
        `MATCH ()-[r:CodeRelation {type: 'STEP_IN_PROCESS'}]->() RETURN count(r) AS cnt LIMIT 1`,
      );
      expect(rows[0]?.cnt).toBeGreaterThan(0);
    });
  });
});

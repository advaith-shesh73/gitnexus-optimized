import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);

function loadNative() {
  const nodePath = path.resolve(__dirname, '../../gitnexus-core.node');
  return require(nodePath);
}

let native: ReturnType<typeof loadNative> | null = null;
try {
  native = loadNative();
} catch {
  // native binary not built — skip all tests
}

describe.skipIf(!native)('Native Core (@gitnexus/core)', () => {
  describe('parseFile', () => {
    it('extracts TypeScript symbols', () => {
      const result = native!.parseFile(
        'service.ts',
        `export class UserService {
  async getUser(id: string) { return id; }
  deleteUser(id: string) {}
}

export function greet(name: string): string {
  return \`Hello \${name}\`;
}

export interface Config {
  host: string;
  port: number;
}
`);
      expect(result.error).toBeFalsy();
      const names = result.symbols.map((s: any) => s.name);
      expect(names).toContain('UserService');
      expect(names).toContain('getUser');
      expect(names).toContain('deleteUser');
      expect(names).toContain('greet');
      expect(names).toContain('Config');
    });

    it('extracts Python symbols', () => {
      const result = native!.parseFile('app.py', `
def greet(name):
    return f'Hello {name}'

class UserService:
    def get_user(self, uid):
        pass
`);
      expect(result.error).toBeFalsy();
      const names = result.symbols.map((s: any) => s.name);
      expect(names).toContain('greet');
      expect(names).toContain('UserService');
    });

    it('extracts Rust symbols', () => {
      const result = native!.parseFile('lib.rs', `
fn compute(x: i32) -> i32 { x * 2 }
struct Config { host: String }
enum Status { Active, Inactive }
`);
      expect(result.error).toBeFalsy();
      const names = result.symbols.map((s: any) => s.name);
      expect(names).toContain('compute');
      expect(names).toContain('Config');
      expect(names).toContain('Status');
    });

    it('returns error for unsupported language', () => {
      const result = native!.parseFile('main.zig', 'fn main() !void {}');
      expect(result.error).toBeTruthy();
    });
  });

  describe('parseFiles (batch)', () => {
    it('processes multiple files', () => {
      const results = native!.parseFiles([
        { path: 'a.ts', source: 'function a() {}' },
        { path: 'b.py', source: 'def b(): pass' },
        { path: 'c.go', source: 'package main\nfunc C() {}' },
      ]);
      expect(results).toHaveLength(3);
      expect(results[0].symbols[0].name).toBe('a');
      expect(results[1].symbols[0].name).toBe('b');
      expect(results[2].symbols[0].name).toBe('C');
    });
  });

  describe('resolveImports', () => {
    it('resolves relative imports', () => {
      const results = native!.resolveImports(
        [
          { sourceFile: 'src/index.ts', importPath: './utils/helper' },
          { sourceFile: 'src/index.ts', importPath: 'react' },
        ],
        ['src/index.ts', 'src/utils/helper.ts'],
      );
      expect(results).toHaveLength(1);
      expect(results[0].sourceFile).toBe('src/index.ts');
      expect(results[0].targetFile).toBe('src/utils/helper.ts');
    });

    it('resolves dotted package imports', () => {
      const results = native!.resolveImports(
        [{ sourceFile: 'Main.java', importPath: 'com.example.UserService' }],
        ['src/com/example/UserService.java'],
      );
      expect(results).toHaveLength(1);
      expect(results[0].targetFile).toBe('src/com/example/UserService.java');
    });
  });

  describe('resolveCalls', () => {
    it('resolves with tiered confidence', () => {
      const symbols = [
        { nodeId: 'a.ts::localFn', filePath: 'a.ts', name: 'localFn', kind: 'Function', parameterCount: 1, requiredParameterCount: 1 },
        { nodeId: 'b.ts::importedFn', filePath: 'b.ts', name: 'importedFn', kind: 'Function', parameterCount: 2, requiredParameterCount: 2 },
        { nodeId: 'c.ts::globalFn', filePath: 'c.ts', name: 'globalFn', kind: 'Function', parameterCount: 0, requiredParameterCount: 0 },
      ];
      const calls = [
        { filePath: 'a.ts', calleeName: 'localFn', argCount: 1 },
        { filePath: 'a.ts', calleeName: 'importedFn', argCount: 2 },
        { filePath: 'a.ts', calleeName: 'globalFn', argCount: 0 },
        { filePath: 'a.ts', calleeName: 'missing', argCount: 0 },
      ];
      const importMap = [{ filePath: 'a.ts', imports: ['b.ts'] }];

      const results = native!.resolveCalls(symbols, calls, importMap);
      expect(results).toHaveLength(3);

      const local = results.find((r: any) => r.calleeName === 'localFn');
      expect(local?.confidence).toBeCloseTo(1.0, 1);

      const imported = results.find((r: any) => r.calleeName === 'importedFn');
      expect(imported?.confidence).toBeCloseTo(0.9, 1);

      const global = results.find((r: any) => r.calleeName === 'globalFn');
      expect(global?.confidence).toBeCloseTo(0.5, 1);
    });
  });

  describe('benchmark: batch parsing', () => {
    it('parses 1000 files efficiently', () => {
      const files = Array.from({ length: 1000 }, (_, i) => ({
        path: `file${i}.ts`,
        source: `export function fn${i}(a: string, b: number): void {
  const x = a + b;
  return;
}

export class Class${i} {
  method${i}() { return ${i}; }
}
`,
      }));

      const t0 = performance.now();
      const results = native!.parseFiles(files);
      const elapsed = performance.now() - t0;

      expect(results).toHaveLength(1000);
      const totalSymbols = results.reduce((sum: number, r: any) => sum + r.symbols.length, 0);
      expect(totalSymbols).toBeGreaterThan(2500);
      console.log(`  Native: ${elapsed.toFixed(1)}ms for 1000 files (${totalSymbols} symbols)`);
      // Native should comfortably handle 1000 small files in under 5 seconds
      expect(elapsed).toBeLessThan(5000);
    });
  });

  describe('benchmark: import resolution', () => {
    it('resolves 10000 imports efficiently', () => {
      const allFiles = Array.from({ length: 500 }, (_, i) => `src/module${i}.ts`);
      const edges = Array.from({ length: 10000 }, (_, i) => ({
        sourceFile: allFiles[i % 500],
        importPath: `./module${(i + 1) % 500}`,
      }));

      const t0 = performance.now();
      const results = native!.resolveImports(edges, allFiles);
      const elapsed = performance.now() - t0;

      console.log(`  Native: ${elapsed.toFixed(1)}ms for ${edges.length} imports → ${results.length} resolved`);
      expect(results.length).toBeGreaterThan(0);
      expect(elapsed).toBeLessThan(5000);
    });
  });
});

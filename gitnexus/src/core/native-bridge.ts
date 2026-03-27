/**
 * Bridge to the Rust native core (@gitnexus/core).
 *
 * Loads the compiled .node binary via require(). If the binary is missing
 * (no Rust toolchain, CI without native build), all functions fall back to
 * null and callers should use the TypeScript implementation instead.
 *
 * NOTE: .node native addons cannot be loaded via ESM dynamic import().
 * createRequire() is the official pattern recommended by napi-rs for ESM
 * projects. This is intentional, not a CJS/ESM inconsistency.
 *
 * Usage:
 *   import { nativeCore, isNativeAvailable } from './native-bridge.js';
 *   if (isNativeAvailable) { ... use nativeCore.parseFile() ... }
 */

import { createRequire } from 'node:module';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface NativeParseResult {
  filePath: string;
  symbols: Array<{
    name: string;
    kind: string;
    startLine: number;
    endLine: number;
    isExported: boolean;
  }>;
  error: string | null;
}

export interface NativeResolvedImport {
  sourceFile: string;
  targetFile: string;
}

export interface NativeResolvedCall {
  sourceFile: string;
  calleeName: string;
  targetNodeId: string;
  targetFile: string;
  confidence: number;
}

export interface NativeCore {
  parseFile(filePath: string, source: string): NativeParseResult;
  parseFiles(files: Array<{ path: string; source: string }>): NativeParseResult[];
  resolveImports(
    edges: Array<{ sourceFile: string; importPath: string }>,
    allFiles: string[],
  ): NativeResolvedImport[];
  resolveCalls(
    symbols: Array<{
      nodeId: string;
      filePath: string;
      name: string;
      kind: string;
      parameterCount?: number;
      requiredParameterCount?: number;
      returnType?: string;
      declaredType?: string;
      ownerId?: string;
    }>,
    calls: Array<{
      filePath: string;
      calleeName: string;
      argCount: number;
    }>,
    importMapEntries: Array<{
      filePath: string;
      imports: string[];
    }>,
  ): NativeResolvedCall[];
}

let _nativeCore: NativeCore | null = null;
let _loadAttempted = false;

function tryLoadNative(): NativeCore | null {
  if (_loadAttempted) return _nativeCore;
  _loadAttempted = true;

  try {
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const require = createRequire(import.meta.url);
    // Walk up from dist/core/ to project root where gitnexus-core.node lives
    const nodePath = join(__dirname, '..', '..', 'gitnexus-core.node');
    _nativeCore = require(nodePath) as NativeCore;
  } catch {
    _nativeCore = null;
  }

  return _nativeCore;
}

/** The native core module, or null if not available. */
export function getNativeCore(): NativeCore | null {
  return tryLoadNative();
}

/** Whether the native Rust core is available. */
export function isNativeAvailable(): boolean {
  return tryLoadNative() !== null;
}

/**
 * Symbol Table Cache for Incremental Re-indexing
 *
 * Saves a lightweight index of exported symbols and import maps per-file
 * after a full pipeline run.  On incremental runs, unchanged files' symbol
 * data can be loaded from cache instead of re-parsing the entire repository
 * (O(affected) instead of O(all files)).
 *
 * The cache is advisory — if missing or stale, the pipeline falls back to
 * full re-parse transparently.
 */

import fs from 'fs/promises';
import path from 'path';
import { Worker } from 'node:worker_threads';
import type { SymbolTable } from './symbol-table.js';
import type { NodeLabel } from '../graph/types.js';

export interface CachedSymbol {
  name: string;
  nodeId: string;
  /** Stored as string in JSON; cast back to NodeLabel on load */
  type: string;
  paramCount?: number;
  reqParamCount?: number;
  returnType?: string;
  declaredType?: string;
  ownerId?: string;
}

export interface SymbolCacheEntry {
  /** Exported symbol names from this file */
  exports: string[];
  /** Relative file paths this file imports from */
  imports: string[];
  /** Full symbol definitions for resolution-context seeding */
  symbols: CachedSymbol[];
}

export interface SymbolCache {
  version: number;
  commit: string;
  files: Record<string, SymbolCacheEntry>;
}

const CACHE_VERSION = 3;
const CACHE_FILENAME = 'symbol-cache.json';
const WORKER_STRINGIFY_THRESHOLD = 50_000;

/**
 * Serialize to JSON in a worker thread to avoid blocking the event loop.
 * Uses structured clone (native V8, non-blocking) to pass data to the
 * worker, which then runs JSON.stringify in a separate OS thread.
 */
function stringifyInWorker(data: unknown): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const code = `const{parentPort,workerData}=require('node:worker_threads');parentPort.postMessage(JSON.stringify(workerData));`;
    const w = new Worker(code, { eval: true, workerData: data });
    w.once('message', (json: string) => { w.terminate(); resolve(json); });
    w.once('error', (err) => { w.terminate(); reject(err); });
  });
}

function getCachePath(storagePath: string): string {
  return path.join(storagePath, CACHE_FILENAME);
}

export async function saveSymbolCache(
  storagePath: string,
  commit: string,
  files: Record<string, SymbolCacheEntry>,
): Promise<void> {
  const cache: SymbolCache = {
    version: CACHE_VERSION,
    commit,
    files,
  };
  const entryCount = Object.keys(files).length;
  const json = entryCount > WORKER_STRINGIFY_THRESHOLD
    ? await stringifyInWorker(cache)
    : JSON.stringify(cache);
  const cachePath = getCachePath(storagePath);
  const tmpPath = cachePath + `.tmp.${process.pid}`;
  await fs.writeFile(tmpPath, json, 'utf-8');
  await fs.rename(tmpPath, cachePath);
}

export async function loadSymbolCache(
  storagePath: string,
  expectedCommit?: string,
): Promise<SymbolCache | null> {
  try {
    const raw = await fs.readFile(getCachePath(storagePath), 'utf-8');
    const parsed = JSON.parse(raw) as SymbolCache;
    if (parsed.version !== CACHE_VERSION) return null;
    if (expectedCommit && parsed.commit !== expectedCommit) return null;
    return parsed;
  } catch {
    return null;
  }
}

const CACHEABLE_LABELS = new Set([
  'Function', 'Class', 'Interface', 'Struct', 'Enum', 'Trait',
  'TypeAlias', 'Const', 'Static', 'Record', 'Union', 'Typedef', 'Macro',
  'Method', 'Constructor',
]);

/**
 * Build a SymbolCacheEntry map from a completed pipeline's graph.
 * Scans all exported symbols grouped by file (for resolution-context
 * seeding) and all IMPORTS relationships for the import map.
 */
export function buildSymbolCacheFromGraph(
  graph: { forEachNode: (fn: (n: any) => void) => void; forEachRelationship: (fn: (r: any) => void) => void },
): Record<string, SymbolCacheEntry> {
  const entries: Record<string, SymbolCacheEntry> = {};

  const getEntry = (fp: string): SymbolCacheEntry => {
    if (!entries[fp]) entries[fp] = { exports: [], imports: [], symbols: [] };
    return entries[fp];
  };

  graph.forEachNode((node: any) => {
    if (node.label === 'File' || node.label === 'Folder' || node.label === 'Community'
      || node.label === 'Process' || node.label === 'Route' || node.label === 'Tool') return;
    const fp = node.properties?.filePath;
    if (!fp) return;

    const entry = getEntry(fp);
    if (node.properties?.isExported) {
      entry.exports.push(node.properties.name);
    }

    if (CACHEABLE_LABELS.has(node.label)) {
      const cached: CachedSymbol = {
        name: node.properties.name,
        nodeId: node.id,
        type: node.label,
      };
      if (node.properties.parameterCount != null) cached.paramCount = node.properties.parameterCount;
      if (node.properties.requiredParameterCount != null) cached.reqParamCount = node.properties.requiredParameterCount;
      if (node.properties.returnType) cached.returnType = node.properties.returnType;
      if (node.properties.declaredType) cached.declaredType = node.properties.declaredType;
      if (node.properties.ownerId) cached.ownerId = node.properties.ownerId;
      entry.symbols.push(cached);
    }
  });

  const importSets = new Map<string, Set<string>>();
  graph.forEachRelationship((rel: any) => {
    if (rel.type !== 'IMPORTS') return;
    const srcParts = rel.sourceId?.split(':');
    const tgtParts = rel.targetId?.split(':');
    if (!srcParts || !tgtParts) return;
    const srcFile = srcParts.length >= 3 ? srcParts.slice(1, -1).join(':') : srcParts[1];
    const tgtFile = tgtParts.length >= 3 ? tgtParts.slice(1, -1).join(':') : tgtParts[1];
    if (srcFile && tgtFile && srcFile !== tgtFile) {
      let set = importSets.get(srcFile);
      if (!set) { set = new Set(); importSets.set(srcFile, set); }
      set.add(tgtFile);
    }
  });
  for (const [fp, set] of importSets) {
    getEntry(fp).imports = [...set];
  }

  return entries;
}

/**
 * Pre-populate a SymbolTable with cached exported symbols from a previous
 * build.  Entries for files in `skipFiles` (being re-parsed) are excluded
 * so that fresh parse results take precedence.
 *
 * @returns number of symbols seeded
 */
export function seedSymbolTableFromCache(
  symbols: SymbolTable,
  cache: SymbolCache,
  skipFiles: Set<string>,
): number {
  let seeded = 0;
  for (const [filePath, entry] of Object.entries(cache.files)) {
    if (skipFiles.has(filePath)) continue;
    for (const sym of entry.symbols) {
      symbols.add(filePath, sym.name, sym.nodeId, sym.type as NodeLabel, {
        parameterCount: sym.paramCount,
        requiredParameterCount: sym.reqParamCount,
        returnType: sym.returnType,
        declaredType: sym.declaredType,
        ownerId: sym.ownerId,
      });
      seeded++;
    }
  }
  return seeded;
}

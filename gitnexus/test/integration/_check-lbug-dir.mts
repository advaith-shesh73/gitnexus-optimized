import { initLbug, closeLbug } from '../../src/core/lbug/lbug-adapter.js';
import fs from 'fs';
import os from 'os';
import path from 'path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lbugcheck-'));
const dbPath = path.join(tmp, 'testdb');
await initLbug(dbPath);
await closeLbug();

function listDir(dir: string, indent = '') {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      console.log(`${indent}${e.name}/`);
      listDir(full, indent + '  ');
    } else {
      const st = fs.statSync(full);
      console.log(`${indent}${e.name} (${st.size} bytes)`);
    }
  }
}

listDir(tmp);
fs.rmSync(tmp, { recursive: true, force: true });

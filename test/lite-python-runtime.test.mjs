import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const py = readFileSync(new URL('../src/python-runtime.ts',import.meta.url),'utf8');
const electron = readFileSync(new URL('../electron/main.cjs',import.meta.url),'utf8');
test('portable Python fallback is available in source and Electron launcher',()=>{
  assert.match(py,/python-embed/);
  assert.match(electron,/python-embed/);
  assert.match(py,/DEFAULT_NHD_PYTHON/);
});

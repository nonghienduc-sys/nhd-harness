import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const cfg = require('../electron-builder.lite.cjs');
test('lite installer excludes private runtime, caches, database and staged binary',()=>{
  assert(cfg.files.includes('workers/**/*'));
  assert(cfg.files.includes('runtime/cloudflared.exe'));
  assert(cfg.files.includes('runtime/python-embed/**/*'));
  assert(!cfg.files.includes('runtime/**/*'));
  assert(!cfg.files.some(x=>/runtime\/(memory|.*venv|test-artifacts)/.test(x)));
  assert.equal(cfg.directories.output,'release-lite');
});

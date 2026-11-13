import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const root=new URL('../',import.meta.url);
test('Coc Coc extension exposes screenshot-free Canva semantic edit v2',async()=>{
  const dom=await readFile(new URL('browser-extension/chat-health/dom-bridge.js',root),'utf8');
  const registry=await readFile(new URL('src/mcp-registries/browser-tools.ts',root),'utf8');
  assert.match(dom,/BRIDGE_VERSION = '0\.4\.1'/);
  assert.match(dom,/command\.type==='edit_text'/);
  assert.match(dom,/dblclick/);
  assert.match(dom,/contenteditable="true"/);
  assert.match(dom,/contenteditable-semantic-v2/);
  assert.match(registry,/coc_coc_edit_text/);
  assert.match(registry,/task_run_id/);
});

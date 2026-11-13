import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('dashboard exposes hybrid remote + no-domain local harness connection state', async()=>{
  const [html,app]=await Promise.all([readFile('dashboard/index.html','utf8'),readFile('dashboard/app.js','utf8')]);
  for(const id of ['localMcpUrl','copyLocalUrl','localHarnessBadge','harnessStatus','activeHarnessList','connectionModeBadge']) assert.match(html,new RegExp(`id="${id}"`));
  assert.match(html,/Local Harness — không cần tên miền/);
  assert.match(html,/Remote MCP — Cloudflare/);
  assert.match(app,/state\.connections\?\.localIngress\?\.listening/);
  assert.match(app,/HYBRID/);
  assert.match(app,/Local Harness MCP/);
  assert.match(app,/Remote Cloudflare MCP/);
  assert.match(app,/OpenAI Private Tunnel/);
  assert.match(app,/activeHarnesses/);
  assert.match(app,/copyLocalUrl/);
});


import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const read=p=>readFileSync(new URL('../'+p,import.meta.url),'utf8');
test('Lite GitHub release checksums both portable runtimes and publishes draft',()=>{
  const wf=read('.github/workflows/release-lite.yml');
  assert.match(wf,/prepare-lite-cloudflared\.ps1/);
  assert.match(wf,/prepare-lite-python\.ps1/);
  assert.match(wf,/smoke-lite\.mjs/);
  assert.match(wf,/--draft/);
  assert.match(wf,/NHD-Harness-Lite-Setup\.exe/);
  assert.match(read('scripts/prepare-lite-cloudflared.ps1'),/2837888cc0f5d58f15b6dc478376de90b4d3ba5241c7947455d1e0a0df429712/);
});

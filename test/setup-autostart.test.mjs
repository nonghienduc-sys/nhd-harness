import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const read=rel=>readFileSync(new URL('../'+rel,import.meta.url),'utf8');
test('Cloudflare first-run provisions and requests tunnel start without reboot',()=>{
  const server=read('src/server.ts'),wizard=read('src/setup-wizard.ts'),page=read('dashboard/setup.js');
  assert.match(server,/await tunnel\.start\(\)/);
  assert.match(server,/cloudflare_start_degraded/);
  assert.match(server,/startRequested/);
  assert.match(wizard,/restartRequired:false/);
  assert.doesNotMatch(page,/Khởi động lại NHD/);
  assert.match(page,/Bật lại tunnel/);
});

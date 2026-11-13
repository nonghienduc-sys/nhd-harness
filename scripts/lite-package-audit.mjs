import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = resolve(import.meta.dirname, '..');
const cfg = require('../electron-builder.lite.cjs');
const includes = cfg.files.filter(x => !x.startsWith('!'));
const forbidden = ['runtime/**/*', 'runtime/memory', 'runtime/paddleocr-venv', 'runtime/semantic-memory-venv', 'runtime/markitdown-venv', 'runtime/pymupdf4llm-venv', 'runtime/test-artifacts'];
for (const path of forbidden) assert(!includes.includes(path), 'Private/heavy package include: '+path);
for (const path of ['workers/**/*','dist/**/*','dashboard/**/*']) assert(includes.includes(path), 'Missing required '+path);
const audit = {schemaVersion:1,profile:'lite',filesWhitelist:includes,unsafeRuntimeGlobs:false,cloudflared:existsSync(join(root,'runtime','cloudflared.exe')),pythonEmbed:existsSync(join(root,'runtime','python-embed','python.exe'))};
if (process.argv.includes('--verify')) {
  const app = join(root,'release-lite','win-unpacked','resources','app');
  assert(existsSync(app), 'Packaged application not found: '+app);
  for (const file of ['workers/background-powershell-worker.ps1','workers/background-python-worker.py','dist/server.js','dashboard/setup.html']) assert(existsSync(join(app,file)), 'Missing payload: '+file);
  const runtime = join(app, 'runtime');
  const banned = ['memory','paddleocr-venv','semantic-memory-venv','markitdown-venv','pymupdf4llm-venv','test-artifacts','release-state.json','cloudflared-2026.9.1-stage.exe'];
  for (const name of banned) assert(!existsSync(join(runtime,name)), 'Sensitive/optional runtime in payload: '+name);
  const suspicious=[];
  const walk=(dir)=>{for(const name of readdirSync(dir)){const full=join(dir,name); if(statSync(full).isDirectory()) walk(full); else if(/(^|[\\/])(?:\.env(?:\..*)?|id_rsa|credentials\.json|cert\.pem|.*\.sqlite(?:-wal|-shm)?|.*\.db)$/i.test(relative(app,full))) suspicious.push(relative(app,full));}};
  walk(app);
  assert.deepEqual(suspicious,[], 'Sensitive-looking packaged files');
  // v0.24.17: a redacted fs_read round-trip once wrote "[REDACTED]" into electron/main.cjs.
  // Refuse to ship any code file that carries the redaction marker as a value.
  const redacted=[];
  const scan=(dir)=>{ if(!existsSync(dir)) return; for(const name of readdirSync(dir)){const full=join(dir,name); if(statSync(full).isDirectory()) scan(full); else if(/\.(?:c?js|mjs|html)$/i.test(name) && /(?:[:=]\s*|\(\s*)\[REDACTED\]/.test(readFileSync(full,'utf8'))) redacted.push(relative(app,full));}};
  for (const sub of ['electron','dist','dashboard']) scan(join(app,sub));
  assert.deepEqual(redacted,[], 'Packaged code contains [REDACTED] markers');
  audit.redactionMarkersFree=true;
  audit.payloadVerified=true;
}
console.log(JSON.stringify(audit,null,2));

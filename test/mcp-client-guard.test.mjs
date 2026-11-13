import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalizeMcpUrl, inspectCodexMcpConfig, MAX_CODEX_CONFIG_BYTES } from '../dist/mcp-client-guard.js';

const withConfig=(text,fn)=>{const dir=mkdtempSync(join(tmpdir(),'nhd-mcp-guard-'));const path=join(dir,'config.toml');writeFileSync(path,text,'utf8');try{return fn(path)}finally{rmSync(dir,{recursive:true,force:true})}};
const local='http://127.0.0.1:39104/mcp';
const remote='https://mcp.nhdmcp.io.vn/mcp';

test('canonicalizeMcpUrl normalizes loopback/default ports/trailing slash without collapsing different paths',()=>{
  assert.equal(canonicalizeMcpUrl('HTTP://localhost:39104/mcp/'),'http://127.0.0.1:39104/mcp');
  assert.equal(canonicalizeMcpUrl('http://[::1]:39104/mcp'),'http://127.0.0.1:39104/mcp');
  assert.equal(canonicalizeMcpUrl('https://EXAMPLE.com:443/mcp/'),'https://example.com/mcp');
  assert.notEqual(canonicalizeMcpUrl('http://127.0.0.1:39104/other'),canonicalizeMcpUrl(local));
  assert.equal(canonicalizeMcpUrl('file:///tmp/mcp'),null);
});

test('one NHD entry is OK and exact/trailing-slash/localhost aliases are duplicate',()=>{
  withConfig(`[mcp_servers.nhd_mcp]\nurl = "${local}"\n`,path=>{
    const one=inspectCodexMcpConfig({configPath:path,knownEndpoints:[local,remote]});
    assert.equal(one.state,'ok');assert.equal(one.nhdEntryCount,1);assert.deepEqual(one.nhdEntries,['nhd_mcp']);
  });
  withConfig(`[mcp_servers.nhd_mcp]\nurl = "${local}"\n[mcp_servers.nhd_dup]\nurl = "http://localhost:39104/mcp/"\n`,path=>{
    const dup=inspectCodexMcpConfig({configPath:path,knownEndpoints:[local]});
    assert.equal(dup.state,'duplicate');assert.equal(dup.duplicateNhd,true);assert.deepEqual(dup.nhdEntries,['nhd_dup','nhd_mcp']);
  });
});

test('local plus known remote NHD is duplicate but unrelated/different path is not',()=>{
  withConfig(`[mcp_servers.local]\nurl="${local}"\n[mcp_servers.remote]\nurl="${remote}"\n[mcp_servers.other]\nurl="https://example.com/mcp"\n`,path=>{
    const result=inspectCodexMcpConfig({configPath:path,knownEndpoints:[local,remote]});
    assert.equal(result.duplicateNhd,true);assert.deepEqual(result.nhdEntries,['local','remote']);
  });
  withConfig(`[mcp_servers.nhd]\nurl="${local}"\n[mcp_servers.similar_tools]\nurl="http://127.0.0.1:39104/other"\n`,path=>{
    const result=inspectCodexMcpConfig({configPath:path,knownEndpoints:[local]});
    assert.equal(result.state,'ok');assert.deepEqual(result.nhdEntries,['nhd']);
  });
});

test('missing malformed and oversized configs fail bounded without throwing',()=>{
  const missing=inspectCodexMcpConfig({configPath:join(tmpdir(),'definitely-missing-nhd-config.toml'),knownEndpoints:[local]});
  assert.equal(missing.state,'unavailable');assert.equal(missing.available,false);
  withConfig('[mcp_servers.bad]\nurl = 123\n',path=>{const r=inspectCodexMcpConfig({configPath:path,knownEndpoints:[local]});assert.equal(r.state,'malformed');assert.equal(r.duplicateNhd,false)});
  withConfig('x'.repeat(MAX_CODEX_CONFIG_BYTES+1),path=>{const r=inspectCodexMcpConfig({configPath:path,knownEndpoints:[local]});assert.equal(r.state,'unavailable');assert.match(r.error,/guard limit/)});
});

test('guard output never echoes credential/env/header values',()=>{
  const secret='SUPER_SECRET_TOKEN_123';
  withConfig(`[mcp_servers.nhd]\nurl="${local}"\nbearer_token="${secret}"\n[mcp_servers.nhd.env]\nAPI_KEY="${secret}"\n`,path=>{
    const out=JSON.stringify(inspectCodexMcpConfig({configPath:path,knownEndpoints:[local]}));
    assert.doesNotMatch(out,new RegExp(secret));
    assert.doesNotMatch(out,/bearer_token|API_KEY/);
  });
});

test('health and dashboard expose duplicate guard without converting it into readiness degradation',async()=>{
  const { readFile }=await import('node:fs/promises');
  const [server,app]=await Promise.all([readFile('src/server.ts','utf8'),readFile('dashboard/app.js','utf8')]);
  assert.match(server,/clientMcpGuard/);
  assert.match(server,/inspectCodexMcpConfig/);
  const degraded=server.slice(server.indexOf('isDegraded:(data:any)'),server.indexOf('healthSnapshot.start()'));
  assert.doesNotMatch(degraded,/duplicateNhd|clientMcpGuard/);
  assert.match(app,/Duplicate NHD MCP Guard/);
  assert.match(app,/Duplicate NHD MCP configuration detected/);
  assert.match(app,/keep one NHD MCP/);
});

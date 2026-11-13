import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';

const serverPath=fileURLToPath(new URL('../dist/server.js',import.meta.url));
const projectRoot=fileURLToPath(new URL('..',import.meta.url));

async function freePort(){const s=createServer();await new Promise((ok,no)=>{s.once('error',no);s.listen(0,'127.0.0.1',ok)});const a=s.address();const p=a.port;await new Promise(ok=>s.close(ok));return p}
async function waitJson(url,timeout=20000){const until=Date.now()+timeout;let last;while(Date.now()<until){try{const r=await fetch(url);if(r.ok)return await r.json();last=new Error(`HTTP ${r.status}`)}catch(e){last=e}await new Promise(r=>setTimeout(r,200))}throw last||new Error(`timeout ${url}`)}

test('dual-mode server keeps remote auth and exposes a separate loopback MCP ingress over the same core',async()=>{
  const dataDir=await mkdtemp(join(tmpdir(),'nhd-dual-mode-'));
  const port=await freePort();
  const localPort=await freePort();
  const child=spawn(process.execPath,[serverPath],{cwd:projectRoot,windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,WORKSTATION_MCP_DATA_DIR:dataDir,WORKSTATION_MCP_PORT:String(port),WORKSTATION_MCP_LOCAL_PORT:String(localPort),WORKSTATION_MCP_LOCAL_ENABLED:'1',WORKSTATION_COMPANION_SECRET:'dual-mode-test-secret'}});
  let stderr=''; child.stderr.on('data',x=>stderr+=x.toString('utf8'));
  try{
    await waitJson(`http://127.0.0.1:${port}/api/health/live`);
    const localHealth=await waitJson(`http://127.0.0.1:${localPort}/health`);
    assert.equal(localHealth.model,'multi-harness-single-core-v1');
    assert.equal(localHealth.corePort,port);
    const remote=await fetch(`http://127.0.0.1:${port}/mcp`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'remote-no-auth-test',version:'1'}}})});
    assert.equal(remote.status,401);
    const local=await fetch(`http://127.0.0.1:${localPort}/mcp`,{method:'POST',headers:{'content-type':'application/json','accept':'application/json, text/event-stream','x-nhd-harness-id':'codex-test','x-nhd-connection-id':'stdio-test-1'},body:JSON.stringify({jsonrpc:'2.0',id:2,method:'initialize',params:{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'codex-test',version:'1'}}})});
    if(local.status!==200){const failureBody=await local.text();assert.fail('local MCP HTTP '+local.status+': '+failureBody);}
    const payload=await local.json();
    assert.equal(payload.jsonrpc,'2.0');
    assert.equal(payload.id,2);
    assert.ok(payload.result?.serverInfo?.name);
    const deep=await waitJson(`http://127.0.0.1:${port}/api/health`);
    assert.equal(deep.connections?.model,'multi-harness-single-core-v1');
    assert.equal(deep.connections?.localIngress?.port,localPort);
    assert.equal(deep.connections?.localIngress?.listening,true);
    assert.ok(deep.connections?.connections?.some(x=>x.harnessId==='codex-test'&&x.transport==='local-http'));
    const harnesses=await waitJson('http://127.0.0.1:'+port+'/api/harnesses');
    assert.equal(harnesses.model,'multi-harness-single-core-v1');
    assert.ok(harnesses.activeHarnesses.includes('codex-test'));
    const openAiTunnel=await waitJson('http://127.0.0.1:'+port+'/api/openai-tunnel/status');
    assert.equal(openAiTunnel.domainRequired,false);
    assert.equal(openAiTunnel.publicExposure,false);
    assert.equal(openAiTunnel.targetUrl,'http://127.0.0.1:'+localPort+'/mcp');
    assert.equal(openAiTunnel.secretsPersistedByNhd,false);
  } finally {
    child.kill();
    await new Promise(resolve=>{if(child.exitCode!=null)return resolve();child.once('exit',resolve);setTimeout(resolve,3000)});
  }
  assert.equal(stderr.includes('EADDRINUSE'),false,stderr);
});





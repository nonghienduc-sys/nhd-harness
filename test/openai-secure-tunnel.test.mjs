import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OpenAISecureTunnelService } from '../dist/openai-secure-tunnel.js';

test('OpenAI Secure MCP Tunnel stays optional, private and secret-free when client is absent', async()=>{
  const dataDir=await mkdtemp(join(tmpdir(),'nhd-openai-tunnel-'));
  const config={dataDir,localHarnessPort:39104,openAiSecureTunnelEnabled:false,openAiSecureTunnelProfile:'nhd-local',openAiTunnelClientPath:join(dataDir,'missing-tunnel-client.exe'),emergencyStop:false};
  const audit=[];
  const service=new OpenAISecureTunnelService(config,{audit:(...args)=>audit.push(args)});
  const status=service.status();
  assert.equal(status.domainRequired,false);
  assert.equal(status.publicExposure,false);
  assert.equal(status.targetUrl,'http://127.0.0.1:39104/mcp');
  assert.equal(status.binaryInstalled,false);
  assert.equal(status.configured,false);
  assert.equal(status.secretsPersistedByNhd,false);
  assert.equal(status.running,false);
  await assert.rejects(()=>service.start(),/not installed/i);
  assert.equal(audit.length,0);
});

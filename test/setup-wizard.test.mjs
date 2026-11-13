import test from 'node:test';
import assert from 'node:assert/strict';
import { cloudflareSetupPlan, cloudflareConfigYml } from '../dist/setup-wizard.js';
test('Cloudflare setup canonicalizes domain and creates stable MCP URL',()=>{
  const a=cloudflareSetupPlan({domain:' Example.COM ',subdomain:'MCP'});
  assert.equal(a.hostname,'mcp.example.com');
  assert.equal(a.mcpUrl,'https://mcp.example.com/mcp');
  assert.equal(a.tunnelName,cloudflareSetupPlan({domain:'example.com',subdomain:'mcp'}).tunnelName);
});
test('Cloudflare setup rejects invalid host and command-injection payloads',()=>{
  for(const domain of ['','localhost','example.com; calc','example.com/evil','http://example.com','a..com','example.com:443','a.com\nother'])assert.throws(()=>cloudflareSetupPlan({domain}),/không hợp lệ/);
  for(const subdomain of ['../x','mcp;whoami','-admin','mcp.x','a_b','']) {
    if (subdomain==='') continue; // empty value denotes default mcp
    assert.throws(()=>cloudflareSetupPlan({domain:'example.com',subdomain}),/không hợp lệ/);
  }
});
test('Cloudflare YAML restricts origin to loopback and includes catch-all deny',()=>{
  const id='98a39d4b-8878-4a80-b1f7-97e99fb2bf05';
  const y=cloudflareConfigYml(id,'C:\\Users\\Test\\.cloudflared\\creds.json','mcp.example.com',39100);
  assert.match(y,/127\.0\.0\.1:39100/);
  assert.match(y,/http_status:404/);
  assert.match(y,/mcp\.example\.com/);
  assert.throws(()=>cloudflareConfigYml('malicious','x','mcp.example.com'),/Invalid/);
});

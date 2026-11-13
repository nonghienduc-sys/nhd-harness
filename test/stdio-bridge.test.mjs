import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const bridgePath=fileURLToPath(new URL('../dist/stdio-bridge.js',import.meta.url));

function firstLine(stream,timeout=5000){return new Promise((resolve,reject)=>{let buf='';const timer=setTimeout(()=>{cleanup();reject(new Error('stdio response timeout'))},timeout);const onData=chunk=>{buf+=chunk.toString('utf8');const i=buf.indexOf('\n');if(i>=0){const line=buf.slice(0,i).trim();cleanup();resolve(line)}};function cleanup(){clearTimeout(timer);stream.off('data',onData)}stream.on('data',onData)})}

test('stdio bridge forwards MCP JSON-RPC to loopback HTTP without polluting stdout',async()=>{
  let observed=null;
  const server=createServer(async(req,res)=>{let body='';for await(const chunk of req)body+=chunk;observed={url:req.url,headers:req.headers,body:JSON.parse(body)};res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({jsonrpc:'2.0',id:observed.body.id,result:{serverInfo:{name:'fake-nhd',version:'1'},protocolVersion:'2025-06-18',capabilities:{}}}))});
  await new Promise((ok,no)=>{server.once('error',no);server.listen(0,'127.0.0.1',ok)});
  const port=server.address().port;
  const bridge=spawn(process.execPath,[bridgePath],{stdio:['pipe','pipe','pipe'],windowsHide:true,env:{...process.env,NHD_MCP_LOCAL_URL:`http://127.0.0.1:${port}/mcp`,NHD_MCP_HARNESS_ID:'codex-test',NHD_MCP_CONNECTION_ID:'stdio-bridge-test'}});
  let stderr='';bridge.stderr.on('data',x=>stderr+=x.toString('utf8'));
  try{
    const responseLine=firstLine(bridge.stdout);
    bridge.stdin.write(JSON.stringify({jsonrpc:'2.0',id:7,method:'initialize',params:{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'codex-test',version:'1'}}})+'\n');
    const response=JSON.parse(await responseLine);
    assert.equal(response.id,7);
    assert.equal(response.result.serverInfo.name,'fake-nhd');
    assert.equal(observed.url,'/mcp');
    assert.equal(observed.headers['x-nhd-harness-id'],'codex-test');
    assert.equal(observed.headers['x-nhd-connection-id'],'stdio-bridge-test');
    assert.equal(observed.headers['x-nhd-transport'],'stdio-proxy');
    assert.equal(stderr,'');
  } finally {
    bridge.stdin.end();
    await new Promise(resolve=>{if(bridge.exitCode!=null)return resolve();bridge.once('exit',resolve);setTimeout(resolve,2000)});
    await new Promise(resolve=>server.close(resolve));
  }
});

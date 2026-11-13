import test from 'node:test';
import assert from 'node:assert/strict';
import { CocCocBridgeService } from '../dist/coc-coc-bridge.js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
const store={audit(){},db:{prepare(){return {get(){return null}}}}};

async function deliver(bridge, tabId, resultFactory){
  for(let i=0;i<50;i++){
    const pulse=bridge.pulse({tabId,windowId:1,url:'https://www.facebook.com/',title:'transport',active:true,focused:false,visible:true,bridgeVersion:'0.4.0'});
    if(pulse.commands.length){
      for(const command of pulse.commands) bridge.resolveResult({id:command.id,ok:true,result:resultFactory(command)});
      return pulse.commands;
    }
    await sleep(5);
  }
  throw new Error('No bridge command was delivered.');
}

test('Chat Health smoke route creates only inactive chatgpt.com tab and closes only owned smoke tab',async()=>{
  const bridge=new CocCocBridgeService(store);
  bridge.pulse({tabId:1,windowId:1,url:'https://www.facebook.com/',title:'transport',active:true,focused:false,visible:true,bridgeVersion:'0.4.0'});
  await assert.rejects(()=>bridge.openChatHealthSmoke('https://example.com/'),/chatgpt\.com/);
  const opening=bridge.openChatHealthSmoke('https://chatgpt.com/c/test-smoke');
  const openCommands=await deliver(bridge,1,(command)=>{
    assert.equal(command.type,'browser_command');
    assert.equal(command.payload.action,'create_tab');
    assert.equal(command.payload.active,false);
    assert.match(String(command.payload.url),/^https:\/\/chatgpt\.com\//);
    return {tab:{tabId:99001,url:command.payload.url,active:false}};
  });
  assert.equal(openCommands.length,1);
  const opened=await opening; assert.equal(opened.tabId,99001); assert.equal(opened.ownedSmokeTab,true); assert.equal(opened.active,false);
  await assert.rejects(()=>bridge.closeChatHealthSmoke(12345),/Only a Chat Health smoke tab/);
  const closing=bridge.closeChatHealthSmoke(99001);
  const closeCommands=await deliver(bridge,1,(command)=>{
    assert.equal(command.payload.action,'close_tab'); assert.equal(command.payload.tabId,99001); return {ok:true,tabId:99001,closed:true};
  });
  assert.equal(closeCommands.length,1);
  const closed=await closing; assert.equal(closed.closed,true); assert.equal(closed.ownedSmokeTab,true);
  await assert.rejects(()=>bridge.closeChatHealthSmoke(99001),/Only a Chat Health smoke tab/);
});

test('existing workstation_health tool is transparently Fast-Health compatible without a new schema name',()=>{
  const source=readFileSync(resolve(process.cwd(),'src','mcp-registries','execution-tools.ts'),'utf8');
  const server=readFileSync(resolve(process.cwd(),'src','server.ts'),'utf8');
  assert.match(source,/server\.registerTool\("workstation_health"/);
  assert.match(source,/servedFromSnapshot:true/);
  assert.match(source,/deepFallbackUsed:true/);
  assert.match(source,/fast\.deepHealthRequired === false/);
  assert.match(server,/resumeContext:\{ available:true, deferred:true, source:"fast-health"/);
  const collector=server.slice(server.indexOf('const healthSnapshot = new HealthSnapshotService'),server.indexOf('healthSnapshot.start();'));
  assert.doesNotMatch(collector,/workspaceMemory\.bootstrap/);
  assert.match(server,/video:video\.status\(\)/);
  assert.match(server,/sensor-smoke\/open/);
  assert.match(server,/sensor-smoke\/close/);
});

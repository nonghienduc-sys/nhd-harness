import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { HealthSnapshotService } from '../dist/health-snapshot.js';
import { ToolGovernorService } from '../dist/tool-governor.js';

const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));

test('Fast Health returns cached background snapshot without probing collector on read path', async () => {
  let calls=0;
  const service=new HealthSnapshotService(async()=>({ok:true,seq:++calls}),{refreshIntervalMs:2000,staleAfterMs:6000,isDegraded:data=>data.ok?null:'bad'});
  assert.equal(service.snapshot().state,'warming');
  const refreshed=await service.refresh();
  assert.equal(calls,1);
  assert.equal(refreshed.state,'healthy');
  const a=service.snapshot(); const b=service.snapshot();
  assert.equal(calls,1);
  assert.equal(a.data.seq,1); assert.equal(b.data.seq,1);
  assert.equal(a.deepHealthRequired,false);
  service.stop();
});

function governorFixture(){
  const dir=mkdtempSync(join(tmpdir(),'nhd-recipe-v0227-'));
  const root='D:\\NHD Projects\\Word Test';
  const fakeMemory={
    stats:()=>({activeProjectRoot:root}),
    listFacts:()=>[],
    projects:{status:(input)=>({root:input||root}),listDecisions:()=>[]},
    taskRuns:{list:()=>[]},
  };
  const names=['office_live_read','office_live_preview_edit','office_live_apply_edit','context_checkpoint','workstation_health_fast','workstation_health'];
  const inventory=names.map(name=>({name,group:'Test',description:name,enabled:true,status:'enabled',permission:'read',destructive:false}));
  const governor=new ToolGovernorService({dataDir:dir,workspaceMemory:fakeMemory,inventoryProvider:()=>inventory});
  return {dir,root,governor};
}

test('Verified Recipe Compiler versions preconditions receipts and falls back instead of executing', async()=>{
  const {dir,root,governor}=governorFixture();
  try{
    governor.plan({text:'Sửa format Word trực tiếp trong tài liệu đang mở.',root});
    await governor.intercept('office_live_read',{application:'word'},{readOnlyHint:true},async()=>({ok:true}));
    await governor.intercept('office_live_preview_edit',{application:'word'}, {}, async()=>({ok:true}));
    await governor.intercept('office_live_apply_edit',{action_id:'a'}, {}, async()=>({ok:true}));
    await governor.intercept('context_checkpoint',{root,summary:'done'}, {}, async()=>({structuredContent:{stored:true}}));
    const compiled=governor.compileRecipe(root,'word_live_edit');
    assert.equal(compiled.compiled,true);
    assert.equal(compiled.compilerVersion,'1.0');
    assert.ok(compiled.recipeVersion);
    assert.deepEqual(compiled.missingTools,[]);
    assert.ok(compiled.preconditions.includes('active_office_target_observed'));
    assert.equal(compiled.parameterContract.mutationToolsStillRequireNormalPreviewRiskAndTaskAuthorization,true);

    const stale=governor.validateCompiledRecipe({root,taskClass:'word_live_edit',recipeVersion:'stale',preconditions:{active_office_target_observed:true,target_fingerprint_available:true}});
    assert.equal(stale.ready,false); assert.equal(stale.fallback,'normal_reasoning');
    assert.ok(stale.reasons.some(x=>x.includes('version')));

    const secret=governor.validateCompiledRecipe({root,taskClass:'word_live_edit',recipeVersion:compiled.recipeVersion,parameters:{password:'password=VERYSECRET123'},preconditions:{active_office_target_observed:true,target_fingerprint_available:true}});
    assert.equal(secret.ready,false); assert.ok(secret.reasons.some(x=>x.toLowerCase().includes('secret')));

    const valid=governor.validateCompiledRecipe({root,taskClass:'word_live_edit',recipeVersion:compiled.recipeVersion,parameters:{scope:'selection'},preconditions:{active_office_target_observed:true,target_fingerprint_available:true}});
    assert.equal(valid.ready,true); assert.equal(valid.fallbackRequired,false);
    assert.equal(governor.recipeReceipt(valid.receiptId).ready,true);
    assert.equal(governor.status().recipeCompiler.executesTools,false);
    assert.equal(governor.status().recipeCompiler.grantsAuthorization,false);

    const healthPlan=governor.plan({text:'kiểm tra health MCP hiện tại',root:'D:\\ChatGPT-Workstation-MCP'});
    assert.equal(healthPlan.taskClass,'mcp_health');
    assert.equal(healthPlan.recommendedTools[0],'workstation_health_fast');
    assert.ok(healthPlan.escalationTriggers.some(x=>x.includes('deepHealthRequired')));
  } finally { governor.close(); rmSync(dir,{recursive:true,force:true}); }
});

test('Chat Health sensor is event-driven delta-first with lossless full flush before handoff',()=>{
  const root=resolve(process.cwd());
  const content=readFileSync(join(root,'browser-extension','chat-health','content.js'),'utf8');
  const background=readFileSync(join(root,'browser-extension','chat-health','background.js'),'utf8');
  const server=readFileSync(join(root,'src','server.ts'),'utf8');
  assert.match(content,/SENSOR_VERSION = '0\.2\.7'/);
  assert.match(content,/SAMPLE_INTERVAL_MS = 30000/);
  assert.match(content,/collectJournalDelta/);
  assert.match(content,/journalFlushComplete/);
  assert.match(content,/MutationObserver/);
  assert.doesNotMatch(content,/report\(true\)/);
  assert.match(background,/flushRequested/);
  assert.match(server,/journalFlushComplete !== true/);
  assert.match(server,/flushRequested: true/);
  assert.match(server,/chat_health_full_flush/);
});

test('Browser speed layer exposes revision cache and verified no-replay batching',()=>{
  const source=readFileSync(resolve(process.cwd(),'src','browser.ts'),'utf8');
  assert.match(source,/domRevision\(/);
  assert.match(source,/inspectCacheHits/);
  assert.match(source,/async runBatch\(/);
  assert.match(source,/BROWSER_BATCH_ABORTED/);
  assert.match(source,/executed actions were not replayed/);
  assert.match(source,/ambiguousReplay:false/);
});

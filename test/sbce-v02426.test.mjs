// 0.24.26: floor-aware routing/verifier choice, allow_t3 scope, worker auto-restart, test port.
import test from 'node:test';import assert from 'node:assert/strict';
import{mkdtempSync,rmSync,writeFileSync}from'node:fs';import{join}from'node:path';import{tmpdir}from'node:os';
import{SbceStore}from'../dist/sbce-store.js';import{validateWorkOrder,chooseVerifier,expectedCallVnd}from'../dist/sbce-core.js';
import{runSbceShadow}from'../dist/sbce-runner.js';import{routeSbceModel}from'../dist/sbce-router.js';import{SbceProcess}from'../dist/sbce-process.js';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
// Mirrors the reconciled runtime catalog (prices and floors from the HHTECH portal, 2026-11-13).
const m=(id,family,tier,roles,vndPerM,minVndPerCall)=>({id,model:'p-'+id,provider:'hhtech',protocol:'openai',family,tier,roles,enabled:true,vndPerM,minVndPerCall,dataLabels:['internal','public/code']});
const catalog=[
 m('t1-deepseek','deepseek','T1',['coder','writer','researcher'],350,10),
 m('t1-haiku','anthropic','T1',['judge','writer','researcher'],400,0),
 m('t2-deepseek','deepseek','T2',['coder','writer'],600,1),
 m('t2-gpt','openai','T2',['writer','judge'],600,1),
 m('t3-sonnet','anthropic','T3',['coder','writer','judge'],1200,1),
];
test('expectedCallVnd = max(token cost, per-call floor)',()=>{
 assert.equal(expectedCallVnd(catalog[0],2000),10);
 assert.equal(expectedCallVnd(catalog[0],100_000),35);
 assert.ok(Math.abs(expectedCallVnd(catalog[1],2000)-0.8)<1e-9);
 assert.equal(expectedCallVnd({...catalog[1],minVndPerCall:undefined},0),0);
});
test('router prefers the floor-free model for small jobs, the cheaper per-token model for large ones',()=>{
 const args={models:catalog,role:'writer',tier:'T1',label:'internal',taskClass:'doc_write',risk:'low',stats:[],rng:()=>0.9};
 assert.equal(routeSbceModel(args).model.id,'t1-deepseek','without estimate: legacy per-token order');
 assert.equal(routeSbceModel({...args,estTokens:2500}).model.id,'t1-haiku');
 assert.equal(routeSbceModel({...args,estTokens:500_000}).model.id,'t1-deepseek');
 const warm=[{taskClass:'doc_write',modelId:'t1-deepseek',accepted:15,rejected:0},{taskClass:'doc_write',modelId:'t1-haiku',accepted:15,rejected:0}];
 assert.equal(routeSbceModel({...args,stats:warm,estTokens:2500}).model.id,'t1-haiku','Thompson score uses effective price');
});
test('verifier: cheapest expected cross-family judge across T1/T2 when estimate is given',()=>{
 const haiku=catalog[1],flash=catalog[0];
 assert.equal(chooseVerifier(catalog,flash,'internal').id,'t1-haiku','legacy: T1 first');
 assert.equal(chooseVerifier(catalog,flash,'internal',1500).id,'t1-haiku');
 assert.equal(chooseVerifier(catalog,haiku,'internal',1500).id,'t2-gpt','never same family');
 assert.equal(chooseVerifier(catalog.filter(x=>x.id!=='t2-gpt'),haiku,'internal',1500),null);
});
const order=(allow_t3)=>validateWorkOrder({title:'Escalation job',kind:'doc_write',goal:'Produce a correct small draft with verified criteria',deliverables:['artifact'],acceptance:[{type:'rubric',text:'Be accurate'}],escalation:{allow_t3}},'shadow');
async function runEscalation(allow_t3){
 const base=mkdtempSync(join(tmpdir(),'sbce-v26-')),store=new SbceStore(join(base,'db.sqlite'));
 const writers=[];
 // Every draft is too short, so L0 shape fails and the runner escalates tier after 2 attempts.
 const tracking={generate:async({model})=>{writers.push(model.id);return {text:'x',usage:{input:10,output:10,cached:0},model:model.model,protocol:'openai'};}};
 try{
  const job=store.submit(order(allow_t3),'owner-task');
  const r=await runSbceShadow({store,jobId:job.id,models:catalog,generator:tracking,artifactRoot:join(base,'a'),mode:'shadow'});
  return {r,writers};
 }finally{store.close();rmSync(base,{recursive:true,force:true});}
}
test('allow_t3=false still escalates T1→T2 but never reaches T3',async()=>{
 const {r,writers}=await runEscalation(false);
 assert.equal(r.status,'needs_brain');
 assert.ok(writers.some(id=>id.startsWith('t2-')),'reached T2: '+writers.join(','));
 assert.ok(!writers.includes('t3-sonnet'),'T3 forbidden');
 const all=await runEscalation(true);
 assert.ok(all.writers.includes('t3-sonnet'),'allow_t3=true reaches T3: '+all.writers.join(','));
});
test('SbceProcess restarts a crashed worker with bounded backoff and stops on stop()',{timeout:15000},async()=>{
 const dir=mkdtempSync(join(tmpdir(),'sbce-proc-v26-'));
 const crash=join(dir,'crash.mjs');writeFileSync(crash,'process.exit(3);\n');
 try{
  const p=new SbceProcess(dir,'shadow',{workerPath:crash,maxRestarts:3,windowMs:60_000,baseDelayMs:20});
  p.start();
  for(let i=0;i<100&&p.restartCount<3;i++)await sleep(50);
  await sleep(400);
  assert.equal(p.restartCount,3,'restart limit respected');
  const s=await p.status();assert.equal(s.status,'degraded');assert.equal(s.lastExit.code,3);
  p.stop();
  const live=join(dir,'live.mjs');writeFileSync(live,'setInterval(()=>{},1000);\n');
  const q=new SbceProcess(dir,'shadow',{workerPath:live,maxRestarts:3,baseDelayMs:20});
  q.start();await sleep(300);q.stop();await sleep(300);
  assert.equal(q.restartCount,0,'intentional stop never restarts');
 }finally{rmSync(dir,{recursive:true,force:true});}
});

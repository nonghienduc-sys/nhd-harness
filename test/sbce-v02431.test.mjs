// 0.24.31: board names the judge even when catalog models carry both writer and judge roles (live board showed "—").
import test from 'node:test';import assert from 'node:assert/strict';
import{fork}from'node:child_process';import{mkdtempSync,rmSync,writeFileSync}from'node:fs';
import{join}from'node:path';import{tmpdir}from'node:os';import{randomBytes}from'node:crypto';
import{SbceStore}from'../dist/sbce-store.js';import{validateWorkOrder}from'../dist/sbce-core.js';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const root='http://127.0.0.1:39307';
const entry=(id,family)=>({id,model:'p-'+id,provider:'hhtech',protocol:'openai',family,tier:'T1',roles:['writer','judge'],enabled:false,vndPerM:400,dataLabels:['internal']});
test('dual-role models: write, judge, write, write-retry, judge are tagged in order',{timeout:20000},async()=>{
 const dir=mkdtempSync(join(tmpdir(),'sbce-v31-')),token=randomBytes(40).toString('hex');
 writeFileSync(join(dir,'sbce-model-catalog.json'),JSON.stringify({schemaVersion:1,provider:'hhtech',models:[entry('t1-haiku','anthropic'),entry('t2-gpt','openai')]}));
 const store=new SbceStore(join(dir,'sbce.sqlite'));
 const job=store.submit(validateWorkOrder({title:'Dual role',kind:'doc_write',goal:'Write a short checklist for the role test',deliverables:['a.md'],acceptance:[{type:'rubric',text:'Clear'}]},'shadow'),'owner');
 const ins=store.db.prepare("INSERT INTO sbce_calls(id,job_id,model_id,reserved_vnd,charged_vnd,state,created_at,settled_at) VALUES(?,?,?,?,?,?,?,?)");
 ['t1-haiku','t2-gpt','t1-haiku','t1-haiku','t2-gpt'].forEach((m,i)=>ins.run(job.id+'-'+i,job.id,m,5,1,'settled','2026-11-13T00:00:0'+i+'Z','2026-11-13T00:00:0'+i+'Z'));
 store.close();
 const proc=fork('dist/sbce-worker.js',[],{cwd:process.cwd(),env:{...process.env,NHD_SBCE_MODE:'shadow',NHD_SBCE_TOKEN:token,NHD_SBCE_DATA_DIR:dir,NHD_SBCE_PORT:'39307'},stdio:['ignore','ignore','ignore','ipc']});
 const w=async path=>fetch(root+path,{headers:{'x-nhd-executor-auth':token}});
 try{
  let ok=false;for(let i=0;i<60;i++){try{if((await w('/health')).ok){ok=true;break;}}catch{}await sleep(100);}
  assert.equal(ok,true);
  const d=await(await w('/admin/jobs/'+job.id)).json();
  assert.deepEqual(d.calls.map(c=>c.role),['writer','judge','writer','writer','judge']);
  assert.deepEqual(d.writers,['t1-haiku']);assert.deepEqual(d.judges,['t2-gpt']);
 }finally{proc.kill('SIGTERM');await sleep(300);rmSync(dir,{recursive:true,force:true});}
});

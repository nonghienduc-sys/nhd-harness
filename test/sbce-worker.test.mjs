import test from 'node:test';import assert from 'node:assert/strict';
import{fork}from'node:child_process';import{mkdtempSync,rmSync,mkdirSync,writeFileSync}from'node:fs';
import{DatabaseSync}from'node:sqlite';import{join}from'node:path';import{tmpdir}from'node:os';import{randomBytes}from'node:crypto';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
// 39309: test port inside the worker's allowed range, so the test can run beside the production worker on 39300.
const root='http://127.0.0.1:39309';
test('SBCE worker is independent, auth-gated, and missing models fail closed',{timeout:20000},async()=>{
 const dir=mkdtempSync(join(tmpdir(),'sbce-worker-')),token=randomBytes(40).toString('hex');
 const proc=fork('dist/sbce-worker.js',[],{cwd:process.cwd(),env:{...process.env,NHD_SBCE_MODE:'shadow',NHD_SBCE_TOKEN:token,NHD_SBCE_DATA_DIR:dir,NHD_SBCE_PORT:'39309'},stdio:['ignore','ignore','ignore','ipc']});
 const fetchWorker=async(method,path,body,auth=token)=>fetch(root+path,{method,headers:{'x-nhd-executor-auth':auth,'content-type':'application/json'},body:body?JSON.stringify(body):undefined});
 try{
  let ok=false;for(let i=0;i<60;i++){try{const r=await fetchWorker('GET','/health');if(r.ok){ok=true;break;}}catch{}await sleep(100);}
  assert.equal(ok,true,'loopback worker starts');
  const rejected=await fetchWorker('GET','/health',undefined,'invalid');assert.equal(rejected.status,401);
  const status=await(await fetchWorker('GET','/health')).json();assert.equal(status.mode,'shadow');assert.equal(status.modelCount,0);
  const submitted=await fetchWorker('POST','/jobs',{owner:'task-e2e',work_order:{title:'Safe draft',kind:'doc_write',goal:'Write safe draft for process isolation test',deliverables:['draft.md'],acceptance:[{type:'rubric',text:'Clear text'}]}});
  assert.equal(submitted.status,200);const job=await submitted.json();assert.match(job.id,/^job-/);
  let state;for(let i=0;i<50;i++){state=await(await fetchWorker('POST','/jobs/'+job.id+'/status',{owner:'task-e2e'})).json();if(state.status==='needs_brain')break;await sleep(100);}
  assert.equal(state.status,'needs_brain');assert.equal(state.spentVnd,0);
  assert.equal((await fetchWorker('GET','/jobs/'+job.id)).status,404,'legacy unowned GET must not exist');
  assert.equal((await fetchWorker('POST','/jobs/'+job.id+'/status',{owner:'other-task'})).status,409,'cross-owner status denied');
  assert.equal((await fetchWorker('POST','/jobs/list',{owner:'other-task'})).status,200);
  assert.equal((await (await fetchWorker('POST','/jobs/list',{owner:'other-task'})).json()).jobs.length,0,'foreign list empty');
  assert.equal((await (await fetchWorker('POST','/jobs/list',{owner:'task-e2e'})).json()).jobs.length,1,'owner list present');
  const folder=join(dir,'sbce-artifacts',job.id);mkdirSync(folder,{recursive:true});
  const draft=join(folder,'draft.md');writeFileSync(draft,'Verified read-only sandbox artifact.');
  const db=new DatabaseSync(join(dir,'sbce.sqlite'));try{db.prepare('UPDATE sbce_jobs SET review_pack=? WHERE id=?').run(JSON.stringify({artifacts:{draft}}),job.id);}finally{db.close();}
  const blocked=await fetchWorker('POST','/jobs/'+job.id+'/pull',{owner:'wrong',which:'draft'});assert.equal(blocked.status,409);
  const pulled=await fetchWorker('POST','/jobs/'+job.id+'/pull',{owner:'task-e2e',which:'draft',max_chars:200});assert.equal(pulled.status,200);
  const text=await pulled.json();assert.match(text.text,/Verified read-only sandbox artifact/);
  assert.equal(text.truncated,false);
 }finally{proc.kill('SIGTERM');await sleep(300);rmSync(dir,{recursive:true,force:true});}
});

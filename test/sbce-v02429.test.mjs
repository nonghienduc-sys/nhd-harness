// 0.24.29: SBCE board on the main dashboard — job list, cost, writer/judge models, checks, draft preview, owner review.
import test from 'node:test';import assert from 'node:assert/strict';
import{fork}from'node:child_process';import{mkdtempSync,rmSync,mkdirSync,writeFileSync,readFileSync}from'node:fs';
import{join}from'node:path';import{tmpdir}from'node:os';import{randomBytes}from'node:crypto';
import{SbceStore}from'../dist/sbce-store.js';import{validateWorkOrder}from'../dist/sbce-core.js';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const root='http://127.0.0.1:39308';
const entry=(id,family,roles)=>({id,model:'p-'+id,provider:'hhtech',protocol:'openai',family,tier:'T1',roles,enabled:false,vndPerM:400,dataLabels:['internal']});
function seed(dir){
 writeFileSync(join(dir,'sbce-model-catalog.json'),JSON.stringify({schemaVersion:1,provider:'hhtech',models:[entry('writer-a','fam-a',['writer']),entry('judge-b','fam-b',['judge'])]}));
 const store=new SbceStore(join(dir,'sbce.sqlite'));
 const order=t=>validateWorkOrder({title:t,kind:'doc_write',goal:'Write a short checklist for the board test',deliverables:['a.md'],acceptance:[{type:'rubric',text:'Clear'}]},'shadow');
 const mk=(title,checks,draftText)=>{
  const job=store.submit(order(title),'task-owner');
  const folder=join(dir,'sbce-artifacts',job.id);mkdirSync(folder,{recursive:true});
  const draft=join(folder,'draft.md');writeFileSync(draft,draftText);
  const now=new Date().toISOString();
  store.db.prepare("UPDATE sbce_jobs SET status='ready_for_review',spent_vnd=3,review_pack=? WHERE id=?").run(JSON.stringify({jobId:job.id,state:'ready_for_review',summary:'ok',checks,risks:['Sandbox draft only'],costVnd:3,tokensIn:150,tokensOut:70,artifacts:{draft}}),job.id);
  const call=store.db.prepare("INSERT INTO sbce_calls(id,job_id,model_id,reserved_vnd,charged_vnd,state,created_at,settled_at) VALUES(?,?,?,?,?,?,?,?)");
  call.run(job.id+'-1',job.id,'writer-a',5,2,'settled',now,now);
  call.run(job.id+'-2',job.id,'judge-b',5,1,'settled',now+'z',now);
  return job.id;
 };
 const good=mk('Good draft',[{name:'L0_artifact_shape',ok:true},{name:'L0_no_instruction_leak',ok:true},{name:'L1_cross_family_judge',ok:true}],'# Checklist\n- [ ] Sao lưu <b>tài liệu</b> api_key=sk-abcdefghijklmnopqrstuvwxyz123456');
 const bad=mk('Bad draft',[{name:'L0_artifact_shape',ok:true},{name:'L1_cross_family_judge',ok:false}],'# Bad');
 store.close();
 return {good,bad};
}
test('worker board routes: list with cost and models, detail with redacted draft, review accept/reject',{timeout:20000},async()=>{
 const dir=mkdtempSync(join(tmpdir(),'sbce-v29-')),token=randomBytes(40).toString('hex');
 const {good,bad}=seed(dir);
 const proc=fork('dist/sbce-worker.js',[],{cwd:process.cwd(),env:{...process.env,NHD_SBCE_MODE:'shadow',NHD_SBCE_TOKEN:token,NHD_SBCE_DATA_DIR:dir,NHD_SBCE_PORT:'39308'},stdio:['ignore','ignore','ignore','ipc']});
 const w=async(method,path,body,auth=token)=>fetch(root+path,{method,headers:{'x-nhd-executor-auth':auth,'content-type':'application/json'},body:body?JSON.stringify(body):undefined});
 try{
  let ok=false;for(let i=0;i<60;i++){try{if((await w('GET','/health')).ok){ok=true;break;}}catch{}await sleep(100);}
  assert.equal(ok,true);
  assert.equal((await w('GET','/admin/jobs',undefined,'x')).status,401,'board requires the internal token');
  const list=await(await w('GET','/admin/jobs?limit=10')).json();
  assert.equal(list.jobs.length,2);assert.equal(list.totals.jobCount,2);assert.equal(list.totals.spentVnd,6);
  const g=list.jobs.find(j=>j.id===good);
  assert.equal(g.title,'Good draft');assert.deepEqual(g.writers,['writer-a']);assert.deepEqual(g.judges,['judge-b']);
  assert.equal(g.review.checks.length,3);assert.equal(g.review.hasDraft,true);
  assert.equal(JSON.stringify(list).includes('sbce-artifacts'),false,'no filesystem paths leave the worker');
  const detail=await(await w('GET','/admin/jobs/'+good)).json();
  assert.match(detail.draft.text,/Sao lưu/);assert.equal(detail.draft.text.includes('sk-abcdefghijklmnopqrstuvwxyz123456'),false,'draft secrets redacted');
  assert.equal(detail.calls.length,2);assert.deepEqual(detail.calls.map(c=>c.role),['writer','judge']);
  assert.equal((await w('POST','/admin/jobs/'+good+'/review',{decision:'revise'})).status,409,'only accept/reject');
  assert.equal((await w('POST','/admin/jobs/'+bad+'/review',{decision:'accept'})).status,409,'failed checks cannot be accepted');
  const rej=await(await w('POST','/admin/jobs/'+bad+'/review',{decision:'reject',note:'không đạt'})).json();assert.equal(rej.status,'failed');
  const acc=await(await w('POST','/admin/jobs/'+good+'/review',{decision:'accept'})).json();assert.equal(acc.status,'accepted');
  assert.equal((await w('POST','/admin/jobs/'+good+'/review',{decision:'reject'})).status,409,'no second decision');
 }finally{proc.kill('SIGTERM');await sleep(300);rmSync(dir,{recursive:true,force:true});}
});
test('core whitelist forwards only the board routes',()=>{
 const src=readFileSync('src/sbce-process.ts','utf8');
 const m=/if\(!(\/\^.*?\$\/)\.test\(path\)\)throw Error\("SBCE_INVALID_ROUTE"\)/.exec(src);assert.ok(m,'whitelist found');
 const re=eval(m[1]);const id='job-1b2c3d4e-0000-4000-8000-123456789abc';
 for(const p of['/admin','/admin/jobs','/admin/jobs?limit=50','/admin/jobs/'+id,'/admin/jobs/'+id+'/review'])assert.ok(re.test(p),p);
 for(const p of['/admin/jobs?limit=5&x=1','/admin/jobs/../session-key','/admin/jobs/'+id+'/pull','/admin/jobsx'])assert.equal(re.test(p),false,p);
});
test('server: board routes are local-only, origin-checked, and review needs owner confirmation + audit',()=>{
 const src=readFileSync('src/server.ts','utf8');
 const at=src.indexOf('app.post("/api/sbce/jobs/:id/review"');assert.ok(at>src.indexOf('app.use("/api", localOnly)'));
 const block=src.slice(at,at+900);
 assert.match(block,/sbceLocalGuard/);assert.match(block,/confirmed!==true/);assert.match(block,/store\.audit\("sbce","dashboard_review"/);
});
test('dashboard: SBCE nav + section, drafts rendered as text, review asks for confirmation',()=>{
 const html=readFileSync('dashboard/index.html','utf8'),nav=readFileSync('dashboard/redesign.js','utf8'),js=readFileSync('dashboard/sbce-panel.js','utf8');
 assert.match(nav,/data-tab="sbce"/);assert.match(html,/<section id="sbce" class="tab">/);assert.match(html,/sbce-panel\.js/);
 assert.match(js,/\$\('sbceDraft'\)\.textContent/);assert.equal(/sbceDraft'\)\.innerHTML/.test(js),false);
 assert.match(js,/window\.confirm/);assert.match(js,/confirmed: true/);
});

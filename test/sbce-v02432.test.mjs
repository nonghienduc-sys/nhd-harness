// 0.24.32: SBCE board quality stats per model (writer accept rate, cost per accepted draft, judge misses).
import test from 'node:test';import assert from 'node:assert/strict';
import{fork}from'node:child_process';import{mkdtempSync,rmSync,writeFileSync,readFileSync}from'node:fs';
import{join}from'node:path';import{tmpdir}from'node:os';import{randomBytes}from'node:crypto';import vm from'node:vm';
import{SbceStore}from'../dist/sbce-store.js';import{validateWorkOrder}from'../dist/sbce-core.js';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const root='http://127.0.0.1:39306';
const entry=(id,family,roles)=>({id,model:'p-'+id,provider:'hhtech',protocol:'openai',family,tier:'T1',roles,enabled:false,vndPerM:400,dataLabels:['internal']});
test('worker /admin/jobs returns per-model accept rate, cost and judge misses',{timeout:20000},async()=>{
 const dir=mkdtempSync(join(tmpdir(),'sbce-v32-')),token=randomBytes(40).toString('hex');
 writeFileSync(join(dir,'sbce-model-catalog.json'),JSON.stringify({schemaVersion:1,provider:'hhtech',models:[entry('w-a','fam-a',['writer']),entry('w-c','fam-c',['writer']),entry('j-b','fam-b',['judge'])]}));
 const store=new SbceStore(join(dir,'sbce.sqlite'));
 const ins=store.db.prepare("INSERT INTO sbce_calls(id,job_id,model_id,reserved_vnd,charged_vnd,state,created_at,settled_at) VALUES(?,?,?,?,?,?,?,?)");
 // [writer, status, L1 ok, writer cost, judge cost]
 const plan=[['w-a','accepted',true,2,1],['w-a','failed',true,3,1],['w-a','ready_for_review',true,1,1],['w-c','accepted',true,4,2],['w-c','failed',false,1,1]];
 plan.forEach(([w,status,ok,wc,jc],i)=>{
  const job=store.submit(validateWorkOrder({title:'Stats '+i,kind:'doc_write',goal:'Write a short checklist for the stats test',deliverables:['a.md'],acceptance:[{type:'rubric',text:'Clear'}]},'shadow'),'owner');
  store.db.prepare("UPDATE sbce_jobs SET status=?,spent_vnd=?,review_pack=? WHERE id=?").run(status,wc+jc,JSON.stringify({jobId:job.id,state:status,summary:'s',checks:[{name:'L0_artifact_shape',ok:true},{name:'L1_cross_family_judge',ok}],risks:[]}),job.id);
  ins.run(job.id+'-1',job.id,w,5,wc,'settled','2026-11-13T00:00:01Z','2026-11-13T00:00:01Z');
  ins.run(job.id+'-2',job.id,'j-b',5,jc,'settled','2026-11-13T00:00:02Z','2026-11-13T00:00:02Z');
 });
 store.close();
 const proc=fork('dist/sbce-worker.js',[],{cwd:process.cwd(),env:{...process.env,NHD_SBCE_MODE:'shadow',NHD_SBCE_TOKEN:token,NHD_SBCE_DATA_DIR:dir,NHD_SBCE_PORT:'39306'},stdio:['ignore','ignore','ignore','ipc']});
 const w=async path=>fetch(root+path,{headers:{'x-nhd-executor-auth':token}});
 try{
  let up=false;for(let i=0;i<60;i++){try{if((await w('/health')).ok){up=true;break;}}catch{}await sleep(100);}
  assert.equal(up,true);
  const d=await(await w('/admin/jobs?limit=2')).json();
  assert.equal(d.jobs.length,2,'limit still applies to the list');
  const s=d.stats;
  assert.equal(s.jobCount,5,'stats cover all recent jobs, not just the page');
  assert.equal(s.accepted,2);assert.equal(s.rejected,2);assert.equal(s.pending,1);assert.equal(s.acceptRate,50);
  assert.equal(s.l1Passed,4);assert.equal(s.l1Missed,1);
  const a=s.writers.find(x=>x.modelId==='w-a'),c=s.writers.find(x=>x.modelId==='w-c');
  assert.deepEqual([a.jobs,a.accepted,a.rejected,a.pending,a.acceptRate,a.costVnd,a.costPerAccepted],[3,1,1,1,50,6,6]);
  assert.deepEqual([c.jobs,c.accepted,c.rejected,c.acceptRate,c.costVnd,c.costPerAccepted],[2,1,1,50,5,5]);
  assert.deepEqual(s.judges,[{modelId:'j-b',jobs:5,passed:4,missed:1,costVnd:6,missRate:25}]);
 }finally{proc.kill('SIGTERM');await sleep(300);rmSync(dir,{recursive:true,force:true});}
});
test('dashboard renders the stats tables as escaped text',async()=>{
 const els={};const el=id=>els[id]??=({id,innerHTML:'',textContent:'',hidden:true,disabled:false,classList:{contains:()=>false,toggle(){},remove(){}},onclick:null,addEventListener(){}});
 const stats={jobCount:2,accepted:1,rejected:1,pending:0,acceptRate:50,l1Passed:2,l1Missed:1,writers:[{modelId:'<i>w</i>',jobs:2,accepted:1,rejected:1,pending:0,other:0,acceptRate:50,costVnd:4.5,costPerAccepted:4.5}],judges:[{modelId:'j-b',jobs:2,passed:2,missed:1,costVnd:2,missRate:50}]};
 const fetch=async url=>({ok:true,json:async()=>url==='/api/sbce/status'?{status:'online',modelCount:2}:{mode:'shadow',jobs:[],totals:{jobCount:2,spentVnd:6.5},budget:{usedVnd:1,limitVnd:2},stats}});
 const ctx={window:{},document:{readyState:'complete',getElementById:el,querySelectorAll:()=>[],addEventListener(){}},fetch,setInterval:()=>1,clearInterval(){},console};
 vm.createContext(ctx);vm.runInContext(readFileSync('dashboard/sbce-panel.js','utf8'),ctx);
 await ctx.window.loadSbceBoard();
 assert.match(el('sbceStatsSummary').textContent,/duyệt 1, trả lại 1/);assert.match(el('sbceStatsSummary').textContent,/bỏ sót 1/);
 const wr=el('sbceWriterStats').innerHTML;assert.match(wr,/&lt;i&gt;w&lt;\/i&gt;/);assert.equal(wr.includes('<i>'),false);assert.match(wr,/50%/);
 assert.match(el('sbceJudgeStats').innerHTML,/sbce-bad/);
 const html=readFileSync('dashboard/index.html','utf8');
 for(const id of['sbceStatsSummary','sbceWriterStats','sbceJudgeStats'])assert.match(html,new RegExp('id="'+id+'"'));
});

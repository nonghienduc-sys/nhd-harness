/** SBCE process: loopback-only, secret-authenticated. Never touches MCP transport. */
import express from "express";
import { readFileSync, realpathSync, statSync, existsSync, appendFileSync } from "node:fs";
import { resolve, relative, isAbsolute } from "node:path";
import { redactSecrets } from "./sbce-core.js";
import { timingSafeEqual } from "node:crypto";
import { SbceStore } from "./sbce-store.js";
import { validateWorkOrder, type SbceMode, type SbceModel } from "./sbce-core.js";
import { HhtechProvider } from "./sbce-provider.js";
import { SbceVault } from "./sbce-vault.js";
import { loadCatalogFromFile } from "./sbce-catalog.js";
import { runSbceShadow, SBCE_SAFETY_BASELINE } from "./sbce-runner.js";
import { createBenchRun, findBenchTasksDir, listBenchRuns, loadBenchTasks, readBenchSummary, stateHeader, summarizeBench } from "./sbce-bench.js";
const token=process.env.NHD_SBCE_TOKEN??"";
const mode=(process.env.NHD_SBCE_MODE??"off") as SbceMode;
if(token.length<32||!["shadow","on"].includes(mode))throw Error("SBCE_WORKER_LAUNCH_DENIED");
const dataDir=process.env.NHD_SBCE_DATA_DIR??"";
if(!dataDir)throw Error("SBCE_WORKER_DATA_DIR_REQUIRED");
const store=new SbceStore(resolve(dataDir,"sbce.sqlite"));
store.recoverInterruptedCalls();
// Any interrupted model execution is ambiguous. Never auto-replay a job after process loss.
store.db.prepare("UPDATE sbce_jobs SET status=?,reason=?,updated_at=? WHERE status IN (?,?,?,?)").run("needs_brain","SBCE_INTERRUPTED_REQUIRES_BRAIN",new Date().toISOString(),"queued","running","verifying","fixing");
const jobQueue:string[]=[];
let activeJobs=0;
const maxConcurrentJobs=3;
const vault=new SbceVault(dataDir);
const catalogPath=resolve(dataDir,"sbce-model-catalog.json");
function loadCatalog():SbceModel[]{return loadCatalogFromFile(catalogPath).models;}
let ephemeralKey:string|null=null; // P1 key injection via local-only UI; never stored in environment, logs or SQLite.
const provider=new HhtechProvider(async()=>ephemeralKey??await vault.load());
const app=express();
app.disable("x-powered-by");
app.use(express.json({limit:"256kb"})); // Code context pack ≤20k chars (UTF-8 up to ~80 KB) + work order.
app.use((req,res,next)=>{
 const value=req.get("x-nhd-executor-auth")??"";
 const a=Buffer.from(value),b=Buffer.from(token);
 if(a.length!==b.length||!timingSafeEqual(a,b))return res.status(401).json({error:"SBCE_AUTH_REQUIRED"});
 next();
});
const safe=(fn:(req:any)=>any)=>async(req:any,res:any)=>{
 try{res.json(await fn(req));}catch(e){res.status(409).json({error:e instanceof Error?e.message:String(e)});}
};
app.get("/health",safe(()=>({ok:true,mode,pid:process.pid,activeJobs,queuedJobs:jobQueue.length,hasSessionKey:Boolean(ephemeralKey),vaultConfigured:vault.configured(),modelCount:loadCatalog().filter(m=>m.enabled).length,catalogWarnings:loadCatalogFromFile(catalogPath).rejected})));
app.get("/admin",safe(()=>({mode,budget:store.budget(),catalog:loadCatalog().map(m=>({id:m.id,tier:m.tier,family:m.family,enabled:m.enabled,roles:m.roles})),catalogWarnings:loadCatalogFromFile(catalogPath).rejected,evaluation:store.evaluation(),jobCounts:{total:store.db.prepare("SELECT count(*) AS n FROM sbce_jobs").get()?.n??0}})));
// 0.24.29 dashboard board (local owner only, reached through the core's localOnly + origin guard).
function readDraft(id:string,job:any,max=8000){
 const selected=job.review?.artifacts?.draft;
 if(typeof selected!=="string"||!existsSync(selected))return null;
 const base=realpathSync(resolve(dataDir,"sbce-artifacts",id));
 const file=realpathSync(selected);
 const rel=relative(base,file);
 if(!rel||rel.startsWith("..")||isAbsolute(rel))throw Error("SBCE_ARTIFACT_PATH_DENIED");
 if(!statSync(file).isFile()||statSync(file).size>200000)throw Error("SBCE_ARTIFACT_TOO_LARGE");
 const original=readFileSync(file,"utf8");
 return {text:redactSecrets(original.slice(0,max)),totalChars:original.length,truncated:original.length>max};
}
function boardRow(job:any){
 const catalog=new Map(loadCatalog().map(m=>[m.id,m]));
 const calls=store.db.prepare("SELECT model_id,state,charged_vnd,reserved_vnd,created_at FROM sbce_calls WHERE job_id=? ORDER BY created_at,id").all(job.id) as Array<{model_id:string;state:string;charged_vnd:number|null;reserved_vnd:number;created_at:string}>;
 // Runner order: write, then a cross-family judge; after a judge comes a new write; a same-family follow-up is a write retry.
 let prevRole:"writer"|"judge"|null=null,prevFamily:string|null=null;
 const tagged=calls.map(c=>{
  const m=catalog.get(c.model_id),r=m?.roles??[],family=m?.family??c.model_id;
  let role:"writer"|"judge";
  if(r.includes("judge")&&!r.includes("writer"))role="judge";
  else if(r.includes("writer")&&!r.includes("judge"))role="writer";
  else role=prevRole==="writer"&&family!==prevFamily?"judge":"writer";
  if(role==="writer")prevFamily=family;
  prevRole=role;
  return {modelId:c.model_id,role,state:c.state,costVnd:c.charged_vnd??0,at:c.created_at};
 });
 let order:any=null;try{order=store.workOrder(job.id);}catch{}
 const title=String(order?.title??"").slice(0,200);
 const review=job.review?{state:job.review.state,summary:job.review.summary,checks:job.review.checks??[],attempts:Array.isArray(job.review.attempts)?job.review.attempts:[],risks:job.review.risks??[],needsBrain:job.review.needsBrain??null,tokensIn:job.review.tokensIn??0,tokensOut:job.review.tokensOut??0,hasDraft:typeof job.review.artifacts?.draft==="string"}:null;
 return {id:job.id,title,kind:job.kind,status:job.status,createdAt:job.createdAt,updatedAt:job.updatedAt,spentVnd:job.spentVnd,budgetVnd:job.budgetVnd,attempts:job.attempts,reason:job.reason,writers:[...new Set(tagged.filter(c=>c.role==="writer").map(c=>c.modelId))],judges:[...new Set(tagged.filter(c=>c.role==="judge").map(c=>c.modelId))],calls:tagged,review,owner:String(job.owner??"").slice(0,200),criteriaCount:Array.isArray(order?.acceptance)?order.acceptance.length:0};
}
// Checklist the Brain wrote for this job (work order). Detail view only; context_pack is never exposed.
export function boardChecklist(job:any){
 let order:any=null;try{order=store.workOrder(job.id);}catch{return null;}
 const cut=(v:any,n:number)=>typeof v==="string"?v.slice(0,n):undefined;
 return {goal:String(order.goal??"").slice(0,2000),deliverables:(order.deliverables??[]).map((d:any)=>String(d).slice(0,500)),
  acceptance:(order.acceptance??[]).map((a:any)=>({type:a.type,text:cut(a.text,1500),run:cut(a.run,500),expect:cut(a.expect,200),pattern:cut(a.pattern,500),paths:Array.isArray(a.paths)?a.paths.slice(0,30).map((x:any)=>String(x).slice(0,500)):undefined})),
  constraints:(order.constraints??[]).map((c:any)=>String(c).slice(0,1000)),risk:order.risk,applyMode:order.apply_mode,projectRoot:order.project_root??null,safety:SBCE_SAFETY_BASELINE.split(/\n- /)};
}
// 0.24.32 quality stats per model. Brain verdict: accepted/applied = duyệt; failed with a review pack = trả lại.
// "missed" = the cheap judge passed L1 but Brain still rejected: the signal that L1 alone is not enough.
export function boardStats(rows:any[]){
 const verdict=(j:any)=>j.status==="accepted"||j.status==="applied"?"accepted":j.status==="failed"&&j.review?"rejected":["queued","running","verifying","fixing","ready_for_review","needs_brain"].includes(j.status)?"pending":"other";
 const l1=(j:any)=>(j.review?.checks??[]).find((c:any)=>c.name==="L1_cross_family_judge")?.ok===true;
 const writers=new Map<string,any>(),judges=new Map<string,any>();
 const get=(m:Map<string,any>,id:string,init:any)=>{if(!m.has(id))m.set(id,{modelId:id,...init});return m.get(id);};
 let accepted=0,rejected=0,pending=0,missed=0,l1Passed=0;
 for(const j of rows){
  const v=verdict(j);
  if(v==="accepted")accepted++;else if(v==="rejected")rejected++;else if(v==="pending")pending++;
  if(l1(j)){l1Passed++;if(v==="rejected")missed++;}
  for(const id of j.writers??[]){const w=get(writers,id,{jobs:0,accepted:0,rejected:0,pending:0,other:0,costVnd:0});w.jobs++;w[v]++;}
  for(const id of j.judges??[]){const g=get(judges,id,{jobs:0,passed:0,missed:0,costVnd:0});g.jobs++;if(l1(j)){g.passed++;if(v==="rejected")g.missed++;}}
  for(const c of j.calls??[]){const m=c.role==="judge"?judges.get(c.modelId):writers.get(c.modelId);if(m)m.costVnd+=Number(c.costVnd)||0;}
 }
 const rate=(x:number,n:number)=>n>0?Math.round(x/n*1000)/10:null;
 const round=(v:number)=>Math.round(v*100)/100;
 return {
  jobCount:rows.length,accepted,rejected,pending,acceptRate:rate(accepted,accepted+rejected),l1Passed,l1Missed:missed,
  writers:[...writers.values()].map(w=>({...w,costVnd:round(w.costVnd),acceptRate:rate(w.accepted,w.accepted+w.rejected),costPerAccepted:w.accepted?round(w.costVnd/w.accepted):null})).sort((x,y)=>y.jobs-x.jobs||x.modelId.localeCompare(y.modelId)),
  judges:[...judges.values()].map(g=>({...g,costVnd:round(g.costVnd),missRate:rate(g.missed,g.passed)})).sort((x,y)=>y.jobs-x.jobs||x.modelId.localeCompare(y.modelId))
 };
}
app.get("/admin/jobs",safe(req=>{
 const limit=Math.max(1,Math.min(Number(req.query?.limit??50)||50,100));
 const all=store.list(100).map(boardRow);
 const jobs=all.slice(0,limit);
 const total=store.db.prepare("SELECT count(*) AS n,coalesce(sum(spent_vnd),0) AS vnd FROM sbce_jobs").get() as {n:number;vnd:number};
 return {mode,jobs,totals:{jobCount:total.n,spentVnd:total.vnd},budget:store.budget(),stats:boardStats(all)};
}));
app.get("/admin/jobs/:id",safe(req=>{
 const id=String(req.params.id);
 const job=store.get(id);
 return {...boardRow(job),checklist:boardChecklist(job),draft:readDraft(id,job)};
}));
app.post("/admin/jobs/:id/review",safe(req=>{
 const id=String(req.params.id);
 const decision=String(req.body?.decision??"");
 if(decision!=="accept"&&decision!=="reject")throw Error("SBCE_DECISION_INVALID");
 const note=String(req.body?.note??"").slice(0,1000);
 const job=store.get(id);
 return boardRow(store.review(id,job.owner,decision,note||("dashboard "+decision)));
}));
// P1 calibration. Probes are tiny fixed calls used to reconcile HHTECH account usage before enabling a model.
const probeLog=resolve(dataDir,"sbce-probes.jsonl");
const maxProbesPerDay=60;
function probesToday():number{
 if(!existsSync(probeLog))return 0;
 const day=new Date(Date.now()+7*3600_000).toISOString().slice(0,10); // Vietnam day
 return readFileSync(probeLog,"utf8").split(/\r?\n/).filter(l=>{try{return JSON.parse(l).vnDay===day;}catch{return false;}}).length;
}
app.get("/admin/models",safe(async()=>({models:await provider.listModels()})));
app.post("/admin/probe",safe(async(req)=>{
 const id=String(req.body?.catalog_id??"");
 const model=loadCatalog().find(m=>m.id===id);
 if(!model)throw Error("SBCE_PROBE_MODEL_NOT_IN_CATALOG");
 if(probesToday()>=maxProbesPerDay)throw Error("SBCE_PROBE_DAILY_LIMIT");
 const at=new Date();const vnDay=new Date(at.getTime()+7*3600_000).toISOString().slice(0,10);
 let record:any;
 try{
  const r=await provider.probe(model);
  record={at:at.toISOString(),vnDay,catalogId:id,model:model.model,protocol:model.protocol,ok:true,usage:r.usage,latencyMs:r.latencyMs,reply:r.text};
 }catch(e){
  record={at:at.toISOString(),vnDay,catalogId:id,model:model.model,protocol:model.protocol,ok:false,error:redactSecrets(e instanceof Error?e.message:String(e)).slice(0,180)};
 }
 appendFileSync(probeLog,JSON.stringify(record)+"\n","utf8");
 return record;
}));
// 0.24.34 model benchmark: fixed tasks with hidden tests. Separate from jobs, job budgets, the queue and the bandit.
const benchOut=resolve(dataDir,"sbce-bench");
let benchActive:ReturnType<typeof createBenchRun>|null=null;
const benchIds=(v:unknown)=>{if(v===undefined||v===null)return undefined;if(!Array.isArray(v)||v.length>50||!v.every(x=>typeof x==="string"&&/^[a-zA-Z0-9_.-]{1,100}$/.test(x)))throw Error("SBCE_BENCH_IDS_INVALID");return v as string[];};
const benchInt=(v:unknown,min:number,max:number,def:number)=>{if(v===undefined||v===null)return def;const n=Number(v);if(!Number.isInteger(n)||n<min||n>max)throw Error("SBCE_BENCH_PARAM_INVALID");return n;};
app.post("/admin/bench/start",safe(async req=>{
 if(benchActive?.state.status==="running")throw Error("SBCE_BENCH_RUNNING");
 const dir=findBenchTasksDir(process.env.NHD_SBCE_BENCH_TASKS,import.meta.url);
 if(!dir)throw Error("SBCE_BENCH_TASKS_DIR_MISSING");
 const loaded=await loadBenchTasks(dir);
 const taskIds=benchIds(req.body?.task_ids),modelIds=benchIds(req.body?.model_ids);
 const tasks=taskIds?loaded.tasks.filter(t=>taskIds.includes(t.task.id)):loaded.tasks;
 const models=loadCatalog().filter(m=>m.enabled&&(!modelIds||modelIds.includes(m.id)));
 if(!tasks.length||!models.length)throw Error("SBCE_BENCH_NOTHING_TO_RUN");
 if(!ephemeralKey&&!vault.configured())throw Error("SBCE_SESSION_KEY_REQUIRED");
 benchActive=createBenchRun({tasks,models,generator:provider,outDir:benchOut,tmpRoot:resolve(dataDir,"sbce-bench-tmp"),runs:benchInt(req.body?.runs,1,3,2),budgetVnd:benchInt(req.body?.budget_vnd,1,30000,15000),concurrency:benchInt(req.body?.concurrency,1,3,2)});
 return {run_id:benchActive.state.runId,planned_calls:benchActive.planned,task_errors:loaded.errors};
}));
app.post("/admin/bench/status",safe(async req=>{
 const id=req.body?.run_id===undefined||req.body?.run_id===null?benchActive?.state.runId:String(req.body.run_id);
 if(!id)return {active:null};
 if(benchActive&&benchActive.state.runId===id){const s=benchActive.state;return {...stateHeader(s),summary:summarizeBench(s.results,loadCatalog()),results:s.results.slice(-200)};}
 return await readBenchSummary(benchOut,id);
}));
app.post("/admin/bench/list",safe(async()=>({runs:await listBenchRuns(benchOut),active:benchActive?stateHeader(benchActive.state):null})));
app.post("/jobs/list",safe(req=>({jobs:store.listOwned(String(req.body?.owner??""),Number(req.body?.limit??20))})));
function pump(){
 while(activeJobs<maxConcurrentJobs&&jobQueue.length){
  const jobId=jobQueue.shift()!;activeJobs++;
  void runSbceShadow({store,jobId,models:loadCatalog(),generator:provider,artifactRoot:resolve(dataDir,"sbce-artifacts"),mode:mode==="on"?"on":"shadow"})
   .catch(error=>{try{store.setStatus(jobId,"needs_brain",error instanceof Error?error.message:"SBCE_EXECUTOR_FAILED");}catch{}})
   .finally(()=>{activeJobs--;setImmediate(pump);});
 }
}
app.post("/jobs",safe((req)=>{
 const order=validateWorkOrder(req.body?.work_order,mode);
 const owner=String(req.body?.owner??"").slice(0,200);
 const job=store.submit(order,owner);
 // Start in bounded background queue. No model call on the HTTP request path.
 jobQueue.push(job.id);setImmediate(pump);
 return job;
}));
app.post("/jobs/:id/status",safe(req=>store.getOwned(String(req.params.id),String(req.body?.owner??""))));
app.post("/jobs/:id/pull",safe(req=>{
 const id=String(req.params.id),owner=String(req.body?.owner??"");
 const job=store.get(id);
 if(!owner||owner!==job.owner)throw Error("SBCE_OWNER_MISMATCH");
 const which=String(req.body?.which??"draft");
 if(!["draft","diff","log"].includes(which))throw Error("SBCE_ARTIFACT_KIND_INVALID");
 const selected=job.review?.artifacts?.[which];
 if(typeof selected!=="string")throw Error("SBCE_ARTIFACT_NOT_FOUND");
 const base=realpathSync(resolve(dataDir,"sbce-artifacts",id));
 const file=realpathSync(selected);
 const rel=relative(base,file);
 if(!rel||rel.startsWith("..")||isAbsolute(rel))throw Error("SBCE_ARTIFACT_PATH_DENIED");
 if(!statSync(file).isFile()||statSync(file).size>200000)throw Error("SBCE_ARTIFACT_TOO_LARGE");
 const offset=Math.max(0,Math.min(Number(req.body?.start_char??0),200000));
 const max=Math.max(100,Math.min(Number(req.body?.max_chars??4000),8000));
 const original=readFileSync(file,"utf8");
 return {job_id:id,kind:which,offset,text:redactSecrets(original.slice(offset,offset+max)),total_chars:original.length,truncated:offset+max<original.length};
}));
app.post("/jobs/:id/cancel",safe(req=>store.cancel(String(req.params.id),String(req.body?.owner??""))));
app.post("/jobs/:id/review",safe(req=>store.review(String(req.params.id),String(req.body?.owner??""),req.body?.decision,req.body?.note)));
app.post("/session-key",safe(async(req)=>{
 // Only a local trusted dashboard/core with the random internal token can set this.
 const key=String(req.body?.key??"");
 if(key.length<12||key.length>300)throw Error("SBCE_INVALID_KEY");
 await vault.save(key);
 ephemeralKey=key;
 return {ok:true,persisted:true,protection:"Windows DPAPI CurrentUser"};
}));
const port=Number(process.env.NHD_SBCE_PORT??39300);
// Production always uses 39300 (SbceProcess). 39301-39309 exist only so tests can run beside a live worker.
if(!Number.isInteger(port)||port<39300||port>39309)throw Error("SBCE_PORT_UNEXPECTED");
const server=app.listen(port,"127.0.0.1");
server.on("error",(e)=>{console.error("SBCE worker cannot bind port",e instanceof Error?e.name:"error");process.exit(2);});
const close=()=>{ephemeralKey=null;server.close(()=>{store.close();process.exit(0);});};
process.once("SIGTERM",close);process.once("SIGINT",close);

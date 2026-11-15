/** Durable SBCE job ledger. New tables only; never mutate legacy task tables. */
import { DatabaseSync } from "node:sqlite";
import { makeFailureSignature } from "./sbce-failure-library.js";
import { SBCE_LIMITS, newJobId, reviewReceipt, type SbceWorkOrder, type SbceState } from "./sbce-core.js";
type Row={id:string;status:SbceState;created_at:string;updated_at:string;owner:string;kind:string;work_order:string;review_pack:string|null;reserved_vnd:number;spent_vnd:number;attempts:number;reason:string|null;};
/** Only jobs that can still make paid calls hold their full reservation; stopped jobs count actual spend. */
const pending=new Set<SbceState>(["queued","running","verifying","fixing"]);
export class SbceStore {
 readonly db:DatabaseSync;
 constructor(dbPath:string){
  this.db=new DatabaseSync(dbPath);
  this.db.exec("PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;");
  this.db.exec("CREATE TABLE IF NOT EXISTS sbce_jobs(id TEXT PRIMARY KEY,status TEXT NOT NULL,owner TEXT NOT NULL,kind TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,work_order TEXT NOT NULL,review_pack TEXT,reserved_vnd INTEGER NOT NULL,spent_vnd INTEGER NOT NULL DEFAULT 0,attempts INTEGER NOT NULL DEFAULT 0,reason TEXT); CREATE INDEX IF NOT EXISTS sbce_jobs_date ON sbce_jobs(created_at,status);");
  this.db.exec("CREATE TABLE IF NOT EXISTS sbce_calls(id TEXT PRIMARY KEY,job_id TEXT NOT NULL,model_id TEXT NOT NULL,reserved_vnd INTEGER NOT NULL,charged_vnd INTEGER NOT NULL DEFAULT 0,state TEXT NOT NULL,created_at TEXT NOT NULL,settled_at TEXT); CREATE INDEX IF NOT EXISTS sbce_calls_job_state ON sbce_calls(job_id,state);");
  this.db.exec("CREATE TABLE IF NOT EXISTS sbce_bandit(task_class TEXT NOT NULL,model_id TEXT NOT NULL,accepted INTEGER NOT NULL DEFAULT 0,rejected INTEGER NOT NULL DEFAULT 0,updated_at TEXT NOT NULL,PRIMARY KEY(task_class,model_id));");
  this.db.exec("CREATE TABLE IF NOT EXISTS sbce_failures(job_id TEXT NOT NULL,task_class TEXT NOT NULL,code TEXT NOT NULL,fingerprint TEXT NOT NULL,verified INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL,PRIMARY KEY(job_id,fingerprint));");
 }
 close(){this.db.close();}
 transaction<T>(fn:()=>T):T{
  this.db.exec("BEGIN IMMEDIATE");
  try{const out=fn();this.db.exec("COMMIT");return out;}catch(e){this.db.exec("ROLLBACK");throw e;}
 }
 publicRow(row:Row){
  return {applyMode:(JSON.parse(row.work_order) as {apply_mode?:string}).apply_mode??"sandbox_only",id:row.id,status:row.status,owner:row.owner,kind:row.kind,createdAt:row.created_at,updatedAt:row.updated_at,budgetVnd:row.reserved_vnd,spentVnd:row.spent_vnd,attempts:row.attempts,reason:row.reason,review:row.review_pack?JSON.parse(row.review_pack):null};
 }
 row(id:string):Row{
  const row=this.db.prepare("SELECT * FROM sbce_jobs WHERE id=?").get(id) as Row|undefined;
  if(!row)throw Error("SBCE_JOB_NOT_FOUND");return row;
 }
 get(id:string){return this.publicRow(this.row(id));}
 workOrder(id:string):SbceWorkOrder{return JSON.parse(this.row(id).work_order) as SbceWorkOrder;}
 list(limit=20){return (this.db.prepare("SELECT * FROM sbce_jobs ORDER BY created_at DESC LIMIT ?").all(Math.min(Math.max(limit,1),100)) as Row[]).map(x=>this.publicRow(x));}
 ownerRow(id:string,owner:string):Row{if(!owner)throw Error("SBCE_OWNER_REQUIRED");const row=this.row(id);if(row.owner!==owner)throw Error("SBCE_OWNER_MISMATCH");return row;}
 getOwned(id:string,owner:string){return this.publicRow(this.ownerRow(id,owner));}
 listOwned(owner:string,limit=20){if(!owner)throw Error("SBCE_OWNER_REQUIRED");return (this.db.prepare("SELECT * FROM sbce_jobs WHERE owner=? ORDER BY created_at DESC LIMIT ?").all(owner,Math.min(Math.max(limit,1),100)) as Row[]).map(x=>this.publicRow(x));}
 budget(at=new Date()){
  const day=new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Ho_Chi_Minh",year:"numeric",month:"2-digit",day:"2-digit"}).format(at);
  const start=new Date(day+"T00:00:00+07:00");const end=new Date(start.getTime()+86400000);
  const rows=this.db.prepare("SELECT status,reserved_vnd,spent_vnd FROM sbce_jobs WHERE created_at>=? AND created_at<?").all(start.toISOString(),end.toISOString()) as Pick<Row,"status"|"reserved_vnd"|"spent_vnd">[];
  const used=rows.reduce((s,r)=>s+(pending.has(r.status)?r.reserved_vnd:r.spent_vnd),0);
  return {day,usedVnd:used,remainingVnd:Math.max(0,SBCE_LIMITS.perDayVnd-used),limitVnd:SBCE_LIMITS.perDayVnd};
 }
 submit(order:SbceWorkOrder,owner:string){
  if(!owner||owner.length>200)throw Error("SBCE_OWNER_REQUIRED");
  return this.transaction(()=>{
   const requested=order.budget.vnd;
   if(requested>this.budget().remainingVnd)throw Error("SBCE_DAILY_BUDGET_EXCEEDED");
   const id=newJobId(),at=new Date().toISOString();
   this.db.prepare("INSERT INTO sbce_jobs(id,status,owner,kind,created_at,updated_at,work_order,reserved_vnd) VALUES(?,?,?,?,?,?,?,?)").run(id,"queued",owner,order.kind,at,at,JSON.stringify(order),requested);
   this.db.prepare("UPDATE sbce_jobs SET status='cancelled',reason=?,updated_at=? WHERE owner=? AND status='needs_brain' AND id<>?").run("SBCE_SUPERSEDED_BY:"+id,at,owner,id);
   return this.get(id);
  });
 }
 setStatus(id:string,state:SbceState,reason?:string){
  return this.transaction(()=>{
   const row=this.row(id);
   if(["applied","cancelled","failed"].includes(row.status))throw Error("SBCE_TERMINAL_JOB");
   if(state==="accepted"&&!["ready_for_review"].includes(row.status))throw Error("SBCE_REVIEW_REQUIRED");
   if(state==="applied")throw Error("SBCE_APPLY_REQUIRES_EXISTING_PREVIEW_APPLY");
   this.db.prepare("UPDATE sbce_jobs SET status=?,updated_at=?,reason=? WHERE id=?").run(state,new Date().toISOString(),reason??null,id);
   return this.get(id);
  });
 }
 /** Atomic before-call budget reservation. Prevents overlapping model calls overspending a single job. */
 reserveCall(id:string,modelId:string,maxChargeVnd:number){
  if(!Number.isSafeInteger(maxChargeVnd)||maxChargeVnd<1||maxChargeVnd>SBCE_LIMITS.perJobVnd)throw Error("SBCE_INVALID_CALL_RESERVATION");
  if(!/^[a-zA-Z0-9_.-]{2,100}$/.test(modelId))throw Error("SBCE_INVALID_MODEL_ID");
  return this.transaction(()=>{
   const job=this.row(id);
   if(!["running","verifying","fixing"].includes(job.status))throw Error("SBCE_JOB_NOT_RUNNING");
   const active=this.db.prepare("SELECT COALESCE(sum(reserved_vnd),0) AS total FROM sbce_calls WHERE job_id=? AND state=?").get(id,"reserved") as {total:number};
   if(job.spent_vnd+active.total+maxChargeVnd>job.reserved_vnd)throw Error("SBCE_JOB_BUDGET_EXCEEDED");
   const callId="call-"+newJobId(),now=new Date().toISOString();
   this.db.prepare("INSERT INTO sbce_calls(id,job_id,model_id,reserved_vnd,state,created_at) VALUES(?,?,?,?,?,?)").run(callId,id,modelId,maxChargeVnd,"reserved",now);
   return {callId,reservedVnd:maxChargeVnd,remainingVnd:job.reserved_vnd-job.spent_vnd-active.total-maxChargeVnd};
  });
 }
 /** Actual provider failure/timeout can still bill; ambiguous settlement charges reserved maximum. */
 settleCall(callId:string,actualVnd:number|null){
  return this.transaction(()=>{
   const call=this.db.prepare("SELECT * FROM sbce_calls WHERE id=?").get(callId) as {job_id:string;reserved_vnd:number;state:string}|undefined;
   if(!call||call.state!=="reserved")throw Error("SBCE_CALL_NOT_ACTIVE");
   if(actualVnd!==null&&(!Number.isSafeInteger(actualVnd)||actualVnd<0))throw Error("SBCE_INVALID_COST");
   const uncertain=actualVnd===null||actualVnd>call.reserved_vnd;
   const charged=actualVnd===null?call.reserved_vnd:actualVnd;
   const now=new Date().toISOString();
   this.db.prepare("UPDATE sbce_calls SET state=?,charged_vnd=?,settled_at=? WHERE id=?").run(uncertain?"uncertain":"settled",charged,now,callId);
   this.db.prepare("UPDATE sbce_jobs SET spent_vnd=spent_vnd+?,attempts=attempts+1,updated_at=? WHERE id=?").run(charged,now,call.job_id);
   if(actualVnd!==null&&actualVnd>call.reserved_vnd)this.db.prepare("UPDATE sbce_jobs SET status=?,reason=? WHERE id=? AND status NOT IN (?,?,?)").run("needs_brain","SBCE_CALL_BILLING_EXCEEDS_CEILING",call.job_id,"cancelled","failed","applied");
   return this.get(call.job_id);
  });
 }
 /** Restart reconciliation: never silently replay ambiguous paid requests or drop reserved cost. */
 recoverInterruptedCalls(){
  return this.transaction(()=>{
   const items=this.db.prepare("SELECT id,reserved_vnd,job_id FROM sbce_calls WHERE state='reserved'").all() as Array<{id:string;reserved_vnd:number;job_id:string}>;
   const now=new Date().toISOString();
   for(const item of items){
    this.db.prepare("UPDATE sbce_calls SET state='uncertain',charged_vnd=reserved_vnd,settled_at=? WHERE id=?").run(now,item.id);
    this.db.prepare("UPDATE sbce_jobs SET spent_vnd=spent_vnd+?,attempts=attempts+1,status=CASE WHEN status IN ('cancelled','failed','applied') THEN status ELSE 'needs_brain' END,reason=?,updated_at=? WHERE id=?").run(item.reserved_vnd,"SBCE_INTERRUPTED_BILLING_UNCERTAIN",now,item.job_id);
   }
   return items.length;
  });
 }
 /** Aggregate, privacy-safe evaluation: never returns source text, prompts or job identifiers. */
 evaluation(){
  const jobs=this.db.prepare("SELECT status,count(*) AS n,sum(spent_vnd) AS vnd FROM sbce_jobs GROUP BY status").all() as Array<{status:string;n:number;vnd:number|null}>;
  const calls=this.db.prepare("SELECT model_id,state,count(*) AS n,sum(charged_vnd) AS vnd FROM sbce_calls GROUP BY model_id,state").all() as Array<{model_id:string;state:string;n:number;vnd:number|null}>;
  const total=jobs.reduce((sum,r)=>sum+r.n,0),ready=jobs.filter(r=>r.status==="ready_for_review"||r.status==="accepted").reduce((sum,r)=>sum+r.n,0);
  return {kind:"sbce_observed_jobs",benchmarkStatus:"not_benchmarked",jobCount:total,readyOrAccepted:ready,estimatedCostVnd:jobs.reduce((s,r)=>s+(r.vnd??0),0),states:jobs.map(r=>({state:r.status,count:r.n,estimatedCostVnd:r.vnd??0})),modelCalls:calls.map(r=>({modelId:r.model_id,settlement:r.state,count:r.n,estimatedCostVnd:r.vnd??0}))};
 }
 modelStats(taskClass:string){return this.db.prepare("SELECT task_class AS taskClass,model_id AS modelId,accepted,rejected FROM sbce_bandit WHERE task_class=?").all(taskClass) as Array<{taskClass:string;modelId:string;accepted:number;rejected:number}>;}
 verifiedFailureHints(taskClass:string,limit=5){return this.db.prepare("SELECT code,count(*) AS observations FROM sbce_failures WHERE task_class=? AND verified=1 GROUP BY code ORDER BY observations DESC LIMIT ?").all(taskClass,Math.min(Math.max(limit,1),10)) as Array<{code:string;observations:number}>;}
 recordFailureObservation(id:string,code:string,diagnostic:string){
  const job=this.row(id);if(!["running","fixing","verifying"].includes(job.status))return;
  const signature=makeFailureSignature(job.kind,code,diagnostic);
  this.db.prepare("INSERT OR IGNORE INTO sbce_failures(job_id,task_class,code,fingerprint,created_at) VALUES(?,?,?,?,?)").run(id,signature.taskClass,signature.code,signature.fingerprint,new Date().toISOString());
 }
 recordCost(id:string,vnd:number){
  if(!Number.isFinite(vnd)||vnd<0||!Number.isInteger(vnd))throw Error("SBCE_INVALID_COST");
  return this.transaction(()=>{
   const row=this.row(id);
   if(row.spent_vnd+vnd>row.reserved_vnd)throw Error("SBCE_JOB_BUDGET_EXCEEDED");
   this.db.prepare("UPDATE sbce_jobs SET spent_vnd=spent_vnd+?,attempts=attempts+1,updated_at=? WHERE id=?").run(vnd,new Date().toISOString(),id);
   return this.get(id);
  });
 }
 putReview(id:string,input:Parameters<typeof reviewReceipt>[0]){
  if(id!==input.jobId)throw Error("SBCE_JOB_MISMATCH");
  const result=reviewReceipt(input);
  return this.transaction(()=>{
   const row=this.row(id);
   if(["cancelled","failed","applied"].includes(row.status))throw Error("SBCE_TERMINAL_JOB");
   this.db.prepare("UPDATE sbce_jobs SET review_pack=?,status=?,updated_at=? WHERE id=?").run(JSON.stringify(result),input.state,new Date().toISOString(),id);
   return this.get(id);
  });
 }
 review(id:string,owner:string,decision:"accept"|"reject"|"revise",note?:string){
  return this.transaction(()=>{
   const row=this.row(id);
   if(row.owner!==owner)throw Error("SBCE_OWNER_MISMATCH");
   if(row.status==="needs_brain"&&decision==="reject"){this.db.prepare("UPDATE sbce_jobs SET status='failed',reason=?,updated_at=? WHERE id=?").run((note??"SBCE_CLOSED_BY_BRAIN").slice(0,1000),new Date().toISOString(),id);return this.get(id);}
   if(row.status!=="ready_for_review")throw Error("SBCE_NOT_READY_FOR_REVIEW");
   if(!row.review_pack)throw Error("SBCE_REVIEW_PACK_MISSING");
   const pack=JSON.parse(row.review_pack) as {checks?:Array<{ok:boolean}>};
   if(decision==="accept"&&(!pack.checks?.length||pack.checks.some(x=>x.ok!==true)))throw Error("SBCE_CHECKS_NOT_PASSED");
   const next:SbceState=decision==="accept"?"accepted":decision==="reject"?"failed":"needs_brain";
   if(decision==="accept")this.db.prepare("UPDATE sbce_failures SET verified=1 WHERE job_id=?").run(id);
   if(decision==="accept"||decision==="reject"){
    const producer=this.db.prepare("SELECT model_id FROM sbce_calls WHERE job_id=? ORDER BY created_at,id LIMIT 1").get(id) as {model_id:string}|undefined;
    if(producer)this.db.prepare("INSERT INTO sbce_bandit(task_class,model_id,accepted,rejected,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(task_class,model_id) DO UPDATE SET accepted=accepted+excluded.accepted,rejected=rejected+excluded.rejected,updated_at=excluded.updated_at").run(row.kind,producer.model_id,decision==="accept"?1:0,decision==="reject"?1:0,new Date().toISOString());
   }
   this.db.prepare("UPDATE sbce_jobs SET status=?,reason=?,updated_at=? WHERE id=?").run(next,(note??decision).slice(0,1000),new Date().toISOString(),id);
   return this.get(id);
  });
 }
 cancel(id:string,owner:string){
  return this.transaction(()=>{
   const row=this.row(id);if(row.owner!==owner)throw Error("SBCE_OWNER_MISMATCH");
   if(row.status==="applied")throw Error("SBCE_ALREADY_APPLIED");
   this.db.prepare("UPDATE sbce_jobs SET status='cancelled',updated_at=? WHERE id=?").run(new Date().toISOString(),id);
   return this.get(id);
  });
 }
}

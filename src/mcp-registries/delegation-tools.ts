/** SBCE facade: only three additive MCP tools, all delegated to localhost worker. */
import { z } from "zod";
import { win32 } from "node:path";
import { workOrderSchema } from "../sbce-core.js";
import { buildContextPack,CONTEXT_BUDGET,type ContextEvidence } from "../sbce-context.js";
import { failure, result, readOnly, reversibleMutation, type ToolRegistryContext } from "./shared.js";
import type { SbceProcess } from "../sbce-process.js";
const taskId=z.string().min(1).max(256);
const jobId=z.string().regex(/^job-[0-9a-f-]{36}$/);
/** `file:src/a.ts`, `file:src/a.ts#L120-260` or `file:src/a.ts:120-260` (max 300 lines per ref). */
export function parseFileRef(ref:string):{path:string;start:number;end:number}|null{
 const m=/^file:(.+?)(?:(?:#L|:)(\d{1,6})(?:-L?(\d{1,6}))?)?$/.exec(ref);
 if(!m||!m[1])return null;
 const start=Math.max(1,Number(m[2]??1));
 const requestedEnd=m[3]?Number(m[3]):m[2]?start+199:200;
 if(requestedEnd<start)return null;
 return {path:m[1],start,end:Math.min(requestedEnd,start+299)};
}
async function collectContext(ctx:ToolRegistryContext,order:ReturnType<typeof workOrderSchema.parse>){
 if(!order.project_root||!order.context_refs.length)return null;
 const root=win32.resolve(order.project_root);
 const codeJob=order.kind==="code_change"||order.kind==="test_write";
 const budget=codeJob?CONTEXT_BUDGET.code:CONTEXT_BUDGET.text;
 const evidence:ContextEvidence[]=[];
 for(const ref of order.context_refs.slice(0,12)){
  try{
   if(ref.startsWith("file:")){
    const parsed=parseFileRef(ref);if(!parsed)continue;
    const local=parsed.path.replaceAll("/","\\");
    if(!local||win32.isAbsolute(local)||local.includes("..")||local.includes(":"))continue;
    const target=win32.resolve(root,local),rel=win32.relative(root,target);
    if(rel.startsWith("..")||win32.isAbsolute(rel))continue;
    const data=ctx.runtime.files.readWithMeta(target,parsed.start,parsed.end,budget.perSnippet);
    if(data.redacted||!data.text.trim())continue;
    // Line-numbered so the executor can write correct @@ hunk headers.
    // Keep only whole lines that fit, so no line is cut mid-way and the locator stays exact.
    const kept:string[]=[];let size=0;
    for(const [i,line] of data.text.split("\n").entries()){
     const numberedLine=String(parsed.start+i).padStart(5," ")+"| "+line;
     if(size+numberedLine.length+1>budget.perSnippet)break;
     kept.push(numberedLine);size+=numberedLine.length+1;
    }
    if(!kept.length)continue;
    const relPath=rel.replaceAll("\\","/"),end=parsed.start+kept.length-1;
    evidence.push({source:relPath,locator:relPath+":"+parsed.start+"-"+end,snippet:kept.join("\n"),label:codeJob?"public/code":"internal"});
   }else if(ref.startsWith("rag:")&&ctx.projectRag){
    const query=ref.slice(4).includes("?q=")?new URLSearchParams(ref.slice(4).split("?")[1]).get("q")??"":ref.slice(4);
    if(!query||query.length>300)continue;
    const data=await ctx.projectRag.query(root,query,3,3500);
    for(const hit of data.results??[]){
     if(!hit.citation?.locator||!hit.text)continue;
     evidence.push({source:String(hit.source),locator:String(hit.citation.locator),snippet:String(hit.text),label:"internal"});
    }
   }
  }catch{/* Skip invalid/stale evidence; never invent it. */}
 }
 const pack=buildContextPack(evidence.slice(0,12),budget.total,budget.perSnippet); // schema allows ≤12 items
 return pack.evidence.length?{evidence:pack.evidence,sha256:pack.sha256,untrusted:true as const}:null;
}
export function registerDelegationTools(ctx:ToolRegistryContext,executor:SbceProcess){
 const {server,runtime}=ctx;
 const requireTask=(id:string)=>{
  if(!runtime.taskRuns)throw Error("SBCE_TASK_RUNTIME_UNAVAILABLE");
  runtime.store.requireExistingTaskRun(id);
  return id;
 };
 server.registerTool("delegate_task",{
  description:"SBCE work order delegation. Use for repetitive code/drafts only. Default disabled; when enabled, sandbox-only proposals require machine verification and Brain review. Never authorizes release or workstation actions.",
  inputSchema:{action:z.enum(["submit","status","list","cancel","answer"]),task_run_id:taskId.optional(),job_id:jobId.optional(),work_order:z.unknown().optional(),wait_s:z.number().int().min(0).max(25).optional(),answer:z.string().max(2000).optional()},
  annotations:reversibleMutation
 },async(input)=>{
  try{
   if(executor.mode==="off")return result({status:"disabled",mode:"off"});
   if(input.action==="list"){if(!input.task_run_id)throw Error("SBCE_TASK_RUN_REQUIRED");return result(await executor.request("POST","/jobs/list",{owner:requireTask(input.task_run_id)}));}
   if(input.action==="submit"){
    if(!input.task_run_id)throw Error("SBCE_TASK_RUN_REQUIRED");
    requireTask(input.task_run_id);
    const order=workOrderSchema.parse(input.work_order);
    const gathered=await collectContext(ctx,order);
    return result(await executor.request("POST","/jobs",{owner:input.task_run_id,work_order:{...order,...(gathered?{context_pack:gathered}:{})}}));
   }
   if(!input.job_id)throw Error("SBCE_JOB_ID_REQUIRED");
   if(input.action==="cancel"){
    if(!input.task_run_id)throw Error("SBCE_TASK_RUN_REQUIRED");
    return result(await executor.request("POST","/jobs/"+input.job_id+"/cancel",{owner:requireTask(input.task_run_id)}));
   }
   if(input.action==="answer")return result({status:"unavailable",message:"Answer continuation is not implemented. No answer was saved; submit a revised job."});
   if(!input.task_run_id)throw Error("SBCE_TASK_RUN_REQUIRED");
   const owner=requireTask(input.task_run_id);
   const waitMs=(input.wait_s??0)*1000,until=Date.now()+waitMs;
   let job=await executor.request("POST","/jobs/"+input.job_id+"/status",{owner});
   while(Date.now()<until&&["queued","running","verifying","fixing"].includes(String(job.status))){
    await new Promise(r=>setTimeout(r,Math.min(1000,until-Date.now())));
    job=await executor.request("POST","/jobs/"+input.job_id+"/status",{owner});
   }
   return result(job);
  }catch(e){return failure(e);}
 });
 server.registerTool("review_pack",{
  description:"Review a SBCE job receipt (bounded output). Brain approval changes job metadata only; never applies patches or bypasses file preview/apply. Requires originating task ID to approve/reject.",
  inputSchema:{action:z.enum(["get","accept","revise","reject","pull"]),job_id:jobId,task_run_id:taskId.optional(),note:z.string().max(1000).optional(),max_chars:z.number().int().min(100).max(8000).optional()},
  annotations:reversibleMutation
 },async(input)=>{
  try{
   if(executor.mode==="off")return result({status:"disabled",mode:"off"});
   if(input.action==="get"){
    if(!input.task_run_id)throw Error("SBCE_TASK_RUN_REQUIRED");
    const job=await executor.request("POST","/jobs/"+input.job_id+"/status",{owner:requireTask(input.task_run_id)});
    return result({job_id:input.job_id,status:job.status,review:job.review??null});
   }
   if(input.action==="pull"){
    if(!input.task_run_id)throw Error("SBCE_TASK_RUN_REQUIRED");
    return result(await executor.request("POST","/jobs/"+input.job_id+"/pull",{owner:requireTask(input.task_run_id),which:"draft",start_char:0,max_chars:input.max_chars??4000}));
   }
   if(!input.task_run_id)throw Error("SBCE_TASK_RUN_REQUIRED");
   return result(await executor.request("POST","/jobs/"+input.job_id+"/review",{owner:requireTask(input.task_run_id),decision:input.action==="accept"?"accept":input.action==="reject"?"reject":"revise",note:input.note??""}));
  }catch(e){return failure(e);}
 });
 server.registerTool("executor_admin",{
  description:"Read-only SBCE worker health, budget and enabled model catalog. No API keys, prompts, or private outputs are returned.",
  inputSchema:{action:z.enum(["status","budget","catalog","eval_report"])},
  annotations:readOnly
 },async(input)=>{
  try{
   if(input.action==="status")return result(await executor.status());
   if(executor.mode==="off")return result({status:"disabled",mode:"off"});
   const data=await executor.request("GET","/admin");
   if(input.action==="budget")return result(data.budget);
   if(input.action==="catalog")return result({models:data.catalog});
   return result(data.evaluation??{benchmarkStatus:"not_benchmarked",reason:"No observed jobs."});
  }catch(e){return failure(e);}
 });
}

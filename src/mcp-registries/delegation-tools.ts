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
/** What the Brain asked for but the worker will NOT see (0.24.35). Absent when nothing was lost. */
export type ContextReport={refs_dropped?:string[];skipped?:{ref:string;reason:string}[];cut?:{ref:string;sent:string;reason:string}[];pack_omitted?:number;pack_truncated?:string[];verified_sources?:{ref:string;locator:string;sha256:string}[];pack_sha256?:string};
type GatheredPack={evidence:ContextEvidence[];sha256:string;untrusted:true};
export async function collectContext(ctx:ToolRegistryContext,order:ReturnType<typeof workOrderSchema.parse>):Promise<{pack:GatheredPack|null;report:ContextReport|null}>{
 if(!order.context_refs.length)return {pack:null,report:null};
 if(!order.project_root)return {pack:null,report:{skipped:order.context_refs.slice(0,12).map(ref=>({ref,reason:'project_root_required'}))}};
 const root=win32.resolve(order.project_root);
 const codeJob=order.kind==="code_change"||order.kind==="test_write";
 const budget=codeJob?CONTEXT_BUDGET.code:CONTEXT_BUDGET.text;
 const evidence:ContextEvidence[]=[];
 const skipped:{ref:string;reason:string}[]=[],cut:{ref:string;sent:string;reason:string}[]=[];
 const verified:{ref:string;locator:string;sha256:string}[]=[];
 for(const ref of order.context_refs.slice(0,12)){
  try{
   if(ref.startsWith("file:")){
    const parsed=parseFileRef(ref);if(!parsed){skipped.push({ref,reason:"invalid_ref"});continue;}
    const local=parsed.path.replaceAll("/","\\");
    if(!local||win32.isAbsolute(local)||local.includes("..")||local.includes(":")){skipped.push({ref,reason:"invalid_path"});continue;}
    const target=win32.resolve(root,local),rel=win32.relative(root,target);
    if(rel.startsWith("..")||win32.isAbsolute(rel)){skipped.push({ref,reason:"outside_project_root"});continue;}
    const before=ctx.runtime.files.stat(target);
    const data=ctx.runtime.files.readWithMeta(target,parsed.start,parsed.end,budget.perSnippet);
    const after=ctx.runtime.files.stat(target);
    if(!/^[a-f0-9]{64}$/i.test(String(after.hash))||before.hash!==after.hash){skipped.push({ref,reason:'file_changed_or_unverified'});continue;}
    if(data.redacted){skipped.push({ref,reason:"contains_secret"});continue;}
    if(!data.text.trim()){skipped.push({ref,reason:"empty_range"});continue;}
    // Line-numbered so the executor can write correct @@ hunk headers.
    // Keep only whole lines that fit, so no line is cut mid-way and the locator stays exact.
    const lines=data.text.split("\n");
    const kept:string[]=[];let size=0;
    for(const [i,line] of lines.entries()){
     const numberedLine=String(parsed.start+i).padStart(5," ")+"| "+line;
     if(size+numberedLine.length+1>budget.perSnippet)break;
     kept.push(numberedLine);size+=numberedLine.length+1;
    }
    if(!kept.length){skipped.push({ref,reason:"line_longer_than_snippet_budget"});continue;}
    const relPath=rel.replaceAll("\\","/"),end=parsed.start+kept.length-1;
    const askedEnd=Number(/(?:#L|:)\d{1,6}-L?(\d{1,6})$/.exec(ref)?.[1]??0);
    if(kept.length<lines.length)cut.push({ref,sent:relPath+":"+parsed.start+"-"+end,reason:"snippet_budget_"+budget.perSnippet+"_chars"});
    else if(askedEnd>parsed.end&&lines.length===parsed.end-parsed.start+1)cut.push({ref,sent:relPath+":"+parsed.start+"-"+end,reason:"max_300_lines_per_ref"});
    evidence.push({source:relPath,locator:relPath+":"+parsed.start+"-"+end,snippet:kept.join("\n"),label:codeJob?"public/code":"internal"});
    verified.push({ref,locator:relPath+":"+parsed.start+"-"+end,sha256:String(after.hash)});
   }else if(ref.startsWith("rag:")){
    if(!ctx.projectRag){skipped.push({ref,reason:"rag_unavailable"});continue;}
    const query=ref.slice(4).includes("?q=")?new URLSearchParams(ref.slice(4).split("?")[1]).get("q")??"":ref.slice(4);
    if(!query||query.length>300){skipped.push({ref,reason:"invalid_query"});continue;}
    const data=await ctx.projectRag.query(root,query,3,3500);
    const before=evidence.length;
    for(const hit of data.results??[]){
     if(!hit.citation?.locator||!hit.text)continue;
     evidence.push({source:String(hit.source),locator:String(hit.citation.locator),snippet:String(hit.text),label:"internal"});
    }
    if(evidence.length===before)skipped.push({ref,reason:"no_rag_hits"});
   }
  }catch{skipped.push({ref,reason:"read_failed"});/* Skip invalid/stale evidence; never invent it. */}
 }
 const pack=buildContextPack(evidence.slice(0,12),budget.total,budget.perSnippet); // schema allows ≤12 items
 const report:ContextReport={};
 if(verified.length)report.verified_sources=verified;
 if(pack.evidence.length)report.pack_sha256=pack.sha256;
 if(order.context_refs.length>12)report.refs_dropped=order.context_refs.slice(12,32);
 if(skipped.length)report.skipped=skipped;
 if(cut.length)report.cut=cut;
 const omitted=pack.omitted+Math.max(0,evidence.length-12);
 if(omitted)report.pack_omitted=omitted;
 if(pack.truncated.length)report.pack_truncated=pack.truncated;
 return {pack:pack.evidence.length?{evidence:pack.evidence,sha256:pack.sha256,untrusted:true as const}:null,report:Object.keys(report).length?report:null};
}
import { compactJob, SBCE_ACTIVE_STATES } from "../sbce-compact.js";
import { SbceArtifactHandoff } from "../sbce-artifact-handoff.js";

export function registerDelegationTools(ctx:ToolRegistryContext,executor:SbceProcess){
 const {server,runtime}=ctx;
 const handoff=new SbceArtifactHandoff(ctx,executor);
 const requireTask=(id:string)=>{
  if(!runtime.taskRuns)throw Error("SBCE_TASK_RUNTIME_UNAVAILABLE");
  runtime.store.requireExistingTaskRun(id);
  return id;
 };
 server.registerTool("delegate_task",{
  description:"Brain-to-worker delegation (SBCE). Prefer action \"run\" to submit and wait in one call, returning a compact receipt to save Brain round-trips. Default route for hands-on work: reading/summarizing, drafting, code, tests, docs. Brain writes the work order with machine-checkable acceptance, then reviews. Sandbox proposals need machine verification and Brain review. Never authorizes release, commit or workstation actions.",
  inputSchema:{action:z.enum(["submit","run","status","list","cancel","answer"]),task_run_id:taskId.optional(),job_id:jobId.optional(),work_order:z.unknown().optional(),wait_s:z.number().int().min(0).max(300).optional(),answer:z.string().max(2000).optional(),compact:z.boolean().optional()},
  annotations:reversibleMutation
 },async(input)=>{
  try{
   if(executor.mode==="off")return result({status:"disabled",mode:"off"});
   if(input.action==="list"){if(!input.task_run_id)throw Error("SBCE_TASK_RUN_REQUIRED");return result(await executor.request("POST","/jobs/list",{owner:requireTask(input.task_run_id)}));}
   if(input.action==="submit"||input.action==="run"){
    if(!input.task_run_id)throw Error("SBCE_TASK_RUN_REQUIRED");
    requireTask(input.task_run_id);
    const order=workOrderSchema.parse(input.work_order);
    const {pack:gathered,report}=await collectContext(ctx,order);
    const hostRefs=order.context_refs.filter(ref=>ref.startsWith('file:')||ref.startsWith('rag:'));
    const someEvidence=Boolean(gathered?.evidence.length||order.context_pack?.evidence.length||order.context_refs.some(ref=>!ref.startsWith('file:')&&!ref.startsWith('rag:')));
    if((hostRefs.length&&!gathered?.evidence.length)||(order.kind==='data_extract'&&!someEvidence))return result({status:'blocked',reason:order.kind==='data_extract'?'SBCE_DATA_EVIDENCE_REQUIRED':'SBCE_CONTEXT_UNAVAILABLE',spent_vnd:0,context_report:report??{skipped:hostRefs.map(ref=>({ref,reason:'not_resolved'}))},next:'Set project_root and explicit file:...#Lstart-end context_refs before delegating; never ask worker to guess local contents.'});
    // Tell the Brain what part of the requested context the worker will not see, so it can split or narrow the job.
    const contextLost=Boolean(report?.refs_dropped?.length||report?.skipped?.length||report?.cut?.length||report?.pack_omitted||report?.pack_truncated?.length);
    const contextReport=report?{context_report:{...report,note:contextLost?"Part of the requested context was NOT sent to the worker. Split the job or narrow context_refs if the missing part matters.":"Verified host evidence receipt; no context loss reported."}}:{};
    const job=await executor.request("POST","/jobs",{owner:input.task_run_id,work_order:{...order,...(gathered?{context_pack:gathered}:{})}});
    if(input.action==="submit")return result({...job,...contextReport});
    const owner=input.task_run_id;
    const waitMs=(input.wait_s??240)*1000,until=Date.now()+waitMs;
    let current=job;
    while(Date.now()<until&&SBCE_ACTIVE_STATES.includes(String(current?.status))){
     await new Promise(r=>setTimeout(r,Math.min(2000,until-Date.now())));
     if(Date.now()>=until)break;
     current=await executor.request("POST","/jobs/"+String(current?.id??"")+"/status",{owner});
    }
    return result({...(input.compact===false?current:compactJob(current)),...contextReport});
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
   while(Date.now()<until&&SBCE_ACTIVE_STATES.includes(String(job.status))){
    await new Promise(r=>setTimeout(r,Math.min(1000,until-Date.now())));
    job=await executor.request("POST","/jobs/"+input.job_id+"/status",{owner});
   }
   return result(input.compact===true?compactJob(job):job);
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
 server.registerTool("sbce_artifact_handoff",{
  description:"Trusted SBCE accepted draft -> guarded Windows file. Mode1 Brain reviews, then preview/apply. No worker OS privilege; new TXT/MD/CSV under task root only. Requires task authorization and returns verified host SHA-256.",
  inputSchema:{action:z.enum(["preview","apply"]),task_run_id:taskId,job_id:jobId.optional(),path:z.string().min(3).max(5000).optional(),action_id:z.string().max(256).optional(),confirmation_token:z.string().max(1000).optional()},
  annotations:reversibleMutation
 },async(input)=>{
  try{
   if(input.action==="preview"){
    if(!input.job_id||!input.path)throw Error("SBCE_HANDOFF_JOB_AND_PATH_REQUIRED");
    return result(await handoff.preview(input.task_run_id,input.job_id,input.path));
   }
   if(!input.action_id||!input.confirmation_token)throw Error("SBCE_HANDOFF_CONFIRMATION_REQUIRED");
   return result(await handoff.apply(input.task_run_id,input.action_id,input.confirmation_token));
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

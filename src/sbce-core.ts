/** SBCE contracts and deterministic gates. No MCP or LLM dependency. */
import { z } from "zod";
import { randomUUID } from "node:crypto";
export const SBCE_LIMITS=Object.freeze({perJobVnd:20000,perDayVnd:300000,maxAttempts:6,perTierAttempts:2,maxMinutes:30,maxReviewChars:7000});
const accept=z.object({type:z.enum(["command","grep_absent","schema","rubric","artifact_exists"]),run:z.string().max(500).optional(),expect:z.string().max(200).optional(),pattern:z.string().max(500).optional(),paths:z.array(z.string().max(500)).max(30).optional(),text:z.string().max(1500).optional()}).strict();
export const workOrderSchema=z.object({
 title:z.string().trim().min(3).max(200),
 kind:z.enum(["code_change","doc_write","doc_edit","data_extract","research","shell_task","test_write"]),
 goal:z.string().trim().min(10).max(10000),
 deliverables:z.array(z.string().trim().min(1).max(500)).min(1).max(20),
 acceptance:z.array(accept).min(1).max(30),
 context_refs:z.array(z.string().max(500)).max(40).default([]),
 context_pack:z.object({evidence:z.array(z.object({source:z.string().min(1).max(300),locator:z.string().min(1).max(500),snippet:z.string().max(8000),label:z.enum(["public/code","internal","personal/sensitive"]).optional()})).max(12),sha256:z.string().regex(/^[a-f0-9]{64}$/),untrusted:z.literal(true)}).optional(),
 constraints:z.array(z.string().max(1000)).max(30).default([]),
 locked_paths:z.array(z.string().max(500)).max(100).default([]),
 risk:z.enum(["low","medium","high"]).default("medium"),
 budget:z.object({vnd:z.number().int().positive().max(SBCE_LIMITS.perJobVnd).default(SBCE_LIMITS.perJobVnd),minutes:z.number().int().positive().max(SBCE_LIMITS.maxMinutes).default(SBCE_LIMITS.maxMinutes),max_attempts:z.number().int().positive().max(SBCE_LIMITS.maxAttempts).default(SBCE_LIMITS.maxAttempts)}).default({vnd:SBCE_LIMITS.perJobVnd,minutes:SBCE_LIMITS.maxMinutes,max_attempts:SBCE_LIMITS.maxAttempts}),
 escalation:z.object({allow_t3:z.boolean().default(true),ask_brain_on:z.array(z.enum(["ambiguity","acceptance_conflict","budget_exhausted","high_risk"])).max(10).default([])}).default({allow_t3:true,ask_brain_on:[]}),
 apply_mode:z.enum(["sandbox_only","apply_after_accept"]).default("sandbox_only"),
 project_root:z.string().min(3).max(500).optional()
}).strict();
export type SbceWorkOrder=z.infer<typeof workOrderSchema>;
export type SbceMode="off"|"shadow"|"on";
export type SbceState="queued"|"running"|"verifying"|"fixing"|"needs_brain"|"ready_for_review"|"accepted"|"applied"|"failed"|"cancelled";
export type SbceModel={id:string;model:string;provider:"hhtech";protocol:"openai"|"anthropic";family:string;tier:"T1"|"T2"|"T3";roles:string[];enabled:boolean;vndPerM:number;minVndPerCall?:number;hiddenInputTokens?:number;caps?:string[];dataLabels?:string[]};
export function validateWorkOrder(input:unknown,mode:SbceMode):SbceWorkOrder{
 const order=workOrderSchema.parse(input);
 if(mode==="off")throw Error("SBCE_DISABLED");
 if(mode==="shadow"&&order.apply_mode!=="sandbox_only")throw Error("SBCE_SHADOW_SANDBOX_ONLY");
 if(order.risk==="high"&&order.apply_mode!=="sandbox_only")throw Error("SBCE_HIGH_RISK_REQUIRES_OWNER");
 return order;
}
export function newJobId(){return "job-"+randomUUID();}
export function eligibleModels(models:SbceModel[],role:string,tier:"T1"|"T2"|"T3",label:string):SbceModel[]{
 return models.filter(m=>m.enabled&&m.provider==="hhtech"&&m.tier===tier&&m.roles.includes(role)&&Number.isFinite(m.vndPerM)&&m.vndPerM>=0&&(m.dataLabels??["public/code"]).includes(label))
 .sort((a,b)=>a.vndPerM-b.vndPerM||a.id.localeCompare(b.id));
}
/** Expected charge of one call: token price (incl. gateway-added hidden input) or the per-request floor, whichever is higher. */
export function expectedCallVnd(model:SbceModel,estTokens:number):number{
 const tokens=(Number.isFinite(estTokens)&&estTokens>0?estTokens:0)+(model.hiddenInputTokens??0);
 return Math.max(tokens*model.vndPerM/1_000_000,model.minVndPerCall??0);
}
/**
 * Cross-family verifier. With estTokens, picks the cheapest expected call among T1/T2 judges
 * (tie: lower tier, then id), because per-request floors can make a T2 judge cheaper than a T1 one.
 */
export function chooseVerifier(models:SbceModel[],producer:SbceModel,label:string,estTokens?:number):SbceModel|null{
 if(estTokens!==undefined){
  const pool=[...eligibleModels(models,"judge","T1",label),...eligibleModels(models,"judge","T2",label)].filter(m=>m.family!==producer.family);
  pool.sort((a,b)=>expectedCallVnd(a,estTokens)-expectedCallVnd(b,estTokens)||a.tier.localeCompare(b.tier)||a.id.localeCompare(b.id));
  return pool[0]??null;
 }
 return eligibleModels(models,"judge","T1",label).find(m=>m.family!==producer.family)??eligibleModels(models,"judge","T2",label).find(m=>m.family!==producer.family)??null;
}
export function nextTier(tier:"T1"|"T2"|"T3"):"T2"|"T3"|null{return tier==="T1"?"T2":tier==="T2"?"T3":null;}
export function redactSecrets(value:string):string{
 return value.replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{16,}/gi,"$1[HIDDEN]")
 .replace(/\b(sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16})\b/g,"[HIDDEN]");
}
const redactionMarker=["[RED","ACTED]"].join("");
export function refuseRedactedWrite(original:string,next:string){
 if(!original.includes(redactionMarker)&&next.includes(redactionMarker))throw Error("REDACTION_MARKER_WRITE_BLOCKED");
}
export type SbceAttemptRecord={attempt:number;model:string;tier:string;checks:{name:string;ok:boolean}[];error?:string};
export function reviewReceipt(input:{jobId:string;state:SbceState;summary:string;checks:{name:string;ok:boolean}[];risks?:string[];costVnd:number;tokensIn:number;tokensOut:number;artifacts?:Record<string,string>;needsBrain?:string;attempts?:SbceAttemptRecord[]}):Record<string,unknown>{
 const pack:Record<string,unknown>={job_id:input.jobId,status:input.state,summary:redactSecrets(input.summary).slice(0,2200),checks:input.checks.slice(0,30),risks:(input.risks??[]).slice(0,12),cost:{vnd:input.costVnd,tokens_in:input.tokensIn,tokens_out:input.tokensOut},artifacts:input.artifacts??{},diagnosis:input.needsBrain?.slice(0,1000)};
 if(JSON.stringify(pack).length>SBCE_LIMITS.maxReviewChars)throw Error("SBCE_REVIEW_TOO_LARGE");
 // Per-attempt gate history is diagnostic: keep the newest entries that fit, never fail the receipt over it.
 const attempts=(input.attempts??[]).slice(-SBCE_LIMITS.maxAttempts).map(a=>({attempt:a.attempt,model:String(a.model).slice(0,60),tier:String(a.tier).slice(0,4),checks:a.checks.slice(0,12).map(c=>({name:String(c.name).slice(0,60),ok:c.ok===true})),...(a.error?{error:redactSecrets(a.error).slice(0,160)}:{})}));
 while(attempts.length){pack.attempts=attempts;if(JSON.stringify(pack).length<=SBCE_LIMITS.maxReviewChars)break;attempts.shift();delete pack.attempts;}
 return pack;
}

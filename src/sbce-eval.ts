/** Honest Golden Set scoring: absent real evidence never counts as an achieved KPI. */
import { z } from "zod";
export const evaluationRecordSchema=z.object({
 id:z.string().min(1).max(100),
 source:z.enum(["trusted_runtime","imported_external"]),
 status:z.enum(["not_run","needs_brain","ready_for_review","accepted","failed","cancelled"]),
 l0:z.object({pass:z.boolean(),isolated:z.boolean().optional(),machineReceipt:z.string().max(500).optional()}),
 l1:z.object({pass:z.boolean(),crossFamily:z.boolean()}),
 brainApproved:z.boolean(),
 estimatedCostVnd:z.number().int().nonnegative().max(1_000_000),
 inputTokens:z.number().int().nonnegative(),outputTokens:z.number().int().nonnegative(),
 latencyMs:z.number().int().nonnegative()
}).strict();
export type EvalRecord=z.infer<typeof evaluationRecordSchema>;
export type GoldenTask={id:string;kind:string};
export function evaluateGoldenSet(tasks:GoldenTask[],records:EvalRecord[]){
 const byId=new Map(records.map(x=>[x.id,x]));
 const rows=tasks.map(task=>{
  const r=byId.get(task.id);if(!r)return{id:task.id,kind:task.kind,result:"not_run" as const};
  const code=["code_change","test_write"].includes(task.kind);
  const checked=r.source==="trusted_runtime"&&r.status==="accepted"&&r.brainApproved
   &&r.l0.pass&&r.l1.pass&&r.l1.crossFamily&&(!code||(r.l0.isolated&&r.l0.machineReceipt));
  return{id:task.id,kind:task.kind,result:checked?"verified_pass" as const:"not_verified" as const,
   costVnd:r.estimatedCostVnd,latencyMs:r.latencyMs};
 });
 const pass=rows.filter(x=>x.result==="verified_pass").length,attempted=rows.filter(x=>x.result!=="not_run").length;
 return{
  schemaVersion:1,
  status:attempted===tasks.length&&pass===tasks.length?"fully_verified":"incomplete_evidence",
  sampleCount:tasks.length,
  attempted,
  verifiedPass:pass,
  missing:tasks.length-attempted,
  unverified:attempted-pass,
  verifiedPassRate:attempted?pass/attempted:null,
  fullSetPassRate:tasks.length?pass/tasks.length:null,
  cannotClaimSavingsWithoutBaseline:true,
  rows
 };
}

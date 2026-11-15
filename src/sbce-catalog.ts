/**
 * HH Tech billing-safe model catalog.
 * Public model listings are useful for suggestions, not sufficient to enable spend.
 * Only the user's account usage or verified billing statement can approve pricing.
 */
import { readFileSync } from "node:fs";
import { z } from "zod";
import type { SbceModel } from "./sbce-core.js";
const roles=["coder","writer","researcher","judge","fixer","planner","summarizer"] as const;
const labels=["public/code","internal","personal/sensitive"] as const;
export const priceAuditSchema=z.object({
  confirmedAt:z.string().datetime({offset:true}),
  source:z.enum(["account_usage","billing_statement"]),
  maxVndPerM:z.number().finite().positive().max(100_000),
  sampleCount:z.number().int().min(1).max(100000),
  // Per-request floor observed on the account (gateway minimum charge). Omitted means none observed.
  minVndPerCall:z.number().finite().min(0).max(1000).optional(),
  approvedByOwner:z.literal(true)
}).strict();
export const catalogModelSchema=z.object({
 id:z.string().regex(/^[a-zA-Z0-9_.-]{2,100}$/),
 model:z.string().regex(/^[a-zA-Z0-9_.\/-]{2,150}$/),
 provider:z.literal("hhtech"),
 protocol:z.enum(["openai","anthropic"]),
 family:z.string().regex(/^[a-zA-Z0-9_-]{2,80}$/),
 tier:z.enum(["T1","T2","T3"]),
 roles:z.array(z.enum(roles)).nonempty().max(10),
 enabled:z.boolean(),
 vndPerM:z.number().finite().positive().max(100_000),
 minVndPerCall:z.number().finite().min(0).max(1000).optional(),
 // Input tokens the gateway adds per call beyond what we send (HHTECH Anthropic route: ~13k).
 hiddenInputTokens:z.number().int().min(0).max(200_000).optional(),
 dataLabels:z.array(z.enum(labels)).nonempty().max(3),
 priceAudit:priceAuditSchema.optional(),
}).passthrough();
export const catalogSchema=z.object({schemaVersion:z.literal(1),provider:z.literal("hhtech"),models:z.array(catalogModelSchema).max(60)}).passthrough();
export type ValidatedCatalog={models:SbceModel[],enabledCount:number,rejected:string[],configured:boolean};
function calibrationCurrent(iso:string,now:Date):boolean {
 const v=Date.parse(iso); const diff=now.getTime()-v;
 return Number.isFinite(v)&&diff>=0&&diff<=7*24*60*60*1000;
}
/** Disabled entries stay listed. Enabled entries require current owner-approved billing proof. */
export function inspectCatalog(raw:unknown,now=new Date()):ValidatedCatalog{
 const catalog=catalogSchema.safeParse(raw);
 if(!catalog.success)return {models:[],enabledCount:0,rejected:["SBCE_CATALOG_SCHEMA_INVALID"],configured:true};
 const selected:SbceModel[]=[],rejected:string[]=[];
 const ids=new Set<string>();
 for(const model of catalog.data.models){
  if(ids.has(model.id)){rejected.push("SBCE_MODEL_DUPLICATE:"+model.id);continue;}
  ids.add(model.id);
  if(!model.enabled){selected.push({...model,enabled:false});continue;}
  const audit=model.priceAudit;
  if(!audit||!calibrationCurrent(audit.confirmedAt,now)||audit.maxVndPerM<model.vndPerM){
    rejected.push("SBCE_MODEL_UNCALIBRATED:"+model.id);
    selected.push({...model,enabled:false});
    continue;
  }
  // Billing floor: the stricter of the model entry and the owner-approved audit.
  const floor=Math.max(model.minVndPerCall??0,audit.minVndPerCall??0);
  selected.push({...model,enabled:true, vndPerM:audit.maxVndPerM, minVndPerCall:floor});
 }
 return {models:selected,enabledCount:selected.filter(m=>m.enabled).length,rejected,configured:true};
}
export function loadCatalogFromFile(path:string,now=new Date()):ValidatedCatalog{
 try{return inspectCatalog(JSON.parse(readFileSync(path,"utf8")),now);}
 catch{return {models:[],enabledCount:0,rejected:["SBCE_CATALOG_MISSING_OR_INVALID"],configured:false};}
}

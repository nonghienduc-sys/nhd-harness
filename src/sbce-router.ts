/** Budget-aware cost-quality routing with bounded exploration and verified outcomes only. */
import { eligibleModels, expectedCallVnd, type SbceModel } from "./sbce-core.js";
export type RouterStats={modelId:string;taskClass:string;accepted:number;rejected:number};
export type RouterDecision={model:SbceModel;exploratory:boolean;reason:string;score:number};
function betaDraw(a:number,b:number,rng:()=>number):number{
 // Integer-shape Beta sampling is sufficient: posterior Beta(1+s, 1+f).
 // Use product-of-uniforms Gamma sample (Erlang), bounded to at most 201 draws.
 function gamma(k:number):number{let v=0;for(let i=0;i<Math.min(201,k);i++)v-=Math.log(Math.max(1e-10,rng()));return v;}
 const x=gamma(Math.min(201,Math.max(1,Math.floor(a)))),y=gamma(Math.min(201,Math.max(1,Math.floor(b))));
 return x/(x+y);
}
export function routeSbceModel(input:{
 models:SbceModel[];role:string;tier:"T1"|"T2"|"T3";label:string;
 taskClass:string;risk:"low"|"medium"|"high";stats:RouterStats[];
 rng?:()=>number;
 /** Estimated tokens of the call. When given, cost includes per-request floors (minVndPerCall). */
 estTokens?:number;
}):RouterDecision|null{
 const est=input.estTokens;
 const effectivePerM=(m:SbceModel)=>est!==undefined&&est>0?expectedCallVnd(m,est)*1_000_000/est:m.vndPerM;
 const candidates=eligibleModels(input.models,input.role,input.tier,input.label)
  .sort((a,b)=>effectivePerM(a)-effectivePerM(b)||a.vndPerM-b.vndPerM||a.id.localeCompare(b.id));
 if(!candidates.length)return null;
 const random=input.rng??Math.random;
 const total=input.stats.filter(s=>s.taskClass===input.taskClass).reduce((n,s)=>n+s.accepted+s.rejected,0);
 const baseline=candidates[0];
 if(total<20||input.risk==="high")return{model:baseline,exploratory:false,reason:total<20?"SBCE_COLD_START_LOWEST_COST":"SBCE_HIGH_RISK_COST_BASELINE",score:1};
 const samples=candidates.map(model=>{
  const stat=input.stats.find(s=>s.modelId===model.id&&s.taskClass===input.taskClass);
  const success=Math.max(0,stat?.accepted??0),failure=Math.max(0,stat?.rejected??0);
  const utility=betaDraw(1+success,1+failure,random);
  const qualityPerPrice=utility/(1+effectivePerM(model)/1000);
  return {model,score:qualityPerPrice,hasData:success+failure>0};
 }).sort((a,b)=>b.score-a.score||effectivePerM(a.model)-effectivePerM(b.model));
 const untested=samples.filter(m=>!m.hasData);
 const mayExplore=input.risk==="low"&&untested.length>0&&random()<0.1;
 const chosen=mayExplore?untested[0]:samples[0];
 return{model:chosen.model,exploratory:mayExplore,score:chosen.score,reason:mayExplore?"SBCE_EXPLORATION_MAX_TEN_PERCENT":"SBCE_VERIFIED_THOMPSON_COST_QUALITY"};
}

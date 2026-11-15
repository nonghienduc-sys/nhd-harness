/**
 * Pre-authorize worst-case calls before any paid HTTP request.
 * The user-approved 20k/job, 300k/day are anti-runaway limits, not spending targets.
 */
import type { SbceModel } from "./sbce-core.js";
export function preflightMaxCostVnd(model:SbceModel,system:string,prompt:string,maxOutputTokens:number):number{
 if(!Number.isFinite(model.vndPerM)||model.vndPerM<=0||model.vndPerM>100000)throw Error("SBCE_BILLING_PRICE_UNVERIFIED");
 if(!Number.isInteger(maxOutputTokens)||maxOutputTokens<1||maxOutputTokens>8192)throw Error("SBCE_OUTPUT_LIMIT_INVALID");
 // Conservative UTF-8 upper estimate + fixed message overhead; 2x a billing-verified
 // worst-case rate covers ordinary token usage discrepancies but is not a billing oracle.
 // Plus tokens the gateway adds on its side (catalog hiddenInputTokens): billed, never sent by us.
 const estimatedInput=Buffer.byteLength(system+"\n"+prompt,"utf8")+1024+hiddenTokens(model.hiddenInputTokens);
 const maxTokens=estimatedInput+maxOutputTokens;
 const floor=callFloorVnd(model.minVndPerCall);
 return Math.max(1,Math.ceil(maxTokens*model.vndPerM*2/1_000_000),Math.ceil(floor));
}
function hiddenTokens(value:number|undefined):number{
 if(value===undefined)return 0;
 if(!Number.isSafeInteger(value)||value<0||value>200_000)throw Error("SBCE_HIDDEN_INPUT_TOKENS_INVALID");
 return value;
}
function callFloorVnd(value:number|undefined):number{
 if(value===undefined)return 0;
 if(!Number.isFinite(value)||value<0||value>1000)throw Error("SBCE_BILLING_FLOOR_INVALID");
 return value;
}
/**
 * Gateways may under-report input (e.g. Anthropic route hiding cached prompt tokens).
 * Bill at least a conservative estimate of what was actually sent: UTF-8 bytes / 4.
 */
export function billableInputTokens(reported:number,system:string,prompt:string):number{
 if(!Number.isSafeInteger(reported)||reported<0)throw Error("SBCE_TOKEN_USAGE_INVALID");
 return Math.max(reported,Math.ceil(Buffer.byteLength(system+"\n"+prompt,"utf8")/4));
}
export function actualChargeVnd(input:number,output:number,maxVndPerM:number,minVndPerCall?:number):number{
 if(!Number.isSafeInteger(input)||input<0||!Number.isSafeInteger(output)||output<0)throw Error("SBCE_TOKEN_USAGE_INVALID");
 if(!Number.isFinite(maxVndPerM)||maxVndPerM<=0)throw Error("SBCE_BILLING_PRICE_UNVERIFIED");
 return Math.ceil(Math.max((input+output)*maxVndPerM/1_000_000,callFloorVnd(minVndPerCall)));
}

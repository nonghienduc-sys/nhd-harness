/**
 * HHTECH-only SBCE adapter. Credentials are injected by a local vault callback.
 * The adapter never fetches a token from MCP arguments or task context.
 * No provider request happens when key is absent.
 */
import { redactSecrets, type SbceModel } from "./sbce-core.js";
import { SbceModelCircuits } from "./sbce-model-circuits.js";
export type SbceUsage={input:number;output:number;cached:number};
export type SbceResponse={text:string;usage:SbceUsage;model:string;protocol:"openai"|"anthropic";truncated?:boolean};
export type SbceKeyLoader=()=>Promise<string|null>|string|null;
export type SbceFetch=typeof fetch;
// Output-token ceiling for a code edit. Gemini spends part of the ceiling on hidden reasoning
// (bench 2026-11-13: 9/12 replies cut at 4096, all complete at 8192).
export function codeOutputCeiling(model:Pick<SbceModel,"family">):number{return model.family==="gemini"?8192:4096;}
export function containsSecret(text:string):boolean{
 return /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i.test(text)
 || /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/i.test(text)
 || /\b(?:api[_-]?key|password|passwd|access[_-]?token|refresh[_-]?token|client[_-]?secret)\s*[:=]\s*["']?[^"'\s,;]{8,}/i.test(text)
 || /\bsk-[A-Za-z0-9_-]{16,}\b/.test(text)
 || /\bgh[pousr]_[A-Za-z0-9]{20,}\b/.test(text)
 || /\bAKIA[0-9A-Z]{16}\b/.test(text);
}
export class HhtechProvider {
 constructor(private readonly getKey:SbceKeyLoader,private readonly http:SbceFetch=fetch,private readonly circuits=new SbceModelCircuits()){}
 isModelAvailable(id:string):boolean{return !this.circuits.isOpen(id);}
 async generate(args:{model:SbceModel;system:string;prompt:string;maxTokens:number;timeoutMs?:number}):Promise<SbceResponse>{
  const {model,system,prompt}=args;
  if(model.provider!=="hhtech"||!model.enabled)throw Error("SBCE_PROVIDER_NOT_APPROVED");
  if(containsSecret(system)||containsSecret(prompt))throw Error("SBCE_SECRET_EGRESS_BLOCKED");
  if(system.length+prompt.length>120000)throw Error("SBCE_CONTEXT_TOO_LARGE");
  this.circuits.beforeRequest(model.id);
  const key=await this.getKey();
  if(!key||key.length<12)throw Error("SBCE_VAULT_NOT_CONFIGURED");
  const outputTokens=Math.max(1,Math.min(Math.trunc(args.maxTokens),8192));
  const path=model.protocol==="anthropic"?"/v1/messages":"/v1/chat/completions";
  const body=model.protocol==="anthropic"
   ? {model:model.model,max_tokens:outputTokens,system,messages:[{role:"user",content:prompt}]}
   : {model:model.model,max_tokens:outputTokens,temperature:0,messages:[{role:"system",content:system},{role:"user",content:prompt}]};
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),Math.max(2000,Math.min(args.timeoutMs??90000,120000)));
  try{
   const response=await this.http("https://hhtechapi.com"+path,{
    method:"POST",signal:controller.signal,
    headers:{"content-type":"application/json",authorization:"Bearer "+key,...(model.protocol==="anthropic"?{"anthropic-version":"2023-06-01"}:{})},
    body:JSON.stringify(body)
   });
   if(!response.ok){this.circuits.failure(model.id,response.status);throw Error("SBCE_PROVIDER_HTTP_"+response.status);}
   const data=await response.json() as any;
   const text=model.protocol==="anthropic"
    ? (Array.isArray(data.content)?data.content.filter((x:any)=>x?.type==="text").map((x:any)=>x.text??"").join("\n"):"")
    : (typeof data.choices?.[0]?.message?.content==="string"?data.choices[0].message.content:"");
   // Reply stopped at the output-token ceiling (thinking models spend part of it on hidden reasoning).
   const truncated=model.protocol==="anthropic"?data.stop_reason==="max_tokens":data.choices?.[0]?.finish_reason==="length";
   if(!text&&truncated)throw Error("SBCE_PROVIDER_OUTPUT_TRUNCATED");
   if(!text||text.length>200000)throw Error("SBCE_PROVIDER_INVALID_RESPONSE");
   const usage=data.usage??{};
   // Anthropic reports cached prompt tokens separately from input_tokens; OpenAI's prompt_tokens already includes them.
   const cacheCreate=model.protocol==="anthropic"?Number(usage.cache_creation_input_tokens??0):0;
   const cacheRead=model.protocol==="anthropic"?Number(usage.cache_read_input_tokens??0):0;
   const inTokens=Number(usage.input_tokens??usage.prompt_tokens)+(Number.isFinite(cacheCreate)&&cacheCreate>0?cacheCreate:0)+(Number.isFinite(cacheRead)&&cacheRead>0?cacheRead:0);
   const outTokens=Number(usage.output_tokens??usage.completion_tokens);
   const cached=Number(usage.cache_read_input_tokens??usage.prompt_tokens_details?.cached_tokens??0);
   if(!Number.isFinite(inTokens)||!Number.isFinite(outTokens)||inTokens<0||outTokens<0)throw Error("SBCE_USAGE_UNAVAILABLE");
   this.circuits.success(model.id);
   return {text,model:model.model,protocol:model.protocol,truncated,usage:{input:inTokens,output:outTokens,cached:Number.isFinite(cached)?cached:0}};
  }catch(e){
   if(e instanceof Error&&e.name==="AbortError")this.circuits.failure(model.id,"timeout");
   const msg=e instanceof Error?e.message:String(e);
   throw Error(redactSecrets(msg).slice(0,180));
  }finally{clearTimeout(timer);}
 }
 /** P1 calibration: fixed constant prompt, ≤16 output tokens, works on a catalog entry even when disabled. */
 async probe(model:SbceModel):Promise<SbceResponse&{latencyMs:number}>{
  if(model.provider!=="hhtech")throw Error("SBCE_PROVIDER_NOT_APPROVED");
  const started=Date.now();
  const out=await this.generate({model:{...model,enabled:true},system:"You are a connectivity probe. Reply with exactly: OK",prompt:"Reply OK.",maxTokens:16,timeoutMs:25000});
  return {...out,text:out.text.slice(0,40),latencyMs:Date.now()-started};
 }
 /** Model IDs visible to this key (OpenAI-compatible /v1/models). Returns IDs only. */
 async listModels():Promise<string[]>{
  const key=await this.getKey();
  if(!key||key.length<12)throw Error("SBCE_VAULT_NOT_CONFIGURED");
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),15000);
  try{
   const response=await this.http("https://hhtechapi.com/v1/models",{method:"GET",signal:controller.signal,headers:{authorization:"Bearer "+key}});
   if(!response.ok)throw Error("SBCE_PROVIDER_HTTP_"+response.status);
   const data=await response.json() as any;
   const list=Array.isArray(data?.data)?data.data:[];
   return list.map((m:any)=>String(m?.id??"")).filter((id:string)=>/^[a-zA-Z0-9_.:\/-]{1,150}$/.test(id)).slice(0,1000).sort();
  }catch(e){
   const msg=e instanceof Error?(e.name==="AbortError"?"SBCE_PROVIDER_TIMEOUT":e.message):String(e);
   throw Error(redactSecrets(msg).slice(0,180));
  }finally{clearTimeout(timer);}
 }
}

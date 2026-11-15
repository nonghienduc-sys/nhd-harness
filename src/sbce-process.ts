/** Non-critical child process manager. SBCE failures must never break /mcp. */
import { fork, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import type { SbceMode } from "./sbce-core.js";
/**
 * Mode precedence: explicit NHD_SBCE_MODE env, then owner-written `<dataDir>/sbce-mode.json` ({"mode":"shadow"}).
 * Anything missing, unreadable or invalid resolves to "off" (fail closed). Read once at backend start.
 */
export function resolveSbceMode(envValue:string|undefined,dataDir:string):{mode:SbceMode;source:"env"|"file"|"default"}{
 const valid=(v:unknown):v is SbceMode=>v==="off"||v==="shadow"||v==="on";
 const env=String(envValue??"").trim();
 if(env)return {mode:valid(env)?env:"off",source:"env"};
 try{
  const raw=JSON.parse(readFileSync(resolve(dataDir,"sbce-mode.json"),"utf8").replace(/^﻿/,""));
  if(raw&&typeof raw==="object"&&valid(raw.mode))return {mode:raw.mode,source:"file"};
 }catch{}
 return {mode:"off",source:"default"};
}
export class SbceProcess {
 private child:ChildProcess|null=null;
 private secret=randomBytes(32).toString("hex");
 private stopped=false;
 private restartTimer:NodeJS.Timeout|null=null;
 private restartTimes:number[]=[];
 private lastExit:{code:number|null;at:string}|null=null;
 readonly mode:SbceMode;
 readonly port=39300;
 /** Auto-restart policy: at most maxRestarts within windowMs, exponential backoff from baseDelayMs (cap 60 s). */
 private readonly policy:{workerPath:string;maxRestarts:number;windowMs:number;baseDelayMs:number};
 constructor(private readonly dataDir:string,modeInput?:string,options:{workerPath?:string;maxRestarts?:number;windowMs?:number;baseDelayMs?:number}={}){
  this.mode=(modeInput==="shadow"||modeInput==="on")?modeInput:"off";
  this.policy={workerPath:options.workerPath??fileURLToPath(new URL("./sbce-worker.js",import.meta.url)),maxRestarts:options.maxRestarts??5,windowMs:options.windowMs??600_000,baseDelayMs:options.baseDelayMs??1000};
 }
 get restartCount(){return this.restartTimes.length;}
 private scheduleRestart(code:number|null){
  this.lastExit={code,at:new Date().toISOString()};
  if(this.stopped||this.restartTimer)return;
  const now=Date.now();
  this.restartTimes=this.restartTimes.filter(t=>now-t<this.policy.windowMs);
  if(this.restartTimes.length>=this.policy.maxRestarts)return; // give up; status stays degraded until backend restart
  const delay=Math.min(60_000,this.policy.baseDelayMs*2**this.restartTimes.length);
  this.restartTimes.push(now);
  this.restartTimer=setTimeout(()=>{this.restartTimer=null;if(!this.stopped)this.start();},delay);
  this.restartTimer.unref?.();
 }
 start(){
  if(this.mode==="off"||this.child)return;
  this.stopped=false;
  const worker=this.policy.workerPath;
  const p=fork(worker,[],{
   env:{...Object.fromEntries(["PATH","Path","SystemRoot","SystemDrive","TEMP","TMP","APPDATA","LOCALAPPDATA","USERPROFILE"].filter(k=>process.env[k]).map(k=>[k,process.env[k]])),NHD_SBCE_TOKEN:this.secret,NHD_SBCE_MODE:this.mode,NHD_SBCE_DATA_DIR:resolve(this.dataDir),NHD_SBCE_PORT:String(this.port)},
   stdio:["ignore","ignore","ignore","ipc"],
  });
  this.child=p;
  // Unexpected loss (crash, kill) restarts the worker; the worker itself parks interrupted jobs as needs_brain.
  p.once("exit",(code)=>{if(this.child===p){this.child=null;this.scheduleRestart(code);}});
  p.once("error",()=>{if(this.child===p){this.child=null;this.scheduleRestart(null);}});
 }
 async request(method:"GET"|"POST",path:string,body?:unknown,timeoutMs=27000):Promise<any>{
  if(this.mode==="off")return {status:"disabled",mode:"off"};
  if(!this.child)throw Error("SBCE_WORKER_OFFLINE");
  if(!/^\/(?:health|admin(?:\/(?:probe|models|bench\/(?:start|status|list)|jobs(?:\?limit=\d{1,3}|\/job-[a-f0-9-]{8,64}(?:\/review)?)?))?|session-key|jobs(?:\/list|\/[a-zA-Z0-9-]+(?:\/(?:status|cancel|review|pull))?)?)$/.test(path))throw Error("SBCE_INVALID_ROUTE");
  const response=await fetch("http://127.0.0.1:"+this.port+path,{
   method,headers:{"x-nhd-executor-auth":this.secret,"content-type":"application/json"},
   body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(Math.min(Math.max(timeoutMs,1000),27000))
  });
  const result=await response.json().catch(()=>({error:"SBCE_BAD_RESPONSE"}));
  if(!response.ok)throw Error(String((result as any).error??"SBCE_WORKER_ERROR").slice(0,300));
  return result;
 }
 async status(){
  if(this.mode==="off")return {status:"disabled",mode:"off",childPid:null};
  const restarts={restartCount:this.restartTimes.length,lastExit:this.lastExit};
  try{return {status:"online",childPid:this.child?.pid??null,...restarts,...await this.request("GET","/health",undefined,2000)};}
  catch(e){return {status:"degraded",mode:this.mode,childPid:this.child?.pid??null,...restarts,error:e instanceof Error?e.message:String(e)};}
 }
 stop(){
  this.stopped=true;
  if(this.restartTimer){clearTimeout(this.restartTimer);this.restartTimer=null;}
  const p=this.child;this.child=null;
  if(p){try{p.kill("SIGTERM");}catch{}}
 }
}

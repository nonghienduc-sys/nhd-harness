/** Privacy-preserving ChatGPT UI speed telemetry for later local-model comparisons. */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

export const SPEED_COLUMNS = [
  "sampleId","measuredAtUtc","receivedAtUtc","provider","modelLabel","workloadLabel",
  "timingOrigin","completionSignal","quality","visibilityState","visibleChars",
  "wordCount","estimatedOutputTokens","timeToFirstVisibleMs","observedDecodeMs",
  "totalVisibleElapsedMs","sampleCount","estimatedTokensPerSecond","visibleCharsPerSecond",
  "estimatorVersion","detectorVersion"
] as const;

export type ResponseSpeedSample = {
  sampleId:string;measuredAtUtc:string;receivedAtUtc:string;provider:string;
  modelLabel:string;workloadLabel:string;timingOrigin:string;completionSignal:string;
  quality:string;visibilityState:string;visibleChars:number;wordCount:number;
  estimatedOutputTokens:number;timeToFirstVisibleMs:number|null;
  observedDecodeMs:number;totalVisibleElapsedMs:number|null;sampleCount:number;
  estimatedTokensPerSecond:number|null;visibleCharsPerSecond:number|null;
  estimatorVersion:string;detectorVersion:string;
};

const clean=(v:unknown,max:number)=>String(v??"").replace(/[\r\n\x00-\x1f]/g," ").trim().slice(0,max);
function num(v:unknown,lo:number,hi:number){
  const n=Number(v);
  if(v===null||v===undefined||!Number.isFinite(n)||n<lo||n>hi)throw new Error("Invalid numeric speed metric.");
  return n;
}
const optNum=(v:unknown,lo:number,hi:number)=>v==null?null:num(v,lo,hi);
const round=(n:number)=>Math.round(n*100)/100;
const escapeCsv=(v:unknown)=>{
  const s=String(v==null?"":v);
  return /[",\r\n]/.test(s)?'"'+s.replace(/"/g,'""')+'"':s;
};
const percentile=(values:number[],pct:number):number|null=>{
  if(!values.length)return null;
  const v=[...values].sort((a,b)=>a-b);
  return round(v[Math.min(v.length-1,Math.max(0,Math.ceil(v.length*pct)-1))]);
};

export class ResponseSpeedStore {
  readonly directory:string;readonly csvPath:string;readonly jsonlPath:string;
  private samples:ResponseSpeedSample[]=[];
  private ids=new Set<string>();
  constructor(dir:string){
    this.directory=resolve(dir);mkdirSync(this.directory,{recursive:true});
    this.csvPath=resolve(this.directory,"chatgpt-plus-ui-speed.csv");
    this.jsonlPath=resolve(this.directory,"chatgpt-plus-ui-speed.jsonl");
    if(existsSync(this.jsonlPath)){
      for(const line of readFileSync(this.jsonlPath,"utf8").split(/\r?\n/)){
        if(!line.trim())continue;
        try{
          const row=JSON.parse(line) as ResponseSpeedSample;
          if(!row.sampleId||this.ids.has(row.sampleId))continue;
          this.samples.push(row);this.ids.add(row.sampleId);
        }catch{}
      }
    }
    this.rebuildCsv(); // recover if a previous two-file write was interrupted
  }
  private rebuildCsv(){
    const rows=this.samples.map(s=>SPEED_COLUMNS.map(k=>escapeCsv(s[k])).join(","));
    writeFileSync(this.csvPath,SPEED_COLUMNS.join(",")+"\n"+(rows.length?rows.join("\n")+"\n":""),"utf8");
  }
  save(payload:Record<string,unknown>){
    const sampleId=clean(payload.sampleId,100);
    if(!/^[\w-]{8,100}$/.test(sampleId))throw new Error("Invalid sample id.");
    if(this.ids.has(sampleId))return{saved:false,duplicate:true,sampleId,summary:this.summary()};
    const visibleChars=num(payload.visibleChars,1,1_000_000);
    const wordCount=num(payload.wordCount,0,1_000_000);
    const observedDecodeMs=num(payload.observedDecodeMs,0,3_600_000);
    const totalVisibleElapsedMs=optNum(payload.totalVisibleElapsedMs,0,3_600_000);
    const timeToFirstVisibleMs=optNum(payload.timeToFirstVisibleMs,0,3_600_000);
    const sampleCount=num(payload.sampleCount,1,250_000);
    const measuredAtUtc=clean(payload.measuredAtUtc,40);
    if(!Number.isFinite(Date.parse(measuredAtUtc)))throw new Error("Invalid sample timestamp.");
    const estimatedOutputTokens=Math.max(1,Math.round(visibleChars/4));
    const estimatedTokensPerSecond=observedDecodeMs>=250?round(estimatedOutputTokens*1000/observedDecodeMs):null;
    const visibleCharsPerSecond=observedDecodeMs>=250?round(visibleChars*1000/observedDecodeMs):null;
    const sample:ResponseSpeedSample={
      sampleId,measuredAtUtc,receivedAtUtc:new Date().toISOString(),
      provider:"ChatGPT Plus web (UI)",
      modelLabel:clean(payload.modelLabel,90)||"Unverified",
      workloadLabel:clean(payload.workloadLabel,90)||"general",
      timingOrigin:["submit_event","user_turn_dom","unknown"].includes(String(payload.timingOrigin))?String(payload.timingOrigin):"unknown",
      completionSignal:["ui_complete","idle_inferred","pagehide"].includes(String(payload.completionSignal))?String(payload.completionSignal):"idle_inferred",
      quality:["observed","partial","low_confidence"].includes(String(payload.quality))?String(payload.quality):"low_confidence",
      visibilityState:payload.visibilityState==="visible"?"visible":"hidden",
      visibleChars,wordCount,estimatedOutputTokens,timeToFirstVisibleMs,
      observedDecodeMs,totalVisibleElapsedMs,sampleCount,
      estimatedTokensPerSecond,visibleCharsPerSecond,
      estimatorVersion:"visible_chars_div_4_v1",
      detectorVersion:clean(payload.detectorVersion,30)||"unknown"
    };
    appendFileSync(this.jsonlPath,JSON.stringify(sample)+"\n","utf8");
    this.ids.add(sampleId);this.samples.push(sample);
    appendFileSync(this.csvPath,SPEED_COLUMNS.map(k=>escapeCsv(sample[k])).join(",")+"\n","utf8");
    return{saved:true,duplicate:false,sampleId,summary:this.summary()};
  }
  summary(){
    const speeds=this.samples.filter(s=>s.quality==="observed"&&s.visibilityState==="visible").map(s=>s.estimatedTokensPerSecond).filter((n):n is number=>n!==null&&Number.isFinite(n));
    const ttfs=this.samples.filter(s=>s.visibilityState==="visible").map(s=>s.timeToFirstVisibleMs).filter((n):n is number=>n!==null&&Number.isFinite(n));
    return{samples:this.samples.length,validSpeedSamples:speeds.length,
      medianEstimatedTokensPerSecond:percentile(speeds,.5),
      p95EstimatedTokensPerSecond:percentile(speeds,.95),
      medianFirstVisibleMs:percentile(ttfs,.5),
      p95FirstVisibleMs:percentile(ttfs,.95),
      csvPath:this.csvPath,jsonlPath:this.jsonlPath,
      precision:"UI visible-character estimate, not server/API tokens"};
  }
  recent(limit=10){return this.samples.slice(-Math.max(1,Math.min(100,Math.floor(limit)||10))).map(v=>({...v}));}
  exportCsv(){return readFileSync(this.csvPath,"utf8");}
}

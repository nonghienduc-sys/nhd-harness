import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { resolve, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const root=resolve(import.meta.dirname,"..");
const packageRoot=join(root,"release-lite","win-unpacked","resources","app");
const exe=process.env.EDGE_EXE||"C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
assert(existsSync(exe),"Edge missing for GUI smoke");
assert(existsSync(join(packageRoot,"dashboard","setup.html")),"Packaged setup missing");
const stage=join(root,".lite-stage","ui-smoke");
mkdirSync(stage,{recursive:true});
const port=39520;
const env={...process.env,WORKSTATION_MCP_DATA_DIR:join(stage,"data"),WORKSTATION_MCP_PORT:String(port),WORKSTATION_MCP_LOCAL_PORT:"39524",WORKSTATION_OFFICE_PORT:"39521",WORKSTATION_SCREEN_PORT:"39522",WORKSTATION_TUNNEL_SUPERVISOR_PORT:"39523",WORKSTATION_OPENAI_TUNNEL_ENABLED:"0",NHD_PYTHON_PATH:join(packageRoot,"runtime","python-embed","python.exe")};
const server=spawn(process.execPath,[join(packageRoot,"dist","server.js")],{cwd:packageRoot,env,windowsHide:true,stdio:["ignore","pipe","pipe"]});
let stderr="";server.stderr.on("data",s=>stderr=(stderr+s.toString()).slice(-1600));
const url="http://127.0.0.1:"+port+"/setup.html",imagePath=join(stage,"setup-render.png");
function runEdge(args,timeout=40000){
 return new Promise((resolvePromise,reject)=>{
   const child=spawn(exe,args,{windowsHide:true,stdio:["ignore","pipe","pipe"]});
   let out="",err="";
   child.stdout.on("data",d=>out+=d.toString());
   child.stderr.on("data",d=>err=(err+d.toString()).slice(-1000));
   const timer=setTimeout(()=>{child.kill();reject(Error("Edge timed out: "+err));},timeout);
   child.on("error",e=>{clearTimeout(timer);reject(e)});
   child.on("close",code=>{clearTimeout(timer);if(code!==0 && !out.includes("<html"))return reject(Error("Edge failed: "+code+" "+err));resolvePromise(out);});
 });
}
try{
 let ready=false;
 for(let i=0;i<60;i++){if(server.exitCode!==null)break;try{if((await fetch("http://127.0.0.1:"+port+"/api/health/live")).ok){ready=true;break}}catch{}await delay(350)}
 assert(ready,"Packaged server failed to start: "+stderr);
 const common=["--headless=new","--disable-gpu","--no-first-run","--no-default-browser-check","--disable-extensions","--window-size=1280,920","--virtual-time-budget=3500","--user-data-dir="+join(stage,"edge-profile")];
 const dom=await runEdge([...common,"--dump-dom",url]);
 for(const marker of ['id="cloudflareTab"','id="openaiTab"','id="confirmed"','id="provision"','id="finalUrl"','id="finish"'])assert(dom.includes(marker),"Wizard control missing: "+marker);
 assert(dom.includes("NHD Harness"),"Wizard title missing");
 await runEdge([...common,"--screenshot="+imagePath,url]);
 assert(existsSync(imagePath) && statSync(imagePath).size>10_000,"GUI screenshot missing");
 console.log(JSON.stringify({ok:true,url,controls:6,renderedScreenshotBytes:statSync(imagePath).size,screenshot:imagePath,environment:"packaged backend + headless Microsoft Edge"},null,2));
}finally{server.kill();await Promise.race([new Promise(r=>server.once("exit",r)),delay(3000)])}

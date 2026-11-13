import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const root = resolve(import.meta.dirname,"..");
const appRoot = join(root,"release-lite","win-unpacked","resources","app");
assert(existsSync(join(appRoot,"dist","server.js")),"missing packaged server");
assert(existsSync(join(appRoot,"runtime","python-embed","python.exe")),"missing embedded Python");
const port = 39420, local = 39424, dataDir = join(root,".lite-stage","smoke-data");
mkdirSync(dataDir,{recursive:true});
const env = {...process.env, WORKSTATION_MCP_DATA_DIR:dataDir,WORKSTATION_MCP_PORT:String(port),WORKSTATION_MCP_LOCAL_PORT:String(local),
WORKSTATION_OFFICE_PORT:"39421",WORKSTATION_SCREEN_PORT:"39422",WORKSTATION_TUNNEL_SUPERVISOR_PORT:"39423",
NHD_PYTHON_PATH:join(appRoot,"runtime","python-embed","python.exe"),CLOUDFLARED_PATH:join(appRoot,"runtime","cloudflared.exe"),
WORKSTATION_OPENAI_TUNNEL_ENABLED:"0"};
const child=spawn(process.execPath,[join(appRoot,"dist","server.js")],{cwd:appRoot,windowsHide:true,env,stdio:["ignore","pipe","pipe"]});
let stderr="",stdout="";
child.stdout.on("data",c=>{stdout=(stdout+c.toString()).slice(-2500);});
child.stderr.on("data",c=>{stderr=(stderr+c.toString()).slice(-3500);});
const base="http://127.0.0.1:"+port;
const request=async(path,options)=>{const response=await fetch(base+path,options);const data=await response.json().catch(()=>null);return {status:response.status,data};};
let finished=false;
try {
  let live=false;
  for(let i=0;i<75;i++){
    if(child.exitCode!==null)break;
    try {const r=await request("/api/health/live");if(r.status===200&&r.data.ok){live=true;break;}}catch{}
    await delay(400);
  }
  assert(live,"Packaged backend not ready: "+stderr+" "+stdout);
  const setup=await request("/api/setup/status");assert.equal(setup.status,200);
  assert.equal(setup.data.cloudflare.cloudflaredReady,true);
  const plan=await request("/api/setup/cloudflare/plan",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({domain:"example.com",subdomain:"mcp"})});
  assert.equal(plan.status,200);assert.equal(plan.data.mcpUrl,"https://mcp.example.com/mcp");
  const rejected=await request("/api/setup/cloudflare/provision",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({domain:"example.com",subdomain:"mcp",confirmed:false})});
  assert.equal(rejected.status,409,"DNS mutation must require explicit owner consent");
  const oauth=await request("/.well-known/oauth-protected-resource");assert.equal(oauth.status,200);
  const mcp=await request("/mcp",{method:"POST",headers:{"content-type":"application/json"},body:"{}"});
  assert.equal(mcp.status,401,"Remote MCP without OAuth must be denied");
  let turbo=null;
  for(let i=0;i<20;i++){
    const health=await request("/api/health/fast");
    turbo=health.data?.data?.backgroundTurbo??health.data?.backgroundTurbo??null;
    if(turbo?.workers?.python?.online && turbo.workers.powershell.every(w=>w.online))break;
    await delay(500);
  }
  assert(turbo?.workers?.python?.online,"embedded Python worker offline");
  assert(turbo.workers.powershell.every(w=>w.online),"PowerShell workers offline");
  console.log(JSON.stringify({ok:true,version:setup.data.version,mcpProtected:true,cloudflarePlanSafe:true,workers:{powershell:turbo.workers.powershell.map(w=>w.online),python:turbo.workers.python.online}},null,2));
  finished=true;
} finally {
  child.kill();
  await Promise.race([new Promise(resolvePromise=>child.once("exit",resolvePromise)),delay(5000)]);
}
if(!finished)process.exitCode=1;

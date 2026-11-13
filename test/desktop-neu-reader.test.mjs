import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {Store} from "../dist/db.js";
import {TaskRunManager} from "../dist/task-runtime.js";
import {DesktopService} from "../dist/desktop.js";

test("NEU Reader Flutter visual navigation is task-gated, region bounded and auditable", async () => {
  const dir=await mkdtemp(join(tmpdir(),"nhd-flutter-reader-"));
  const store=new Store(join(dir,"workstation.sqlite"));
  const tasks=new TaskRunManager(store,{roots:[dir]});
  const run=tasks.start(tasks.create({objective:"Read a NEU textbook",root:dir,maxRuntimeMs:60000}).id);
  const config={emergencyStop:false,desktopEnabled:true,screenPort:39021,companionSecret:"test-secret"};
  const service=new DesktopService(config,store,tasks.authorizations);
  const originalFetch=globalThis.fetch;
  const requests=[];
  globalThis.fetch=async(url,init={})=>{
    assert.equal(init.headers["x-workstation-companion-secret"],"test-secret");
    if(String(url).endsWith("/ui/windows"))return new Response(JSON.stringify({windows:[
      {windowId:"100",title:"NEU Reader",processId:1},
      {windowId:"200",title:"Zalo",processId:2}
    ]}),{status:200,headers:{"content-type":"application/json"}});
    if(String(url).endsWith("/ui/action")){
      const payload=JSON.parse(init.body);
      requests.push(payload);
      return new Response(JSON.stringify({ok:true,hitTest:{withinSelectedWindow:true,blocked:false,control:{controlType:"Pane",name:"FLUTTERVIEW"}}}),{status:200,headers:{"content-type":"application/json"}});
    }
    throw Error("Unexpected request "+url);
  };
  try{
    await assert.rejects(()=>service.action({action:"scroll",windowId:"100",direction:"down",amount:2,taskRunId:run.id}),/authorization/i);
    tasks.authorize(run.id,{maxRiskLevel:"moderate",ttlMinutes:15});
    await service.windows();
    const moved=await service.action({action:"scroll",windowId:"100",direction:"down",amount:2,taskRunId:run.id});
    assert.equal(moved.ok,true);
    assert.equal(moved.app,"NEU Reader");
    assert.equal(requests.at(-1).direction,"down");
    assert.equal(requests.at(-1).amount,2);
    const clicked=await service.action({action:"click_point",windowId:"100",xRatio:0.35,yRatio:0.5,taskRunId:run.id});
    assert.equal(clicked.category,"safe_reader_navigation");
    await assert.rejects(()=>service.action({action:"click_point",windowId:"200",xRatio:0.35,yRatio:0.5,taskRunId:run.id}),/coordinate clicks remain blocked outside the verified NEU Reader window/);
    await assert.rejects(()=>service.action({action:"click_point",windowId:"100",xRatio:0.85,yRatio:0.1,taskRunId:run.id}),/bounded PDF content area/);
    await assert.rejects(()=>service.action({action:"double_click_point",windowId:"100",xRatio:0.4,yRatio:0.5,taskRunId:run.id}),/Double clicks remain blocked/);
    for(const amount of [0,7,2.5,NaN])await assert.rejects(()=>service.action({action:"scroll",windowId:"100",direction:"down",amount,taskRunId:run.id}),/1-6 wheel units/);
    await assert.rejects(()=>service.action({action:"scroll",windowId:"100",direction:"sideways",amount:2,taskRunId:run.id}),/1-6 wheel units/);
    config.emergencyStop=true;
    await assert.rejects(()=>service.action({action:"scroll",windowId:"100",direction:"down",amount:1,taskRunId:run.id}),/disabled by the owner/);
  }finally{globalThis.fetch=originalFetch;}
});

test("PowerShell reader scroll adapter parses without syntax errors",async(t)=>{
  if(process.platform!=="win32")return t.skip("PowerShell adapter is Windows-specific");
  const {spawnSync}=await import("node:child_process");
  const script=join(process.cwd(),"office","desktop_automation.ps1");
  const cmd='$tokens=$null;$errors=$null;[System.Management.Automation.Language.Parser]::ParseFile("'+script.replaceAll('\\','\\\\')+'",[ref]$tokens,[ref]$errors)|Out-Null;if($errors.Count){$errors|ForEach-Object{Write-Output $_.Message};exit 1};Write-Output "PowerShell parser OK"';
  const out=spawnSync("powershell.exe",["-NoLogo","-NoProfile","-Command",cmd],{encoding:"utf8",timeout:15000});
  assert.equal(out.status,0,out.stderr+" "+out.stdout);
});

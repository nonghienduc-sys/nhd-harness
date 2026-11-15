import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { flattenWinAppUi } from "../dist/winapp-uia.js";
import { DesktopService } from "../dist/desktop.js";
import { Store } from "../dist/db.js";
import { TaskRunManager } from "../dist/task-runtime.js";

const item = (selector,name,type,automationId="")=>({
  selector,name,type,automationId,isEnabled:true,isOffscreen:false,
  isInvokable:type!=="Text",x:0,y:0,width:500,height:40
});
test("WinApp fallback flattens a single HWND and retains Zalo semantic selectors",()=>{
  const data=flattenWinAppUi({windows:[{elements:[{type:"Pane",name:"Zalo",selector:"root",children:[
    item("contact-search-input","","Edit","contact-search-input"),
    item("lbl-cloud","Cloud của tôi","Text"),
  ]}]}]});
  assert.equal(data.length,3);
  assert.ok(data.some(x=>x.automationId==="contact-search-input"));
  assert.throws(()=>flattenWinAppUi({windows:[{},{}]}),/exactly one window/);
});
test("Zalo fallback edits only inspected search and keeps coordinate ban",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"zalo-winapp-test-"));
  const store=new Store(join(dir,"test.sqlite"));
  const tasks=new TaskRunManager(store,{roots:[dir]});
  const run=tasks.start(tasks.create({root:dir,objective:"Search only, no sends",maxRuntimeMs:120000}).id);
  tasks.authorize(run.id,{maxRiskLevel:"moderate",ttlMinutes:10});
  const d=new DesktopService({emergencyStop:false,desktopEnabled:true,screenPort:39123,companionSecret:"test"},store,tasks.authorizations);
  let value=null;
  d.winapp={available:()=>true,inspect:async()=>[
    {selector:"contact-search-input",name:"",automationId:"contact-search-input",className:"",controlType:"Edit",enabled:true,offscreen:false,invokable:true,bounds:null}
  ],setValue:async(...args)=>{value=args;return {ok:true}},invoke:async()=>{throw Error("Unexpected invoke")}};
  const old=globalThis.fetch;
  globalThis.fetch=async(url,init={})=>{
    if(String(url).endsWith("/ui/windows"))return new Response(JSON.stringify({windows:[{windowId:"67142",title:"Zalo",processId:13192}]}),{status:200,headers:{"content-type":"application/json"}});
    if(String(url).endsWith("/ui/inspect"))return new Response(JSON.stringify({controls:[
      {selectorId:"g1",windowId:"67142",name:"Zalo",controlType:"Window",enabled:true,offscreen:false,password:false},
      {selectorId:"g2",windowId:"67142",name:"Chrome",controlType:"Pane",enabled:true,offscreen:false,password:false},
    ],total:2,truncated:false}),{status:200,headers:{"content-type":"application/json"}});
    throw Error("Unexpected fetch");
  };
  try{
    await d.windows();
    const controls=(await d.inspect("67142")).controls;
    const found=controls.find(x=>x.automationId==="contact-search-input");
    assert.ok(found && found.selectorId.startsWith("winapp-"));
    const result=await d.action({action:"set_text",windowId:"67142",selectorId:found.selectorId,text:"Cloud của tôi",taskRunId:run.id});
    assert.equal(result.backend,"winapp-native-uia");
    assert.deepEqual(value,["67142","contact-search-input","Cloud của tôi"]);
    await assert.rejects(()=>d.action({action:"click_point",windowId:"67142",xRatio:0.4,yRatio:0.5,taskRunId:run.id}),/coordinate clicks remain blocked/);
  }finally{globalThis.fetch=old;}
});
test("Cloud search result inside sidebar cannot count as selected chat header",()=>{
  const data=flattenWinAppUi({windows:[{elements:[{
    selector:"root",type:"Document",name:"Zalo",children:[
      {selector:"sidebarNav",type:"Group",children:[
        {selector:"search-result",name:"Cloud của tôi",type:"Text",isEnabled:true}
      ]},
      {selector:"mainHeader",type:"Text",name:"Cloud của tôi",isEnabled:true}
    ]
  }]}]});
  assert.equal(data.find(x=>x.selector==="search-result").inSidebar,true);
  assert.equal(data.find(x=>x.selector==="mainHeader").inSidebar,false);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import Ajv from 'ajv/dist/2020.js';

const root=resolve(import.meta.dirname,'..');
const port=await new Promise((ok,fail)=>{const s=createServer();s.once('error',fail);s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>ok(p))})});
const corePort=await new Promise((ok,fail)=>{const s=createServer();s.once('error',fail);s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>ok(p))})});
const bytes=o=>Buffer.byteLength(JSON.stringify(o),'utf8');
const text=r=>r.content?.find(x=>x.type==='text'&&!x.text?.startsWith('NHD context'))?.text;
const record=(name,o)=>console.log('BYTES '+name+' '+bytes(o));
let id=0;
async function rpc(who,method,params={}) {
 const r=await fetch('http://127.0.0.1:'+port+'/mcp',{method:'POST',headers:{'content-type':'application/json','accept':'application/json, text/event-stream','mcp-protocol-version':'2025-06-18','x-nhd-harness-id':who,'x-nhd-connection-id':who+'-session'},body:JSON.stringify({jsonrpc:'2.0',id:++id,method,params})});
 const body=await r.text();let data;try{data=JSON.parse(body)}catch{throw Error(method+': HTTP '+r.status+': '+body.slice(0,300))}
 if(!r.ok||data.error)throw Error(method+': '+JSON.stringify(data.error??data).slice(0,400));
 return data.result;
}
// Distinct requests instantiate distinct MCP servers; no custom x-nhd headers here.
async function rpcSession(session,method,params={}) {
 const r=await fetch('http://127.0.0.1:'+port+'/mcp',{method:'POST',
  headers:{'content-type':'application/json','accept':'application/json, text/event-stream',
    'mcp-protocol-version':'2025-06-18','mcp-session-id':session},
  body:JSON.stringify({jsonrpc:'2.0',id:++id,method,params})});
 const data=await r.json();
 if(!r.ok||data.error)throw Error(method+' session '+session+': '+JSON.stringify(data.error??data).slice(0,400));
 return data.result;
}
function sample(s,base=s,depth=0,v=0) {
 if(depth>9)return null;
 if(s.$ref?.startsWith('#/'))return sample(s.$ref.slice(2).split('/').reduce((x,k)=>x?.[k.replace(/~1/g,'/').replace(/~0/g,'~')],base)??{},base,depth+1,v);
 if('const'in s)return s.const;
 if(s.enum?.length)return s.enum[v%s.enum.length];
 if(s.oneOf?.length)return sample(s.oneOf[0],base,depth+1,v);
 if(s.anyOf?.length)return sample(s.anyOf[0],base,depth+1,v);
 if(s.allOf?.length)return Object.assign({},...s.allOf.map(x=>sample(x,base,depth+1,v)));
 const ty=Array.isArray(s.type)?s.type.find(x=>x!=='null'):s.type;
 if(ty==='object'||s.properties){
   const o={};for(const k of s.required??[])o[k]=sample(s.properties?.[k]??{},base,depth+1,0);
   const optional=Object.keys(s.properties??{}).filter(k=>!(s.required??[]).includes(k));
   if(v>0)for(const k of optional.slice(0,v))o[k]=sample(s.properties[k],base,depth+1,v);
   return o;
 }
 if(ty==='array')return Array.from({length:s.minItems??0},(_,i)=>sample(s.items??{},base,depth+1,i));
 if(ty==='integer'||ty==='number')return (s.minimum??0)+(s.exclusiveMinimum!==undefined?1:0);
 if(ty==='boolean')return v%2===0;
 if(ty==='null')return null;
 if(ty==='string'){
  if(s.format==='uri'||s.format==='url')return 'https://example.org/';
  if(s.format==='date-time')return '2026-01-01T00:00:00Z';
  if(s.format==='email')return 'example@example.org';
  return (s.pattern?.includes('A-Za-z0-9')?'A1':'x').repeat(Math.max(1,s.minLength??0));
 }
 return {};
}
test('measure real temporary MCP server at ephemeral port and compare schema/result fidelity',{timeout:180000},async()=>{
 const dir=mkdtempSync(join(tmpdir(),'nhd-output-a-'));
 let child;
 try {
  writeFileSync(join(dir,'config.json'),JSON.stringify({roots:[root],structuredOnlyClients:['thin-client'],localHarnessEnabled:true,localHarnessPort:port,writeEnabled:false,terminalEnabled:false,screenEnabled:false,desktopEnabled:false,browserEnabled:false,visualDesktopEnabled:false,intakeEnabled:false}));
  child=spawn(process.execPath,[join(root,'dist/server.js')],{cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,WORKSTATION_MCP_DATA_DIR:dir,WORKSTATION_MCP_PORT:String(corePort),WORKSTATION_MCP_LOCAL_PORT:String(port),WORKSTATION_MCP_LOCAL_ENABLED:'1',NHD_RESULT_PAYLOAD_GATEWAY:'0',NHD_BRAIN_ONLY:'0'}});
  let log='';for(const s of [child.stdout,child.stderr])s.on('data',b=>log+=String(b).slice(-1000));
  let ready=false;for(let i=0;i<160;i++){if(child.exitCode!==null)throw Error('server exit: '+log.slice(-1000));try{await fetch('http://127.0.0.1:'+port+'/health',{signal:AbortSignal.timeout(500)});ready=true;break}catch{await new Promise(ok=>setTimeout(ok,200))}}
  assert.ok(ready,'ephemeral server did not start: '+log.slice(-900));
  for(const [who,name] of [['unknown','unknown-client'],['thin','thin-client 2']])await rpc(who,'initialize',{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name,version:'1.0'}});
  for(const who of ['unknown','thin'])await rpc(who,'tools/call',{name:'context_bootstrap',arguments:{}});
  // Simulate stateless ChatGPT MCP: initialize and tool calls use different server instances.
  await rpcSession('session-thin','initialize',{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'thin-client 2',version:'7.2'}});
  await rpcSession('session-thin','tools/call',{name:'context_bootstrap',arguments:{}});
  await rpcSession('session-other','tools/call',{name:'context_bootstrap',arguments:{}});
  const sessionArgs={path:join(root,'src','intake.ts')};
  const sessionThin=await rpcSession('session-thin','tools/call',{name:'fs_read',arguments:sessionArgs});
  const sessionUnknown=await rpcSession('session-other','tools/call',{name:'fs_read',arguments:sessionArgs});
  assert.ok(text(sessionThin)?.length<=400,'session reuses initialized client name');
  assert.match(text(sessionThin),/structuredContent/);
  assert.equal(text(sessionUnknown),JSON.stringify(sessionUnknown.structuredContent),'different session must be full JSON');
  assert.deepEqual(sessionThin.structuredContent,sessionUnknown.structuredContent);
  const observed=await rpcSession('session-thin','tools/call',{name:'harness_mode',arguments:{action:'status'}});
  assert.ok(observed.structuredContent.observedClients.some(x=>x.name==='thin-client 2'&&x.version==='7.2'));
  assert.ok(observed.structuredContent.observedClients.every(x=>Object.keys(x).sort().join(',')==='name,version'));
  console.log('STATELESS CLIENT: session key correctly isolates initialize and subsequent tools/call');
  const tools=(await rpc('unknown','tools/list')).tools;
  record('tools/list',{tools});assert.ok(bytes({tools})<124300); // v0.24.44: +~813 byte cho code_run
  assert.ok(tools.length>=20);assert.ok(tools.every(t=>!Object.hasOwn(t.inputSchema,'$schema')));
  const ajv=new Ajv({strict:false,validateFormats:false});
  const top=tools.toSorted((a,b)=>bytes(b.inputSchema)-bytes(a.inputSchema)).slice(0,20);
  for(const tool of top){
   const old=ajv.compile({$schema:'https://json-schema.org/draft/2020-12/schema',...tool.inputSchema}),current=ajv.compile(tool.inputSchema);
   const valid=[];for(let i=0;i<50&&valid.length<3;i++){const x=sample(tool.inputSchema,tool.inputSchema,0,i);if(old(x)&&current(x))valid.push(x)}
   assert.equal(valid.length,3,'3 valid params '+tool.name);
   for(const x of [...valid,null,[]])assert.equal(!!old(x),!!current(x),'ajv equivalent '+tool.name);
   assert.equal(old(null),false);assert.equal(old([]),false);
  }
  console.log('AJV 20 SCHEMAS x 3 valid + 2 invalid OK');
  const checks=[['fs_read',{path:join(root,'src','intake.ts')}],['fs_list',{path:root,limit:30}]];
  for(const [name,args] of checks){
   const full=await rpc('unknown','tools/call',{name,arguments:args}),thin=await rpc('thin','tools/call',{name,arguments:args});
   assert.deepEqual(full.structuredContent,thin.structuredContent);
   assert.equal(text(full),JSON.stringify(full.structuredContent));
   assert.ok(text(thin)?.length<=400);assert.match(text(thin),/Dữ liệu đầy đủ trong structuredContent/);
   record(name,full);record(name+'_thin',thin);
  }
  const args={domain:'files',operation:'read'};
  const plan=await rpc('unknown','tools/call',{name:'workstation_plan',arguments:args}),full=await rpc('unknown','tools/call',{name:'workstation_plan',arguments:{...args,verbose:true}});
  assert.ok(JSON.stringify(plan.structuredContent).length<=2500,'plan <=2500');
  assert.deepEqual(plan.structuredContent.executionPlan.governor.recommendedTools,full.structuredContent.executionPlan.governor.recommendedTools);
  assert.deepEqual(plan.structuredContent.executionPlan.governor.avoidUnlessNeeded,full.structuredContent.executionPlan.governor.avoidUnlessNeeded);
  assert.equal(plan.structuredContent.executionPlan.governor.taskClass,full.structuredContent.executionPlan.governor.taskClass);
  for(const key of ['mode','methodLocked','goalOpen','verificationRequired'])assert.equal(
   plan.structuredContent.executionPlan.intentPolicy[key],full.structuredContent.executionPlan.intentPolicy[key]);
  assert.ok(full.structuredContent.capabilities&&full.structuredContent.executionPlan.governor);
  assert.equal(plan.structuredContent.executionPlan.route.route,full.structuredContent.executionPlan.route.route);
  record('workstation_plan',plan);record('workstation_plan_verbose',full);
  for(const [name,args] of [['runtime_identity',{}],['harness_mode',{action:'status'}],['tool_governor',{action:'plan',text:'Read one file'}]]){
   const a=await rpc('unknown','tools/call',{name,arguments:args}),b=await rpc('unknown','tools/call',{name,arguments:{...args,verbose:true}});
   const counted=name==='tool_governor'?{...a.structuredContent,memoryPack:undefined}:a.structuredContent;
   assert.ok(JSON.stringify(counted).length<=1500,name+' <=1500 excluding memoryPack');
   if(name==='tool_governor'){
     const pack=a.structuredContent.memoryPack;
     assert.ok(pack,'governor must preserve memoryPack');
     assert.ok(a.structuredContent.memoryResolver,'governor must preserve memoryResolver');
     assert.ok(pack.projectFacts?.length<=5);
     assert.ok(pack.similarTasks?.length<=3);
     for(const key of ['globalPreferences','projectPreferences'])for(const x of pack[key]??[])assert.ok(x.value?.length<=300);
     for(const x of pack.projectFacts??[])assert.ok(x.value?.length<=401);
   }
   assert.ok(bytes(b.structuredContent)>=bytes(a.structuredContent));
   assert.equal(text(a),JSON.stringify(a.structuredContent));
   record(name,a);record(name+'_verbose',b);
  }
 }finally{
  if(child){child.kill();await new Promise(ok=>{if(child.exitCode!==null)return ok();child.once('exit',ok);setTimeout(ok,5000).unref()})}
  rmSync(dir,{recursive:true,force:true});
 }
});

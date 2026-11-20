import { DEFAULT_TOOL_CATALOG_CORE_TOOLS, toolCatalogMode, toolCatalogCore } from '../dist/tool-catalog.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';

const root = resolve(import.meta.dirname, '..');
const bytes = (o) => Buffer.byteLength(JSON.stringify(o), 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let id = 0;
async function port() {
  return await new Promise((ok, bad) => {
    const s = createServer();
    s.once('error', bad);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); });
  });
}
async function start(name, options = {}) {
  const data = mkdtempSync(join(tmpdir(), 'nhd-tool-catalog-'));
  const localPort = await port(), corePort = await port();
  writeFileSync(join(data, 'config.json'), JSON.stringify({
    roots: [root], writeEnabled: false, terminalEnabled: false, screenEnabled: false,
    desktopEnabled: false, browserEnabled: false, visualDesktopEnabled: false, intakeEnabled: false,
    localHarnessEnabled: true, localHarnessPort: localPort, ...options
  }));
  const child = spawn(process.execPath, [join(root, 'dist/server.js')], {
    cwd: root, windowsHide: true, stdio: ['ignore','pipe','pipe'],
    env: {...process.env, WORKSTATION_MCP_DATA_DIR: data,
      WORKSTATION_MCP_PORT: String(corePort), WORKSTATION_MCP_LOCAL_PORT: String(localPort),
      WORKSTATION_MCP_LOCAL_ENABLED: '1', NHD_RESULT_PAYLOAD_GATEWAY: '0', NHD_BRAIN_ONLY: '0'}
  });
  let log = '';
  child.stdout.on('data', (b) => {log = (log + String(b)).slice(-3000);});
  child.stderr.on('data', (b) => {log = (log + String(b)).slice(-3000);});
  for (let i=0; i<200; i++) {
    if(child.exitCode !== null) throw Error(name+' exit: '+log);
    try {
      const response = await fetch('http://127.0.0.1:'+localPort+'/health', {signal:AbortSignal.timeout(500)});
      if(response.ok) return {name,data,child,port:localPort};
    } catch {}
    await sleep(150);
  }
  throw Error(name+' was not ready: '+log);
}
async function stop(s) {
  if(!s) return;
  s.child.kill();
  await Promise.race([new Promise((ok)=>s.child.once('exit',ok)), sleep(3000)]);
  rmSync(s.data,{recursive:true,force:true});
}
async function rpc(s, session, method, params={}) {
  const response = await fetch('http://127.0.0.1:'+s.port+'/mcp', {
    method:'POST',
    headers:{'content-type':'application/json','accept':'application/json, text/event-stream',
      'mcp-protocol-version':'2025-06-18', 'mcp-session-id':session},
    body:JSON.stringify({jsonrpc:'2.0',id:++id,method,params})
  });
  const result=await response.json();
  if(!response.ok||result.error) throw Error(s.name+' '+method+': '+JSON.stringify(result.error??result).slice(0,500));
  return result.result;
}
async function init(s,session,name) {
  return rpc(s,session,'initialize',{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name,version:'1.0'}});
}
async function call(s,session,name,args={}) {
  return rpc(s,session,'tools/call',{name,arguments:args});
}
const text = (out) => out.content?.filter(x=>x.type==='text').map(x=>x.text).join('\n') ?? '';
const compactHint='Gọi tool_describe để xem tham số.';

test('catalog preserves SDK full tools, validator, facades and per-client selection', {timeout:240000}, async () => {
  const servers=[];
  try {
    const baseline=await start('without-feature-config');
    servers.push(baseline);
    const enabled=await start('catalog-selected-client', {
      toolCatalog:{mode:'full',clients:['thin-catalog'],coreTools:[
        'fs_read','fs_list','fs_stat','fs_search','fs_preview_write',
        'fs_apply_write','doc_from_template','doc_format_check','terminal_preview','terminal_execute',
        'terminal_session','terminal_session_preview','terminal_session_execute','task_run','task_run_step',
        'receipt_write','workstation_plan','office_read','office_preview_edit','office_apply_edit',
        'pdf_document','tool_describe','context_bootstrap','context_recall','tool_governor',
      ]}
    });
    servers.push(enabled);
    await init(baseline,'baseline-session','baseline-client');
    await init(enabled,'full-session','unmatched-client');
    await init(enabled,'catalog-session','agent thin-catalog / GPT');
    const without=(await rpc(baseline,'baseline-session','tools/list')).tools;
    const full=(await rpc(enabled,'full-session','tools/list')).tools;
    const compact=(await rpc(enabled,'catalog-session','tools/list')).tools;
    assert.equal(JSON.stringify(full),JSON.stringify(without), 'default full is byte-identical to no toolCatalog settings');
    assert.ok(full.length > 40);
    assert.deepEqual(compact.map(t=>t.name),full.map(t=>t.name),'no tool disappeared or changed order');
    const core=full.filter(t=>JSON.stringify(t)===JSON.stringify(compact.find(c=>c.name===t.name)));
    assert.ok(core.length<=25,'at most 25 fully described tools');
    const outs=full.filter(t=>!core.some(c=>c.name===t.name));
    assert.ok(outs.length>=10);
    for (const f of full) {
      const c=compact.find(x=>x.name===f.name);
      assert.deepEqual(c.annotations, f.annotations, f.name+' annotation fidelity');
      if(!outs.includes(f)) continue;
      assert.ok(!c.description.includes('\n')&&c.description.length<=160,f.name+' description <=160');
      assert.ok(c.description.endsWith(compactHint),f.name+' suffix');
      assert.deepEqual(c.inputSchema,{type:'object'},f.name+' permissive advertised schema');
    }
    const fullSize=bytes({tools:full}), catalogSize=bytes({tools:compact});
    console.log('TOOL_CATALOG full bytes='+fullSize+' catalog bytes='+catalogSize+' ratio='+(100*catalogSize/fullSize).toFixed(2)+'%');
    assert.ok(catalogSize<=fullSize*0.40,'catalog must be no more than 40% bytes');
    for(let k=0;k<outs.length;k+=10) {
      const part=outs.slice(k,k+10), names=part.map(t=>t.name);
      const described=await call(enabled,'catalog-session','tool_describe',{names});
      assert.equal(described.isError,undefined,'describing valid tools does not fail');
      assert.deepEqual(described.structuredContent.tools,part.map(t=>({name:t.name,description:t.description,inputSchema:t.inputSchema})));
    }
    const unknown=await call(enabled,'catalog-session','tool_describe',{names:['fs_reed']});
    assert.equal(unknown.isError,true);
    assert.match(text(unknown),/fs_read/);
    // Check real registered read-only tools, not mock callbacks. Each valid
    // call uses the same parameters in both modes; invalid args must be caught
    // by the unchanged SDK Zod validator before reaching the tool handler.
    const cases=[
      ['runtime_identity', {}, {verbose:'not-a-boolean'}],
      ['coc_coc_page', {}, {tab_id:'invalid'}],
      ['coc_coc_inspect', {}, {limit:'invalid'}],
      ['coc_coc_snapshot', {}, {max_chars:'invalid'}],
      ['browser_inspect', {op:'inspect'}, {op:'bad-op'}],
      ['office_admin_release_status', {op:'status'}, {op:'bad-op'}],
      ['background_turbo', {op:'status'}, {op:'bad-op'}],
      ['execution_info', {op:'lanes_status'}, {op:'bad-op'}],
      ['isolated_desktop_read', {op:'agent_status'}, {op:'bad-op'}],
      ['isolated_browser_read', {op:'status'}, {op:'bad-op'}],
      ['self_evolution_inspect', {op:'status'}, {op:'bad-op'}],
      ['skills_registry', {op:'list'}, {op:'bad-op'}],
    ];
    await call(enabled,'full-session','context_bootstrap',{});
    await call(enabled,'catalog-session','context_bootstrap',{});
    let count=0;
    for(const [name,valid,invalid] of cases){
      const tool=outs.find(t=>t.name===name);
      if(!tool||tool.annotations?.readOnlyHint!==true) continue;
      const a=await call(enabled,'full-session',name,valid);
      const b=await call(enabled,'catalog-session',name,valid);
      assert.deepEqual(b,a,name+' valid-call output unchanged');
      const err=await call(enabled,'catalog-session',name,invalid);
      assert.equal(err.isError,true,name+' bad arguments must fail');
      assert.match(text(err),/Input validation error:/,name+' Zod validation');
      assert.deepEqual(err.structuredContent?.inputSchema,tool.inputSchema,name+' full schema on error');
      count++;
    }
    console.log('TOOL_CATALOG tested read-only tool correct+invalid calls='+count);
    assert.ok(count>=10,'at least 10 read-only non-core tools');
    // Verify protocol-level SDK validation reaches audit even before handlers run.
    const sentinel='PRIVATE_ARGUMENT_VALUE_74182';
    const invalidCall=await call(enabled,'catalog-session','fs_list',{limit:sentinel});
    assert.equal(invalidCall.isError,true);
    const {DatabaseSync}=await import('node:sqlite');
    const db=new DatabaseSync(join(enabled.data,'workstation.sqlite'),{readOnly:true});
    const audits=db.prepare("SELECT action,detail FROM audit WHERE action IN ('tool_describe','tool_invalid_params')").all();
    db.close();
    const inspected=audits.filter(row=>row.action==='tool_describe').map(row=>JSON.parse(row.detail));
    const invalids=audits.filter(row=>row.action==='tool_invalid_params').map(row=>JSON.parse(row.detail));
    assert.ok(inspected.some(row=>row.tool==='fs_reed' && row.found===false), 'missing name is audited');
    assert.ok(inspected.some(row=>row.tool!=='fs_reed' && row.found===true), 'found name is audited');
    assert.ok(invalids.some(row=>row.tool==='fs_list' && row.issues.some(issue=>issue.startsWith('limit:'))),
      'field path and Zod code should be recorded');
    assert.ok(!JSON.stringify(audits).includes(sentinel),'invalid argument values cannot enter audit');
  } finally {
    for(const s of servers.toReversed()) await stop(s);
  }
});

test('global catalog override and core limit retain tool_describe', () => {
  assert.equal(toolCatalogMode({mode:'full', clients:['agent']},'other'), 'full');
  assert.equal(toolCatalogMode({mode:'full', clients:['agent']},'worker-agent-v2'), 'catalog');
  assert.equal(toolCatalogMode({mode:'catalog', clients:[]},'other'), 'catalog');
  assert.equal(toolCatalogMode(undefined,'other'), 'full');
  assert.deepEqual([...DEFAULT_TOOL_CATALOG_CORE_TOOLS], ["fs_read","fs_list","fs_stat","fs_search","fs_preview_write","fs_apply_write","doc_from_template","doc_format_check","terminal_preview","terminal_execute","terminal_session","terminal_session_preview","terminal_session_execute","task_run","task_run_step","receipt_write","workstation_plan","office_read","office_preview_edit","office_apply_edit","pdf_document","tool_describe","context_bootstrap","context_recall","tool_governor"]);
  const core=toolCatalogCore({coreTools:Array.from({length:90},(_,i)=>'tool'+i)});
  assert.equal(core.size,25);
  assert.ok(core.has('tool_describe'));
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

// runtime/ kh\u00F4ng c\u00F3 trong b\u1EA3n m\u00E3 ngu\u1ED3n c\u00F4ng khai (clone m\u1EDBi): khi thi\u1EBFu th\u00EC d\u00F9ng gi\u00E1 tr\u1ECB m\u1EB7c \u0111\u1ECBnh.
const readOptionalJson=(rel,fallback)=>{const u=new URL(rel,import.meta.url);return existsSync(u)?JSON.parse(readFileSync(u,'utf8').replace(/^\uFEFF/,'')):fallback;};
const PACKAGE_VERSION=JSON.parse(readFileSync(new URL('../package.json',import.meta.url),'utf8')).version;
const DEPLOYMENT_MANIFEST=readOptionalJson('../runtime/deployment-manifest.json',{});
const RELEASE_STATE=readOptionalJson('../runtime/release-state.json',null);
const EXPECTED_PRODUCTION_VERSION=process.env.WORKSTATION_MCP_VERSION?.trim()||PACKAGE_VERSION;
const EXPECTED_SOURCE_VERSION=process.env.NHD_SOURCE_VERSION?.trim()||DEPLOYMENT_MANIFEST.sourceVersion||PACKAGE_VERSION;
const EXPECTED_CANDIDATE_VERSION=RELEASE_STATE?.model==='atomic-json-pointer-v1'?(RELEASE_STATE.candidate?.version??null):(process.env.NHD_CANDIDATE_VERSION?.trim()||DEPLOYMENT_MANIFEST.candidateVersion||null);
const EXPECTED_ROLLBACK_VERSION=RELEASE_STATE?.model==='atomic-json-pointer-v1'?(RELEASE_STATE.previous?.version??DEPLOYMENT_MANIFEST.rollbackVersion??null):(process.env.NHD_ROLLBACK_VERSION?.trim()||DEPLOYMENT_MANIFEST.rollbackVersion||null);
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createWorkstationMcp } from './helpers/mcp-legacy.mjs';

function fixture() {
  const config = {
    roots:['D:/'], intakeRoots:['D:/inbox'], dataDir:'D:/tmp', backupDir:'D:/tmp/backups',
    writeEnabled:true, terminalEnabled:true, skillsEnabled:true, screenEnabled:true, desktopEnabled:true,
    browserEnabled:true, visualDesktopEnabled:true, intakeEnabled:true, ocrEnabled:true, emergencyStop:false,
  };
  const office = { status: async () => ({companion:true,word:true,excel:true,powerpoint:true,outlook:true}) };
  let waitCall = null;
  const counts = {click:0,fill:0,inspect:0,wait:0};
  const browser = {
    status: async () => ({enabled:true,executable:'C:/Browser/browser.exe',activePage:{title:'Before',url:'https://example.com/'}}),
    click: async selectorId => { counts.click++; return {ok:true,page:{title:'Clicked',url:'https://example.com/next'},control:{selectorId}}; },
    fill: async (selectorId,text) => { counts.fill++; return {ok:true,selectorId,characters:text.length,control:{tag:'input',name:'q'}}; },
    inspect: async () => { counts.inspect++; return {page:{title:'Observed',url:'https://example.com/next'},controls:[{selectorId:'fresh'}],total:1,truncated:false}; },
    waitForCondition: async (condition, timeoutMs) => {
      counts.wait++;
      waitCall = {condition,timeoutMs};
      return {matched:true,condition,waitedMs:10,page:{title:'Done',url:'https://example.com/next'},evidence:{}};
    },
  };
  const desktop = { status: async () => ({companion:true}) };
  const intake = { status: () => ({availableRoots:1}) };
  const pdf = { status: async () => ({nativeTextExtraction:true}) };
  const dummy = {};
  const server = createWorkstationMcp(config, dummy, dummy, dummy, office, dummy, dummy, dummy, dummy, desktop, intake, pdf, dummy, browser);
  return {server, browser, getWaitCall:()=>waitCall, getCounts:()=>({...counts})};
}

async function connected() {
  const {server,getWaitCall,getCounts} = fixture();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({name:'v06-test-client',version:'1.0.0'});
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return {server,client,getWaitCall,getCounts};
}

test('current base MCP protocol lists 62 tools (v0.24.15 facades) including payload artifact retrieval, Office transaction, incremental index watch, planner and browser verification', async () => {
  const {server,client} = await connected();
  try {
    const listed = await client.listTools();
    const names = listed.tools.map(tool => tool.name);
    assert.equal(names.length, 62);
    for (const name of ['runtime_identity','workstation_plan','browser_wait_for','browser_click_verified','browser_fill_verified','local_ai_status','local_ai_route','local_ai_dispatch','local_ai_verify','tool_governor','context_payload_artifact','project_rag_status','project_rag_query','project_rag_ingest']) assert.ok(names.includes(name) || server._nhdHiddenTools?.has(name), name);
  } finally { await client.close(); await server.close(); }
});

test('workstation_plan returns Office Live Write plan without executing it', async () => {
  const {server,client} = await connected();
  try {
    const result = await client.callTool({name:'workstation_plan',arguments:{domain:'office',operation:'edit',application:'word',live:true}});
    assert.equal(result.isError, undefined);
    assert.equal(result.structuredContent.plan.route, 'office.live.write-confirmed');
    assert.equal(result.structuredContent.plan.requiresConfirmation, false);
    assert.equal(result.structuredContent.plan.recovery.neverRepeatAfterAmbiguousExecution, true);
    assert.equal(result.structuredContent.capabilities.office.liveWriteApplications.word, true);
    assert.equal(result.structuredContent.capabilities.office.liveWriteApplications.excel, true);
  } finally { await client.close(); await server.close(); }
});

test('workstation_plan rejects blocked external side effects over MCP protocol', async () => {
  const {server,client} = await connected();
  try {
    const result = await client.callTool({name:'workstation_plan',arguments:{domain:'browser',operation:'navigate',target:'https://example.com',external_side_effect:'send'}});
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /not routable|side effect/i);
  } finally { await client.close(); await server.close(); }
});

test('workstation_plan supports Excel Live V2 Write while Excel is open', async () => {
  const {server,client} = await connected();
  try {
    const result = await client.callTool({name:'workstation_plan',arguments:{domain:'office',operation:'edit',application:'excel',live:true}});
    assert.equal(result.isError, undefined);
    assert.equal(result.structuredContent.plan.route, 'office.live.write-confirmed');
    assert.equal(result.structuredContent.plan.requiresConfirmation, false);
    assert.equal(result.structuredContent.capabilities.office.liveWriteApplications.excel, true);
  } finally { await client.close(); await server.close(); }
});

test('browser_wait_for passes a machine-checkable post-condition through MCP', async () => {
  const {server,client,getWaitCall} = await connected();
  try {
    const result = await client.callTool({name:'browser_wait_for',arguments:{condition:{kind:'title',equals:'Done'},timeout_ms:3210}});
    assert.equal(result.isError, undefined);
    assert.equal(result.structuredContent.matched, true);
    assert.deepEqual(getWaitCall(), {condition:{kind:'title',equals:'Done'},timeoutMs:3210});
  } finally { await client.close(); await server.close(); }
});

test('browser_click_verified executes exactly one click and returns a verified receipt over MCP', async () => {
  const {server,client,getCounts} = await connected();
  try {
    const result = await client.callTool({name:'browser_click_verified',arguments:{selector_id:'safe-1',condition:{kind:'title',equals:'Done'},timeout_ms:2000}});
    assert.equal(result.isError, undefined);
    assert.equal(result.structuredContent.ok, true);
    assert.equal(result.structuredContent.receipt.status, 'verified');
    assert.equal(result.structuredContent.receipt.route, 'browser.navigate-safe');
    assert.equal(getCounts().click, 1);
    assert.equal(getCounts().wait, 1);
  } finally { await client.close(); await server.close(); }
});

test('browser_fill_verified executes exactly one fill and omits the filled text from its receipt action', async () => {
  const {server,client,getCounts} = await connected();
  try {
    const result = await client.callTool({name:'browser_fill_verified',arguments:{selector_id:'input-1',text:'abc123',timeout_ms:2000}});
    assert.equal(result.isError, undefined);
    assert.equal(result.structuredContent.ok, true);
    assert.equal(result.structuredContent.receipt.action.characters, 6);
    assert.equal(Object.prototype.hasOwnProperty.call(result.structuredContent.receipt.action,'text'), false);
    assert.equal(getCounts().fill, 1);
    assert.equal(getCounts().wait, 1);
  } finally { await client.close(); await server.close(); }
});


test('runtime_identity exposes source, production, candidate, hashes and rollback metadata through one API', async () => {
  const {server,client} = await connected();
  try {
    const result = await client.callTool({name:'runtime_identity',arguments:{}});
    assert.equal(result.isError, undefined);
    assert.equal(result.structuredContent.productionVersion, EXPECTED_PRODUCTION_VERSION);
    assert.equal(result.structuredContent.sourceVersion, EXPECTED_SOURCE_VERSION);
    assert.equal(result.structuredContent.candidateVersion, EXPECTED_CANDIDATE_VERSION);
    assert.equal(result.structuredContent.rollbackVersion, EXPECTED_ROLLBACK_VERSION);
    assert.match(result.structuredContent.runtimePath, /mcp-v06|node|dist|test/i);
    assert.match(result.structuredContent.sourceHash, /^[0-9a-f]{64}$/);
    assert.match(result.structuredContent.deploymentHash, /^[0-9a-f]{64}$/);
  } finally { await client.close(); await server.close(); }
});


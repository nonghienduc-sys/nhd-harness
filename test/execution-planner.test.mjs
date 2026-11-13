import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UnifiedExecutionPlanner } from '../dist/execution-planner.js';
import { WorkstationRouter } from '../dist/router.js';
import { ToolGovernorService } from '../dist/tool-governor.js';

const caps={
  files:{read:true,write:true},
  office:{offlineRead:true,offlineWrite:true,liveRead:true,liveWrite:true,applications:{word:true,excel:true,powerpoint:true,outlook:true},liveWriteApplications:{word:true,excel:true,powerpoint:true,outlook:false}},
  browser:{enabled:true,dom:true,screenshot:true,dedicatedChromium:true,cocCocConnected:true,cocCocTabs:2,isolatedBrowser:true},
  desktop:{enabled:true,uia:true,visual:true},terminal:{enabled:true},intake:{enabled:true},pdf:{enabled:true},
};
const advice={advice:({text})=>({planningMode:'advisory-read-only',createsActivePlan:false,root:null,taskClass:text.includes('MCP')?'mcp_development':'general_workstation',projectProfile:'generic',intentPolicy:{mode:/Word Live/i.test(text)?'execute':'reframe',methodLocked:/Word Live/i.test(text),goalOpen:!/Word Live/i.test(text),explicitConstraints:/Word Live/i.test(text)?['explicit_tool_or_method']:[],reason:'test',behavior:['verify'],verificationRequired:true},directFastLane:true,globalCapabilityAwareness:true,hiddenCapabilities:false,memoryResolver:{bounded:true},recommendedTools:[],qualityFloor:['verify'],avoidUnlessNeeded:[],toolBudget:{kind:'soft',expectedCalls:1,softLimit:3,hardLimit:null},escalationTriggers:[]})};
const lanes={plan:(input,isolated)=>({lane:input.preferred==='isolated'||input.requiresGui||input.domain==='desktop'?'isolated':'background',preferred:input.preferred??'auto',available:(input.preferred==='isolated'||input.requiresGui||input.domain==='desktop')?Boolean(isolated.configured):true,reason:'test lane',hostForegroundAllowed:false,escalation:'none',constraints:[]})};
const isolated={status:()=>({provider:'test',featureAvailable:true,configured:true,online:false})};
const planner=new UnifiedExecutionPlanner({router:new WorkstationRouter(),governor:advice,executionLanes:lanes,isolatedAgent:isolated});

test('Unified ExecutionPlan composes route, lane, risk, QA and Governor while granting no authority',()=>{
  const out=planner.plan({intent:{domain:'files',operation:'read',target:'D:\\x.txt',description:'read file'},capabilities:caps,text:'read file'});
  assert.equal(out.kind,'unified-execution-plan');
  assert.equal(out.executesActions,false); assert.equal(out.grantsAuthorization,false);
  assert.equal(out.route.route,'files.read'); assert.equal(out.lane.lane,'background');
  assert.equal(out.risk.level,'minimal'); assert.equal(out.qa.level,'machine');
  assert.equal(out.governor.createsActivePlan,false);
  assert.equal(out.intentPolicy.mode,'reframe');
  assert.equal(out.safety.authorizationStillEnforcedByActionTool,true);
  assert.equal(out.safety.userMethodConstraintsPreserved,false);
});

test('terminal command risk remains delegated to dynamic risk-policy authority',()=>{
  const out=planner.plan({intent:{domain:'terminal',operation:'execute',description:'delete tree'},capabilities:caps,terminalCommand:'Remove-Item C:\\Temp\\danger -Recurse -Force'});
  assert.equal(out.route.route,'terminal.preview-confirmed');
  assert.equal(out.risk.source,'terminal-dynamic');
  assert.equal(out.risk.level,'critical');
  assert.equal(out.risk.confirmationMode,'critical_phrase');
  assert.equal(out.safety.criticalPhraseStillRequiredWhenRiskIsCritical,true);
});

test('Office adaptive QA is shared with planning without forcing host-GUI execution lane',()=>{
  const out=planner.plan({intent:{domain:'office',operation:'edit',application:'word',live:true,description:'format paragraph spacing'},capabilities:caps,officeOperationType:'word_format'});
  assert.equal(out.route.route,'office.live.write-confirmed');
  assert.equal(out.qa.level,'visual'); assert.equal(out.qa.visualReviewRequired,true);
  assert.equal(out.lane.lane,'background','visual QA alone must not imply host foreground input');
});

test('explicit GUI requirement routes the execution lane to Isolated',()=>{
  const out=planner.plan({intent:{domain:'desktop',operation:'navigate',description:'native dialog'},capabilities:caps,requiresGui:true});
  assert.equal(out.lane.lane,'isolated'); assert.equal(out.lane.available,true);
  assert.equal(out.safety.hostForegroundAllowed,false);
});

test('Governor advice is pure and does not create an active plan or increment plan metrics',()=>{
  const dir=mkdtempSync(join(tmpdir(),'nhd-governor-advice-'));
  const governor=new ToolGovernorService({dataDir:dir,inventoryProvider:()=>[]});
  try {
    const before=governor.status();
    const out=governor.advice({text:'MCP architecture build and test'});
    const after=governor.status();
    assert.equal(out.createsActivePlan,false);
    assert.equal(before.metrics.plans,after.metrics.plans);
    assert.equal(after.activePlans.length,0);
  } finally { governor.close(); rmSync(dir,{recursive:true,force:true}); }
});

test('workstation_plan is wired to UnifiedExecutionPlanner while legacy aliases remain',()=>{
  const source=readFileSync(new URL('../src/mcp-registries/execution-tools.ts',import.meta.url),'utf8');
  assert.match(source,/executionPlanner\.plan\(/);
  assert.match(source,/executionPlan, plan: executionPlan\.route, capabilities/);
  assert.doesNotMatch(source,/return result\(\{ plan: workstationRouter\.plan\(/);
  const mcp=readFileSync(new URL('../src/mcp.ts',import.meta.url),'utf8');
  assert.match(mcp,/new UnifiedExecutionPlanner\(/);
});


test('Unified ExecutionPlan exposes locked Execute intent policy for an explicitly named method',()=>{
  const out=planner.plan({intent:{domain:'office',operation:'edit',application:'word',live:true,description:'Dùng Word Live sửa phần đang chọn'},capabilities:caps,text:'Dùng Word Live sửa phần đang chọn'});
  assert.equal(out.intentPolicy.mode,'execute');
  assert.equal(out.intentPolicy.methodLocked,true);
  assert.equal(out.safety.userMethodConstraintsPreserved,true);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  BACKGROUND_LANE_CAPABILITIES,
  BACKGROUND_LANE_FORBIDDEN,
  capabilitiesFromRuntime,
  capabilityGroup,
  capabilityPermission,
  capabilityIsMutation,
  capabilityLane,
  capabilityRisk,
  capabilityStaticMetadata,
} from '../dist/capability-registry.js';

const registryDir = new URL('../src/mcp-registries/', import.meta.url);
function registeredLiteralNames() {
  const names=[];
  for (const file of readdirSync(registryDir).filter(x=>x.endsWith('.ts'))) {
    const text=readFileSync(new URL(file,registryDir),'utf8');
    for (const match of text.matchAll(/server\.registerTool\("([^"]+)"/g)) names.push(match[1]);
  }
  return [...new Set(names)].sort();
}

test('every literal registered tool receives complete static capability metadata from one registry',()=>{
  const names=registeredLiteralNames();
  assert.ok(names.length>=70,`expected broad tool surface, got ${names.length}`);
  for (const name of names) {
    const meta=capabilityStaticMetadata(name,{});
    assert.ok(meta.group);
    assert.ok(meta.permission);
    assert.ok(['background','isolated','either'].includes(meta.lane));
    assert.ok(['read-only','reversible','mutation','destructive','dynamic'].includes(meta.risk));
    assert.ok(Array.isArray(meta.runtimeRequirements));
  }
});

test('Capability Registry preserves baseline grouping and permissions for representative tools',()=>{
  const cases=[
    ['fs_apply_write','Filesystem','write','background','mutation'],
    ['terminal_execute','Terminal','terminal','background','dynamic'],
    ['office_live_apply_edit','Office','write','either','mutation'],
    ['browser_click','Browser','browser','either','mutation'],
    ['isolated_desktop_action','Isolated Agent','mixed','isolated','mutation'],
    ['context_bootstrap','Context','mixed','background','read-only'],
    ['runtime_identity','Workstation','read','background','read-only'],
  ];
  for (const [name,group,permission,lane,risk] of cases) {
    assert.equal(capabilityGroup(name),group,name);
    assert.equal(capabilityPermission(name),permission,name);
    assert.equal(capabilityLane(name),lane,name);
    assert.equal(capabilityRisk(name,{}),risk,name);
  }
  assert.equal(capabilityIsMutation('project_memory'),true);
  assert.equal(capabilityRisk('fs_apply_delete',{destructiveHint:true}),'destructive');
});

test('runtime capability snapshot output remains backward compatible',()=>{
  const caps=capabilitiesFromRuntime({
    writeEnabled:true,terminalEnabled:true,screenEnabled:true,desktopEnabled:true,browserEnabled:true,visualDesktopEnabled:true,intakeEnabled:true,emergencyStop:false,
    office:{companion:true,word:true,excel:false,powerpoint:true,outlook:true},
    browser:{executable:'edge',cocCocConnected:true,cocCocTabs:3,isolatedBrowser:false},desktop:{companion:true},intake:{availableRoots:2},pdf:{nativeTextExtraction:true},
  });
  assert.deepEqual(caps.files,{read:true,write:true});
  assert.equal(caps.office.liveRead,true);
  assert.equal(caps.office.liveWrite,true);
  assert.equal(caps.office.liveWriteApplications.outlook,false);
  assert.equal(caps.browser.enabled,true);
  assert.equal(caps.browser.cocCocTabs,3);
  assert.equal(caps.desktop.visual,true);
  assert.equal(caps.terminal.enabled,true);
  assert.equal(caps.intake.enabled,true);
  assert.equal(caps.pdf.enabled,true);
});

test('duplicated capability truth is removed from router, mcp, lanes and governor',()=>{
  const mcp=readFileSync(new URL('../src/mcp.ts',import.meta.url),'utf8');
  const router=readFileSync(new URL('../src/router.ts',import.meta.url),'utf8');
  const lanes=readFileSync(new URL('../src/execution-lanes.ts',import.meta.url),'utf8');
  const governor=readFileSync(new URL('../src/tool-governor.ts',import.meta.url),'utf8');
  assert.doesNotMatch(mcp,/function toolGroup\(/);
  assert.doesNotMatch(mcp,/function toolPermission\(/);
  assert.doesNotMatch(mcp,/function effectiveToolState\(/);
  assert.match(mcp,/getWorkstationToolInventory.*capability-registry/);
  assert.doesNotMatch(router,/export type RuntimeCapabilityInput = \{/);
  assert.doesNotMatch(router,/function capabilitiesFromRuntime\(/);
  assert.match(router,/capability-registry/);
  assert.match(lanes,/BACKGROUND_LANE_CAPABILITIES/);
  assert.match(lanes,/BACKGROUND_LANE_FORBIDDEN/);
  assert.doesNotMatch(governor,/function toolIsMutation\(/);
  assert.match(governor,/capabilityIsMutation/);
  assert.deepEqual([...BACKGROUND_LANE_CAPABILITIES],['files','terminal-non-gui','office-direct','coc-coc-dom-background','pdf','ocr','local-ai','project-memory']);
  assert.ok(BACKGROUND_LANE_FORBIDDEN.includes('host-window-activation'));
});

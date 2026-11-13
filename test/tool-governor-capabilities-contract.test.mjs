import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ToolGovernorService } from '../dist/tool-governor.js';

function fixture(){
  const dir=mkdtempSync(join(tmpdir(),'nhd-cap-contract-'));
  const inventory=[
    {name:'browser_inspect',group:'Browser',description:'Inspect browser controls.',enabled:true,status:'enabled',permission:'read',destructive:false},
    {name:'browser_click',group:'Browser',description:'Click browser control.',enabled:true,status:'enabled',permission:'write',destructive:false},
    {name:'office_live_read',group:'Office',description:'Read active Office document.',enabled:true,status:'enabled',permission:'read',destructive:false},
    {name:'office_live_apply_edit',group:'Office',description:'Apply exact previewed Office edit.',enabled:true,status:'enabled',permission:'write',destructive:false},
    {name:'terminal_execute',group:'ExecutionSystem',description:'Execute exact previewed command.',enabled:false,status:'disabled',permission:'execute',destructive:true},
  ];
  const governor=new ToolGovernorService({dataDir:dir,inventoryProvider:()=>inventory});
  return {dir,inventory,governor};
}

const names=(view)=>view.groups.flatMap(group=>group.tools.map(tool=>typeof tool==='string'?tool:tool.name));

test('default capabilities result is deterministic summary with complete name awareness',()=>{
  const {dir,inventory,governor}=fixture();
  try{
    const a=governor.capabilitiesResult();
    const b=governor.capabilitiesResult({detail:'summary'});
    assert.deepEqual(a,b);
    assert.equal(a.architecture,'global-capability-summary');
    assert.equal(a.hiddenCapabilities,false);
    assert.equal(a.totalTools,inventory.length);
    assert.deepEqual([...names(a)].sort(),inventory.map(x=>x.name).sort());
    assert.equal(new Set(names(a)).size,inventory.length);
  }finally{governor.close();rmSync(dir,{recursive:true,force:true})}
});

test('detail=full without filters is deep-equal to legacy capabilities()',()=>{
  const {dir,governor}=fixture();
  try{assert.deepEqual(governor.capabilitiesResult({detail:'full'}),governor.capabilities())}
  finally{governor.close();rmSync(dir,{recursive:true,force:true})}
});

test('group/tool filters return exact subsets without mutating original full objects',()=>{
  const {dir,governor}=fixture();
  try{
    const office=governor.capabilitiesResult({group:'office'});
    assert.equal(office.totalTools,2);assert.deepEqual(names(office),['office_live_read','office_live_apply_edit']);assert.equal(office.catalogTotalTools,5);
    const summaryTool=governor.capabilitiesResult({tool:'office_live_read'});
    assert.deepEqual(names(summaryTool),['office_live_read']);
    const full=governor.capabilities();
    const fullTool=governor.capabilitiesResult({detail:'full',group:'Office',tool:'office_live_read'});
    assert.deepEqual(fullTool.groups[0].tools[0],full.groups.find(g=>g.group==='Office').tools.find(t=>t.name==='office_live_read'));
  }finally{governor.close();rmSync(dir,{recursive:true,force:true})}
});

test('invalid and ambiguous capability parameters fail clearly',()=>{
  const {dir,governor}=fixture();
  try{
    assert.throws(()=>governor.capabilitiesResult({detail:'tiny'}),/summary.*full/);
    assert.throws(()=>governor.capabilitiesResult({group:'Missing'}),/Unknown capability group/);
    assert.throws(()=>governor.capabilitiesResult({tool:'missing_tool'}),/Unknown capability tool/);
    assert.throws(()=>governor.capabilitiesResult({group:'Browser',tool:'office_live_read'}),/does not belong/);
    assert.throws(()=>governor.capabilitiesResult({foo:'bar'}),/Unknown capabilities parameter/);
    assert.throws(()=>governor.capabilitiesResult({group:123}),/non-empty string/);
  }finally{governor.close();rmSync(dir,{recursive:true,force:true})}
});

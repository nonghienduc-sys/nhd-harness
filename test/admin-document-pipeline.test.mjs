import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import JSZip from 'jszip';
import {buildAdminDocumentPlan,executeAdminDocumentPlan,ADMIN_DOCUMENT_PROFILES} from '../dist/admin-document-orchestrator.js';
import {makeFixture,CASES} from '../scripts/generate-admin-docx-fixtures.mjs';
import {inspectAdminDocxBuffer,inspectAdminDocxXml} from './helpers/admin-docx-inspector.mjs';
const root=resolve(fileURLToPath(new URL('..',import.meta.url)));
const registry=JSON.parse(readFileSync(resolve(root,'registry/skill-capabilities.v1.json'),'utf8'));
const clone=v=>JSON.parse(JSON.stringify(v));
const request=(type='cong_van')=>({docType:type,subject:'Nội dung kiểm thử',documentId:'test-only-'+type,sourceReferences:['verified-test-source'],currentDocumentVersion:'v1'});
function makeAdapter(overrides={}){
 const activations=[],execution=[],authorizations=[];
 const adapter={
  activateSkill:async(id,purpose)=>{activations.push(id);if(overrides.activationThrows===id)throw Error('activation unavailable');return {id,enabled:true,purpose};},
  authorizeWrite:async(step)=>{authorizations.push(step.phase);return overrides.safety??{approved:true,leaseValid:true,versionBound:true};},
  executeStep:async(step)=>{
   execution.push(step.phase);
   if(overrides.throwOn===step.phase)throw Error('backend unavailable');
   const e=(()=>{
    switch(step.phase){
     case 'intake':return {intakeRecorded:true};
     case 'legal_resolve':return {legalVerified:true,resolvedSpecId:'resolved-spec-test',sourceProvenance:['verified-test-source'],templateVerified:true};
     case 'draft':return {draftHash:'content-sha256-demo',contentSourcesBound:true};
     case 'template':return {docxPath:'D:/test-only.docx',templateId:'template-test',normalizedTextHash:'same-text-hash'};
     case 'format':return {preEditTextHash:'same-text-hash',postEditTextHash:'same-text-hash',versionMatched:true,readBackCompleted:true};
     case 'structural_qa':return {mandatoryErrors:0,contentUnchanged:true,qaReportId:'independent-qa'};
     case 'visual_qa':return {visuallyReviewed:true,layoutErrors:0,renderReceiptId:'pdf-render'};
     default:throw Error('Unexpected stage');
    }
   })();
   Object.assign(e,overrides.evidence?.[step.phase]??{});
   return {phase:step.phase,ok:true,evidence:e};
  }
 };
 return {adapter,activations,execution,authorizations};
}
test('Step 2 registry tracks observed inventory; legacy disabled; reproducible',()=>{
 assert.equal(registry.schemaVersion,1);
 assert.equal(registry.inventory.registeredSkillCount,54);
 assert.equal(registry.inventory.physicalFolderCount,55);
 assert.equal(registry.inventory.enabledSkillCount,53);
 assert.equal(registry.skills.length,55);
 assert.equal(registry.skills.filter(s=>s.registration==='nhd_skill_catalog').length,54);
 assert.equal(new Set(registry.skills.map(s=>s.id)).size,55);
 assert.equal(registry.skills.find(s=>s.id==='skill-chinh-sua-format-van-ban').enabled,false);
 assert.equal(registry.skills.find(s=>s.id==='viet-admin-format-checker').enabled,true);
 assert.equal(registry.skills.find(s=>s.id==='github-tools-pack').type,'resource_pack');
 execFileSync(process.execPath,[resolve(root,'scripts/build-admin-skill-registry.mjs'),'--check'],{cwd:root,stdio:'pipe'});
});
test('all six types have unique semantics and no automatic sign/issue tool',()=>{
 assert.equal(CASES.length,6);
 assert.deepEqual(CASES.map(c=>c.id),['cong_van','bao_cao','ke_hoach','to_trinh','quyet_dinh','thong_bao']);
 for(const c of CASES){
  const plan=buildAdminDocumentPlan(request(c.id),registry);
  assert.equal(plan.profile.heading,ADMIN_DOCUMENT_PROFILES[c.id].heading);
  assert.equal(plan.stages.length,8);
  assert.equal(plan.canonicalFormatter,'viet-admin-format-checker');
  assert.ok(plan.stages.flatMap(s=>s.skillIds).includes('viet-admin-format-checker'));
  assert.ok(!plan.stages.flatMap(s=>s.skillIds).includes('skill-chinh-sua-format-van-ban'));
  assert.deepEqual(plan.stages.map(s=>s.phase),['intake','legal_resolve','draft','template','format','structural_qa','visual_qa','human_review']);
  assert.equal(plan.stages.at(-1).manualOnly,true);
  assert.ok(plan.pendingHumanActions.includes('sign_and_seal_or_sign_digitally_in_official_system'));
  assert.ok(!plan.stages.flatMap(s=>s.toolAdapters).some(t=>/send|sign|issue|submit/.test(t)));
 }
});
for(const c of CASES){
 test('DOCX structural fixture: '+c.id,async()=>{
  const bytes=await makeFixture(c);
  assert.ok(bytes.length>3000);
  const info=await inspectAdminDocxBuffer(bytes,c);
  assert.deepEqual(info.errors,[],c.id+': '+JSON.stringify(info.errors));
  assert.equal(info.ok,true);
  assert.ok(info.textRunCount>=12);
  assert.ok(info.visibleText.includes(c.subject));
  assert.ok(info.visibleText.includes('[CHỜ VĂN THƯ CẤP]'));
  const onDisk=resolve(root,'test-artifacts/admin-regression',c.file);
  assert.equal(existsSync(onDisk),true,'fixture exists on disk');
  const diskInfo=await inspectAdminDocxBuffer(readFileSync(onDisk),c);
  assert.equal(diskInfo.ok,true);
 });
 test('Mock NHD orchestrator succeeds and stops before signing: '+c.id,async()=>{
  const plan=buildAdminDocumentPlan(request(c.id),registry);
  const r=makeAdapter();
  const out=await executeAdminDocumentPlan(plan,r.adapter);
  assert.equal(out.status,'awaiting_human_approval');
  assert.equal(out.completed.length,7);
  assert.deepEqual(r.authorizations,['template','format','visual_qa']);
  assert.equal(r.activations.filter(id=>id==='viet-admin-format-checker').length,2);
  assert.ok(!r.activations.includes('skill-chinh-sua-format-van-ban'));
  assert.ok(!r.execution.includes('human_review'));
 });
}
test('DOCX independent checker rejects noncompliant margin, font, missing component',async()=>{
 const c=CASES[0],buf=await makeFixture(c);
 const zip=await JSZip.loadAsync(buf),xml=await zip.file('word/document.xml').async('string');
 assert.ok(inspectAdminDocxXml(xml.replace('w:left="1701"','w:left="200"'),c).errors.includes('left-margin-out-of-range'));
 assert.ok(inspectAdminDocxXml(xml.replace('w:ascii="Times New Roman"','w:ascii="Arial"'),c).errors.includes('run-font-not-Times-New-Roman'));
 assert.ok(inspectAdminDocxXml(xml.replace('CỘNG HÒA XÃ HỘI CHỦ NGHĨA VIỆT NAM','KHÔNG CÓ QUỐC HIỆU'),c).errors.some(s=>s.startsWith('missing-marker:')));
 assert.ok(inspectAdminDocxXml(xml.replace('Kính gửi:','KHÔNG GỬI'),c).errors.some(s=>s.includes('Kính gửi:')));
});
test('legacy activation cannot be planned even if registry configuration is tampered',()=>{
 const r=clone(registry);
 r.skills.find(x=>x.id==='skill-chinh-sua-format-van-ban').enabled=true;
 assert.throws(()=>buildAdminDocumentPlan(request(),r),/Legacy formatter still enabled/);
});
test('canonical disabled is blocked before any agent writes',()=>{
 const r=clone(registry);
 r.skills.find(x=>x.id==='viet-admin-format-checker').enabled=false;
 assert.throws(()=>buildAdminDocumentPlan(request(),r),/Required skill missing or disabled/);
});
test('unsupported document type is refused',()=>{
 assert.throws(()=>buildAdminDocumentPlan({...request(),docType:'van_ban_dang'},registry),/Unsupported/);
});
test('legal basis unresolved => block at legal_resolve, no write',async()=>{
 const r=makeAdapter({evidence:{legal_resolve:{legalVerified:false}}});
 const out=await executeAdminDocumentPlan(buildAdminDocumentPlan(request(),registry),r.adapter);
 assert.equal(out.status,'blocked');
 assert.equal(out.blockedAt,'legal_resolve');
 assert.deepEqual(r.authorizations,[]);
});
test('mandatory specialized template missing => block at legal_resolve',async()=>{
 const r=makeAdapter();
 const out=await executeAdminDocumentPlan(buildAdminDocumentPlan({...request(),requiresSpecializedTemplate:true},registry),r.adapter);
 assert.equal(out.status,'blocked');
 assert.equal(out.blockedAt,'legal_resolve');
});
test('Safety denial => block before template write, no fallback',async()=>{
 const r=makeAdapter({safety:{approved:false,leaseValid:false,versionBound:false}});
 const out=await executeAdminDocumentPlan(buildAdminDocumentPlan(request(),registry),r.adapter);
 assert.equal(out.status,'blocked');
 assert.equal(out.blockedAt,'template');
 assert.deepEqual(r.execution,['intake','legal_resolve','draft']);
 assert.equal(r.authorizations.length,1);
});
test('format changing body text fails closed',async()=>{
 const r=makeAdapter({evidence:{format:{postEditTextHash:'modified'}}});
 const out=await executeAdminDocumentPlan(buildAdminDocumentPlan(request(),registry),r.adapter);
 assert.equal(out.status,'blocked');
 assert.equal(out.blockedAt,'format');
 assert.match(out.reason,/modified text/);
});
test('structural mandatory error fails closed',async()=>{
 const r=makeAdapter({evidence:{structural_qa:{mandatoryErrors:1}}});
 const out=await executeAdminDocumentPlan(buildAdminDocumentPlan(request(),registry),r.adapter);
 assert.equal(out.status,'blocked');
 assert.equal(out.blockedAt,'structural_qa');
});
test('visual QA missing fails closed',async()=>{
 const r=makeAdapter({evidence:{visual_qa:{visuallyReviewed:false,layoutErrors:2}}});
 const out=await executeAdminDocumentPlan(buildAdminDocumentPlan(request(),registry),r.adapter);
 assert.equal(out.status,'blocked');
 assert.equal(out.blockedAt,'visual_qa');
});
test('unavailable backend is not automatically retried',async()=>{
 const r=makeAdapter({throwOn:'format'});
 const out=await executeAdminDocumentPlan(buildAdminDocumentPlan(request(),registry),r.adapter);
 assert.equal(out.status,'blocked');
 assert.equal(out.blockedAt,'format');
 assert.equal(r.execution.filter(x=>x==='format').length,1);
});
test('skill activation failure denies step without mutation',async()=>{
 const r=makeAdapter({activationThrows:'viet-admin-docx-template-builder'});
 const out=await executeAdminDocumentPlan(buildAdminDocumentPlan(request(),registry),r.adapter);
 assert.equal(out.status,'blocked');
 assert.equal(out.blockedAt,'template');
 assert.deepEqual(r.authorizations,[]);
});
test('missing receipt evidence stops advancement',async()=>{
 const r=makeAdapter({evidence:{legal_resolve:{resolvedSpecId:null}}});
 const out=await executeAdminDocumentPlan(buildAdminDocumentPlan(request(),registry),r.adapter);
 assert.equal(out.status,'blocked');
 assert.equal(out.blockedAt,'legal_resolve');
});

test('missing expected version blocks all writes',async()=>{
 const q=request();delete q.currentDocumentVersion;
 const r=makeAdapter();
 const out=await executeAdminDocumentPlan(buildAdminDocumentPlan(q,registry),r.adapter);
 assert.equal(out.status,'blocked');
 assert.equal(out.blockedAt,'template');
 assert.deepEqual(r.authorizations,[]);
});
test('tampered plan invoking legacy skill is refused',async()=>{
 const plan=buildAdminDocumentPlan(request(),registry);
 plan.stages.find(s=>s.phase==='format').skillIds=['skill-chinh-sua-format-van-ban'];
 const r=makeAdapter();
 const out=await executeAdminDocumentPlan(plan,r.adapter);
 assert.equal(out.status,'blocked');
 assert.equal(out.blockedAt,'format');
 assert.ok(!r.activations.includes('skill-chinh-sua-format-van-ban'));
});
test('cross-stage template/format text hash mismatch blocks',async()=>{
 const r=makeAdapter({evidence:{template:{normalizedTextHash:'different'}}});
 const out=await executeAdminDocumentPlan(buildAdminDocumentPlan(request(),registry),r.adapter);
 assert.equal(out.status,'blocked');
 assert.equal(out.blockedAt,'format');
 assert.match(out.reason,/Template-to-format/);
});

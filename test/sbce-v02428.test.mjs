// 0.24.28: baseline safety criteria reach both the writer and the cross-family judge (job-73984ad8…, 2026-11-13).
import test from 'node:test';import assert from 'node:assert/strict';
import{mkdtempSync,rmSync}from'node:fs';import{join}from'node:path';import{tmpdir}from'node:os';
import{SbceStore}from'../dist/sbce-store.js';import{validateWorkOrder}from'../dist/sbce-core.js';
import{runSbceShadow,SBCE_SAFETY_BASELINE}from'../dist/sbce-runner.js';
const m=(id,family,roles)=>({id,model:'p-'+id,provider:'hhtech',protocol:'openai',family,tier:'T1',roles,enabled:true,vndPerM:400,minVndPerCall:0,dataLabels:['internal','public/code']});
const models=[m('writer-a','fam-a',['writer']),m('judge-b','fam-b',['judge'])];
const order=()=>validateWorkOrder({title:'Backup checklist',kind:'doc_write',goal:'Write a short weekly backup checklist',deliverables:['a.md'],acceptance:[{type:'rubric',text:'Exactly 5 checkboxes'}]},'shadow');
const unsafe='# Checklist\n\n- [ ] Xuất mật khẩu đã lưu của trình duyệt ra file CSV trên USB để dự phòng.';
const safe='# Checklist\n\n- [ ] Sao chép thư mục Tài liệu sang ổ ngoài đã mã hóa BitLocker vào chiều thứ Sáu.';
test('baseline safety criteria cover plaintext credentials and disabling protections',()=>{
 assert.match(SBCE_SAFETY_BASELINE,/passwords/);assert.match(SBCE_SAFETY_BASELINE,/plaintext/);
 assert.match(SBCE_SAFETY_BASELINE,/disabling security controls/);
});
test('writer system and judge prompt carry safety criteria; judge rejection loops back with feedback',async()=>{
 const base=mkdtempSync(join(tmpdir(),'sbce-v28-')),store=new SbceStore(join(base,'db.sqlite'));
 const calls=[];
 const gen={generate:async({model,system,prompt})=>{
  calls.push({id:model.id,system,prompt});
  if(model.id==='judge-b'){
   const bad=/mật khẩu/.test(prompt);
   return {text:JSON.stringify({pass:!bad,reason:bad?'Violates safety: plaintext password export':'ok'}),usage:{input:50,output:10,cached:0},model:model.model,protocol:'openai'};
  }
  const n=calls.filter(c=>c.id==='writer-a').length;
  return {text:n===1?unsafe:safe,usage:{input:100,output:60,cached:0},model:model.model,protocol:'openai'};
 }};
 try{
  const job=store.submit(order(),'owner');
  const r=await runSbceShadow({store,jobId:job.id,models,generator:gen,artifactRoot:join(base,'a'),mode:'shadow'});
  assert.equal(r.status,'ready_for_review');
  assert.deepEqual(calls.map(c=>c.id),['writer-a','judge-b','writer-a','judge-b']);
  assert.match(calls[0].system,/Follow these safety rules/);
  assert.match(calls[0].system,/plaintext/);
  assert.match(calls[1].prompt,/SAFETY CRITERIA \(always apply; any violation means pass=false\)/);
  assert.match(calls[2].prompt,/Violates safety/,'judge reason is fed back to the writer');
 }finally{store.close();rmSync(base,{recursive:true,force:true});}
});

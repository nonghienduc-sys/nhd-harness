import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AdminDocxReleaseGate, validateAdminReleaseProof } from "../dist/admin-docx-release-gate.js";
const validHash="a".repeat(64);
const proof=(overrides={})=>({
  schemaVersion:1,id:"a".repeat(24),candidatePath:"x.docx",pdfPath:"x.pdf",
  docxSha256:validHash,pdfSha256:"b".repeat(64),
  classification:"cooperative_admin_style",formatterSkill:"viet-admin-format-checker",
  structural:{sha256:validHash,structuralPass:true},
  geometry:{status:"PASS",errors:[],docPages:2},
  pages:[{page:1,pngPath:"1.png",sha256:"c".repeat(64)},{page:2,pngPath:"2.png",sha256:"d".repeat(64)}],
  viewedPages:[1,2],
  review:{verdict:"pass",reviewedPages:[1,2],reviewer:"QA",notes:"Reviewed",at:new Date().toISOString()},
  preparedAt:new Date().toISOString(),...overrides
});
test("release proof only passes with verified canonical skill, structure, geometry and ALL pages",()=>{
 assert.equal(validateAdminReleaseProof(proof()).pass,true);
 for(const change of [
  {review:null},{review:{...proof().review,reviewedPages:[1]}},
  {formatterSkill:"word-professional"},
  {structural:{structuralPass:false,sha256:validHash}},
  {structural:{structuralPass:true,sha256:"9".repeat(64)}},
  {geometry:{status:"FAIL",errors:["line-offset"],docPages:2}},
  {geometry:{status:"PASS",errors:[],docPages:3}},
  {pages:[{page:1,pngPath:"1.png",sha256:"c".repeat(64)}]},
  {pdfSha256:"not-a-hash"},
  {viewedPages:[1]},
 ]){
  const result=validateAdminReleaseProof(proof(change));
  assert.equal(result.pass,false,JSON.stringify(change));
  assert.ok(result.errors.length>0);
 }
});
test("missing review receipt always blocks publication preview",()=>{
 const dir=mkdtempSync(join(tmpdir(),"nhd-admin-gate-"));
 try{
  const gate=new AdminDocxReleaseGate(dir);
  assert.throws(()=>gate.previewPublish("c".repeat(24),join(dir,"release.docx")),/missing review receipt/);
  assert.throws(()=>gate.status("../../other"),/invalid review id/);
 } finally{rmSync(dir,{recursive:true,force:true});}
});
test("unsigned or edited local review metadata cannot be used for release",()=>{
 const dir=mkdtempSync(join(tmpdir(),"nhd-admin-gate-hmac-"));
 try{
  const gate=new AdminDocxReleaseGate(dir),id="1".repeat(24);
  mkdirSync(join(dir,id));
  writeFileSync(join(dir,id,"review.json"),JSON.stringify({receipt:proof({id}),signature:"0".repeat(64)}));
  assert.throws(()=>gate.status(id),/review receipt integrity mismatch/);
  assert.throws(()=>gate.previewPublish(id,join(dir,"release.docx")),/review receipt integrity mismatch/);
 } finally{rmSync(dir,{recursive:true,force:true});}
});
test("short or incomplete page review is rejected even if structural audit passed",()=>{
 const r=proof({review:{...proof().review,verdict:"fail",reviewedPages:[1]}});
 assert.equal(validateAdminReleaseProof(r).pass,false);
});
test("publish preview survives a fresh gate instance (stateless HTTP transport) and is single-use",async()=>{
 const { createHash } = await import("node:crypto");
 const { existsSync, readFileSync, readdirSync } = await import("node:fs");
 const dir=mkdtempSync(join(tmpdir(),"nhd-admin-gate-persist-"));
 try{
  const sha=p=>createHash("sha256").update(readFileSync(p)).digest("hex");
  const docx=join(dir,"cand.docx"),pdf=join(dir,"cand.pdf"),png=join(dir,"p1.png");
  writeFileSync(docx,"docx-bytes");writeFileSync(pdf,"pdf-bytes");writeFileSync(png,"png-bytes");
  const id="2".repeat(24),d=sha(docx);
  const r=proof({id,candidatePath:docx,pdfPath:pdf,docxSha256:d,pdfSha256:sha(pdf),
    structural:{sha256:d,structuralPass:true},geometry:{status:"PASS",errors:[],docPages:1},
    pages:[{page:1,pngPath:png,sha256:sha(png)}],viewedPages:[1],
    review:{verdict:"pass",reviewedPages:[1],reviewer:"QA",notes:"ok",at:new Date().toISOString()}});
  new AdminDocxReleaseGate(dir).save(r);
  const out=join(dir,"out","release.docx");
  const prev=new AdminDocxReleaseGate(dir).previewPublish(id,out);
  // A second instance must not be able to replay the consumed preview.
  const prev2=new AdminDocxReleaseGate(dir);
  const res=new AdminDocxReleaseGate(dir).applyPublish(prev.actionId,prev.confirmationToken);
  assert.equal(res.outputSha256,d);
  assert.ok(existsSync(out));
  assert.throws(()=>prev2.applyPublish(prev.actionId,prev.confirmationToken),/preview missing or already consumed/);
  assert.equal(new AdminDocxReleaseGate(dir).status(id).status,"published");
  assert.deepEqual(readdirSync(join(dir,".pending-publish")),[]);
 } finally{rmSync(dir,{recursive:true,force:true});}
});
test("tampered or forged pending publish previews are rejected",()=>{
 const dir=mkdtempSync(join(tmpdir(),"nhd-admin-gate-forge-"));
 try{
  const gate=new AdminDocxReleaseGate(dir),aid="3".repeat(24);
  writeFileSync(join(dir,".pending-publish",aid+".json"),JSON.stringify({pending:{reviewId:"4".repeat(24),target:join(dir,"x.docx"),docSha:validHash,tokenHash:validHash,expiry:Date.now()+60000},signature:"0".repeat(64)}));
  assert.throws(()=>gate.applyPublish(aid,"t"),/pending preview integrity mismatch/);
  assert.throws(()=>gate.applyPublish(aid,"t"),/preview missing or already consumed/);
  assert.throws(()=>gate.applyPublish("../../evil","t"),/preview missing or already consumed/);
 } finally{rmSync(dir,{recursive:true,force:true});}
});

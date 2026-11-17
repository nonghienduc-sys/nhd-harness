import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Document, Paragraph, Packer } from "docx";
import { WordLiveSessionPool } from "../dist/word-live-sessions.js";
test("single real isolated Word smoke", {skip:process.env.NHD_WORD_LIVE_REAL!=="1"||process.platform!=="win32",timeout:30000},async()=>{
 const root=mkdtempSync(join(tmpdir(),"nhd-word-smoke-"));
 const p=join(root,"smoke.docx");
 writeFileSync(p,await Packer.toBuffer(new Document({sections:[{children:[new Paragraph("Start")]}]})));
 const pool=new WordLiveSessionPool({maxInstances:1,registryPath:join(root,"registry.json")});
 try {
  const x=await pool.request("word_inspect",{path:p},{target:{scope:"document"},contextChars:0});
  assert(x.open); console.log("SINGLE_REAL_PID="+x.pid);
  const y=await pool.request("word_apply",{path:p},{operation:{type:"word_replace_paragraph",paragraph:1,text:"Success"}});
  assert(y.verified);
  const z=await pool.request("word_apply",{path:p},{operation:{type:"word_save"}});
  assert(z.verified);
  await pool.close(p);
 } finally { await pool.closeAll();rmSync(root,{recursive:true,force:true});}
});

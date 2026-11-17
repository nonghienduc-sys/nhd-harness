import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { spawn, execFileSync } from "node:child_process";
import JSZip from "jszip";
import { Document, Paragraph, Packer } from "docx";
import { WordLiveSessionPool, wordLockCandidates } from "../dist/word-live-sessions.js";

function wordPids() {
  const cmd = '@(Get-Process -Name WINWORD -ErrorAction SilentlyContinue | ForEach-Object {[int]$_.Id}) | ConvertTo-Json -Compress';
  const raw = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", cmd], {encoding:"utf8", timeout:10000}).trim();
  const result = JSON.parse(raw || "[]");
  return new Set((Array.isArray(result) ? result : [result]).filter(Number.isInteger));
}
const sleep = ms => new Promise(r=>setTimeout(r,ms));
async function waitForPids(expected, ms=12000) {
  const until = Date.now()+ms;
  while(Date.now()<until) {
    const actual = wordPids();
    if ([...actual].every(pid=>expected.has(pid))) return actual;
    await sleep(200);
  }
  return wordPids();
}
async function makeDoc(file, text) {
  writeFileSync(file, await Packer.toBuffer(new Document({sections:[{children:[new Paragraph(text)]}]})));
}
async function documentText(path) {
  const zip = await JSZip.loadAsync(readFileSync(path));
  return await zip.file("word/document.xml").async("string");
}
function lockExclusively(path) {
  const quoted = path.replace(/'/g,"''");
  const script = "$f=[IO.File]::Open('"+quoted+"',[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None);[Console]::WriteLine('LOCKED');[Console]::Out.Flush();Start-Sleep -Seconds 25;$f.Dispose()";
  return new Promise((resolve,reject)=>{
    const child = spawn("powershell.exe", ["-NoProfile","-NonInteractive","-Command",script],{windowsHide:true,stdio:["ignore","pipe","pipe"]});
    let out="";
    const timer=setTimeout(()=>{child.kill();reject(new Error("Failed to acquire exclusive test lock"));},5000);
    child.stdout.on("data", chunk=>{out+=chunk.toString();if(out.includes("LOCKED")){clearTimeout(timer);resolve(child);}});
    child.once("exit",code=>{if(!out.includes("LOCKED")){clearTimeout(timer);reject(new Error("Lock holder exited "+code));}});
  });
}
test("WORDLIVE_REAL: four independent Word processes, file-locks and timeout cleanup", {skip:process.env.NHD_WORD_LIVE_REAL!=="1" || process.platform!=="win32", timeout:180000}, async()=>{
  const before=wordPids();
  const folder=mkdtempSync(join(tmpdir(),"nhd-word-live-real-"));
  const pool=new WordLiveSessionPool({maxInstances:4,idleMs:90000,registryPath:join(folder,"sessions.json")});
  const paths=[0,1,2,3].map(i=>join(folder,"parallel-"+i+".docx"));
  let holder;
  try {
    await Promise.all(paths.map((p,i)=>makeDoc(p,"Before "+i)));
    const spans=[];
    await Promise.all(paths.map(async (path,i)=>{
      const start=Date.now();
      const inspected=await pool.request("word_inspect",{path},{target:{scope:"document"},contextChars:0});
      assert.equal(inspected.open,true);
      spans[i]={start,end:Date.now()};
    }));
    assert.equal(pool.list().length,4,"four simultaneous sessions retained");
    assert.equal(new Set(pool.list().map(s=>s.pid)).size,4,"four independent WINWORD PID");
    assert(pool.list().every(s=>!before.has(s.pid)),"no reused user Word PID");
    const intersection=Math.min(...spans.map(s=>s.end))-Math.max(...spans.map(s=>s.start));
    assert(intersection>0,"all four sessions must overlap in time");
    const duration=Math.max(...spans.map(s=>s.end))-Math.min(...spans.map(s=>s.start));
    const serial=spans.reduce((sum,s)=>sum+(s.end-s.start),0);
    assert(duration<serial,"parallel wall time less than sequential durations");
    await Promise.all(paths.map(async(path,i)=>{
      const opts={path};
      const replace=await pool.request("word_apply",opts,{operation:{type:"word_replace_paragraph",paragraph:1,text:"Parallel result "+i}});
      assert.equal(replace.verified,true);
      const format=await pool.request("word_apply",opts,{operation:{type:"word_format_paragraphs",startParagraph:1,format:{fontName:"Arial",fontSize:12,alignment:"justify"}}});
      assert.equal(format.verified,true);
      const saved=await pool.request("word_apply",opts,{operation:{type:"word_save"}});
      assert.equal(saved.verified,true);
    }));
    await Promise.all(paths.map(path=>pool.close(path)));
    for (let i=0;i<paths.length;i++) {
      const xml=await documentText(paths[i]);
      assert(xml.includes("Parallel result "+i),"saved DOCX contains its own unique edit");
      assert(!wordLockCandidates(paths[i]).some(existsSync),"no leftover owner file");
    }
    const lockedPath=join(folder,"locked.docx");
    await makeDoc(lockedPath,"Locked");
    const lock=wordLockCandidates(lockedPath)[0];
    writeFileSync(lock,Buffer.from("Test lock owner","utf16le"));
    holder=await lockExclusively(lockedPath);
    const started=Date.now();
    await assert.rejects(pool.request("word_inspect",{path:lockedPath},{target:{scope:"document"}}),/WORD_LIVE_FILE_IN_USE/);
    assert(Date.now()-started<10000,"locked document fails in <10 seconds");
    holder.kill(); holder=undefined;
    await sleep(350);
    const stale=await pool.request("word_inspect",{path:lockedPath,read_only:true},{target:{scope:"document"}});
    assert.equal(stale.stale_lock,true,"stale Word owner file reported");
    await assert.rejects(pool.request("word_apply",{path:lockedPath,read_only:true},{operation:{type:"word_save"}}),/WORD_LIVE_READ_ONLY/);
    await pool.close(lockedPath);
    const hungPath=join(folder,"timeout.docx");
    await makeDoc(hungPath,"Hung");
    await assert.rejects(pool.request("test_timeout",{path:hungPath,timeout_ms:1000}),/WORD_LIVE_OPERATION_TIMEOUT/);
    await sleep(2000);
    await pool.closeAll();
    const after=await waitForPids(before);
    const leaked=[...after].filter(pid=>!before.has(pid));
    assert.deepEqual(leaked,[],"all generated Word processes cleaned up");
    const alive=[...before].filter(pid=>after.has(pid)).length;
    assert.equal(alive,before.size,"all pre-existing user Word processes survived");
    console.log("WORDLIVE_REAL: PASS parallel=4 leaked=0 user_pids_alive="+alive+"/"+before.size);
  } finally {
    if(holder) holder.kill();
    await pool.closeAll();
    // The temp folder is only removed after all owned processes are fully closed.
    rmSync(folder,{recursive:true,force:true});
  }
});

import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, execFileSync } from "node:child_process";
import JSZip from "jszip";
import { Document, Paragraph, Packer } from "docx";
import { WordLiveSessionPool, wordLockCandidates } from "../dist/word-live-sessions.js";

const tracked = { pools: new Set(), owned: new Map(), holder: null, folder: null, watchdog: null };
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function bounded(promise, ms, label) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, rej) => {
      timer = setTimeout(() => rej(new Error(label)), ms);
    })]);
  } finally { clearTimeout(timer); }
}
function wordPids() {
  const cmd = '@(Get-Process -Name WINWORD -ErrorAction SilentlyContinue | ForEach-Object {[int]$_.Id}) | ConvertTo-Json -Compress';
  const raw = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", cmd],
    {encoding:"utf8", timeout:8000}).trim();
  const data = JSON.parse(raw || "[]");
  return new Set((Array.isArray(data) ? data : [data]).filter(Number.isInteger));
}
function visibleWordPids() {
  const ps = '@(Get-Process -Name WINWORD -ErrorAction SilentlyContinue | Where-Object {$_.MainWindowTitle} | ForEach-Object {[int]$_.Id}) | ConvertTo-Json -Compress';
  const raw = execFileSync("powershell.exe", ["-NoProfile","-NonInteractive","-Command",ps],
    {encoding:"utf8",timeout:8000}).trim();
  const data=JSON.parse(raw || "[]");
  return new Set((Array.isArray(data) ? data : [data]).filter(Number.isInteger));
}
function noteOwned(pool) {
  for (const s of pool.list()) tracked.owned.set(s.pid,s.started);
}
async function waitForPids(expected, ms=12000) {
  const deadline = Date.now()+ms;
  while (Date.now()<deadline) {
    const current = wordPids();
    if ([...current].every(pid => expected.has(pid))) return current;
    await sleep(200);
  }
  return wordPids();
}
async function makeDoc(path, content) {
  writeFileSync(path, await Packer.toBuffer(new Document({
    sections:[{children:[new Paragraph(content)]}]
  })));
}
async function xmlText(path) {
  const zip = await JSZip.loadAsync(readFileSync(path));
  return await zip.file("word/document.xml").async("string");
}
async function cleanupAll() {
  if (tracked.holder) { try { tracked.holder.kill(); } catch {} tracked.holder=null; }
  await bounded(Promise.allSettled([...tracked.pools].map(pool => pool.closeAll())), 25000, "WORDLIVE_TEST_CLEANUP_TIMEOUT");
  if (tracked.folder) { rmSync(tracked.folder, {recursive:true,force:true});tracked.folder=null; }
}
after(async () => {
  // Keep the independent OS-level watchdog alive until cleanup actually succeeds.
  await cleanupAll();
  if (tracked.watchdog) { clearTimeout(tracked.watchdog);tracked.watchdog=null; }
});
async function waitForRegistry(path, ms=25000) {
  const limit = Date.now()+ms;
  while (Date.now()<limit) {
    try {
      const entries = JSON.parse(readFileSync(path, "utf8"));
      const entry = entries.find(e => e?.workerPid>0 && e?.pid>0 && e?.started);
      if (entry) return entry;
    } catch {}
    await sleep(100);
  }
  throw new Error("WORDLIVE_TEST_EARLY_OWNERSHIP_RECEIPT_TIMEOUT");
}
function lockExclusively(path) {
  const q = path.replace(/'/g, "''");
  const script = "$f=[IO.File]::Open('"+q+"',[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None);[Console]::WriteLine('LOCKED');[Console]::Out.Flush();Start-Sleep -Seconds 25;$f.Dispose()";
  return new Promise((res, rej) => {
    const child = spawn("powershell.exe", ["-NoProfile","-NonInteractive","-Command",script],
      {windowsHide:true,stdio:["ignore","pipe","pipe"]});
    let settled=false;
    const timer=setTimeout(() => {
      if (settled) return;
      settled=true;child.kill();rej(new Error("WORDLIVE_TEST_EXCLUSIVE_LOCK_TIMEOUT"));
    },5000);
    child.stdout.on("data", chunk => {
      if (settled || !chunk.toString().includes("LOCKED")) return;
      settled=true;clearTimeout(timer);res(child);
    });
    child.once("exit",code => {
      if (settled) return;
      settled=true;clearTimeout(timer);rej(new Error("Lock holder exited: "+code));
    });
  });
}

test("WORDLIVE_REAL: 4 independent DOCX sessions, hard timeouts, crash inside named mutex", {
  skip: process.env.NHD_WORD_LIVE_REAL!=="1" || process.platform!=="win32",
  timeout: 160000,
}, async () => {
  const before=wordPids();
  tracked.folder=mkdtempSync(join(tmpdir(),"nhd-word-live-real-"));
  const folder=tracked.folder;
  const pool=new WordLiveSessionPool({maxInstances:4,idleMs:90000,registryPath:join(folder,"sessions.json")});
  tracked.pools.add(pool);
  // node:test timeout alone does NOT terminate external PowerShell/Office handles.
  // Fail closed at the OS process level, only after cleaning harness-owned sessions.
  tracked.watchdog=setTimeout(() => {
    void (async()=>{
      process.stderr.write("WORDLIVE_REAL_HARD_TIMEOUT: test exceeded 145 seconds\n");
      try { await bounded(cleanupAll(),12000,"WORDLIVE_TEST_WATCHDOG_CLEANUP_TIMEOUT"); }
      catch (e) { process.stderr.write(String(e)+"\n"); }
      process.exit(2);
    })();
  },145000);
  const paths=[0,1,2,3].map(i=>join(folder,"parallel-"+i+".docx"));
  try {
    await Promise.all(paths.map((p,i)=>makeDoc(p,"Before "+i)));
    const spans=[];
    await bounded(Promise.all(paths.map(async (path,i)=>{
      const start=Date.now();
      const inspected=await pool.request("word_inspect",{path},{target:{scope:"document"},contextChars:0});
      assert.equal(inspected.open,true);
      spans[i]={start,end:Date.now()};
    })),85000,"WORDLIVE_TEST_FOUR_STARTUP_TIMEOUT");
    console.log("WORDLIVE_STAGE: opened_four");
    assert.equal(pool.list().length,4);
    assert.equal(new Set(pool.list().map(s=>s.pid)).size,4);
    assert(pool.list().every(s=>!before.has(s.pid)),"no re-used user WINWORD PID");
    assert(Math.min(...spans.map(s=>s.end))>Math.max(...spans.map(s=>s.start)),"all four Word sessions overlap");
    assert(Math.max(...spans.map(s=>s.end))-Math.min(...spans.map(s=>s.start))
      <spans.reduce((sum,s)=>sum+s.end-s.start,0),"parallel wall-time is less than sequential sum");
    await bounded(Promise.all(paths.map(async(path,i)=>{
      const opts={path,timeout_ms:15000};
      const replaced=await pool.request("word_apply",opts,
        {operation:{type:"word_replace_paragraph",paragraph:1,text:"Parallel result "+i}});
      assert.equal(replaced.verified,true);
      const formatted=await pool.request("word_apply",opts,
        {operation:{type:"word_format_paragraphs",startParagraph:1,format:{fontName:"Arial",fontSize:12,alignment:"justify"}}});
      assert.equal(formatted.verified,true);
      const saved=await pool.request("word_apply",{path,timeout_ms:45000},{operation:{type:"word_save"}});
      assert.equal(saved.verified,true);
    })),45000,"WORDLIVE_TEST_PARALLEL_EDIT_TIMEOUT");
    console.log("WORDLIVE_STAGE: edited_four");
    await bounded(Promise.all(paths.map(p=>pool.close(p))),18000,"WORDLIVE_TEST_CLOSE_TIMEOUT");
    for (let i=0;i<paths.length;i++) {
      assert((await xmlText(paths[i])).includes("Parallel result "+i),"saved DOCX differs correctly");
      assert(!wordLockCandidates(paths[i]).some(existsSync),"owner files removed");
    }
    const locked=join(folder,"locked.docx");
    await makeDoc(locked,"Locked");
    writeFileSync(wordLockCandidates(locked)[0],Buffer.from("Test owner","utf16le"));
    tracked.holder=await lockExclusively(locked);
    const at=Date.now();
    await assert.rejects(bounded(pool.request("word_inspect",{path:locked}),9000,"FILE_IN_USE_TIMEOUT"),
      /WORD_LIVE_FILE_IN_USE/);
    assert(Date.now()-at<10000,"locked DOCX fails quickly without a dialog");
    tracked.holder.kill();tracked.holder=null;
    await sleep(500);
    const stale=await pool.request("word_inspect",{path:locked,read_only:true},
      {target:{scope:"document"}});
    assert.equal(stale.stale_lock,true);
    await assert.rejects(pool.request("word_apply",{path:locked,read_only:true},
      {operation:{type:"word_save"}}),/WORD_LIVE_READ_ONLY/);
    noteOwned(pool);

    const timeoutPath=join(folder,"timeout.docx");
    await makeDoc(timeoutPath,"Timeout");
    const timedRequest=pool.request("test_timeout",{path:timeoutPath,timeout_ms:1000});
    timedRequest.catch(()=>{});
    const timedOwner=await waitForRegistry(pool.registryPath,12000);
    tracked.owned.set(timedOwner.pid,timedOwner.started);
    await assert.rejects(bounded(timedRequest,8000,"TIMEOUT_TEST_HUNG"),/WORD_LIVE_OPERATION_TIMEOUT/);
    await sleep(1000);

    // Critical regression: kill a real session worker WHILE it owns the kernel
    // activation mutex and after it has already emitted WINWORD PID + StartTime.
    const crashPath=join(folder,"crash-while-holding-mutex.docx");
    const recoveredPath=join(folder,"recover-after-abandoned-mutex.docx");
    await makeDoc(crashPath,"Crash");
    await makeDoc(recoveredPath,"Recover");
    const crashPool=new WordLiveSessionPool({
      maxInstances:1,registryPath:join(folder,"crash-sessions.json"),
      workerEnv:{NHD_WORD_LIVE_TEST_HOLD_MUTEX_AFTER_CREATE:"1"},
    });
    tracked.pools.add(crashPool);
    const crashRequest=crashPool.request("word_inspect",{path:crashPath});
    crashRequest.catch(()=>{}); // prevent unhandled rejection before we await it
    const owner=await waitForRegistry(crashPool.registryPath,25000);
    assert(owner.workerPid!==process.pid && owner.workerPid>0);
    assert(!before.has(owner.pid),"only test-created WINWORD may be affected");
    await sleep(250); // ensure the worker is still inside the 35-second mutex hold
    process.kill(owner.workerPid);
    await assert.rejects(bounded(crashRequest,18000,"CRASH_WORKER_NOT_DETECTED"),
      /WORD_LIVE_WORKER_EXIT|WORD_LIVE_SESSION_CLOSED|WORD_LIVE_START_TIMEOUT/);
    await bounded(crashPool.closeAll(),16000,"CRASH_POOL_CLEANUP_TIMEOUT");
    const recovered=await bounded(pool.request("word_inspect",{path:recoveredPath},
      {target:{scope:"document"}}),25000,"ABANDONED_MUTEX_NOT_RECOVERED");
    assert.equal(recovered.open,true);
    // If the dead worker held the last kernel handle, Windows can destroy the mutex; successful acquisition is the invariant.
    assert.equal(typeof recovered.abandoned_mutex_recovered,"boolean");
    await pool.close(recoveredPath);
    await pool.closeAll();

    const afterPids=await waitForPids(before,12000);
    const leaked=[...tracked.owned.keys()].filter(pid=>afterPids.has(pid));
    assert.deepEqual(leaked,[],"no harness-owned WINWORD survives crash or timeout");
    // On a shared workstation, other users may open real Word during this test.
    // Do not kill them or misclassify their visible windows as harness leaks.
    const unexpected=[...afterPids].filter(pid=>!before.has(pid)&&!tracked.owned.has(pid));
    const visible=visibleWordPids();
    assert.deepEqual(unexpected.filter(pid=>!visible.has(pid)),[],
      "no untracked hidden WINWORD (possible automation leak) appeared");
    const concurrentUserWindows=unexpected.length;
    const alive=[...before].filter(pid=>afterPids.has(pid)).length;
    assert.equal(alive,before.size,"pre-existing WINWORD processes all survived");
    console.log("WORDLIVE_REAL: PASS parallel=4 leaked=0 user_pids_alive="+alive+"/"+before.size+" concurrent_user_windows="+concurrentUserWindows);
  } finally {
    // If cleanup fails, leave the watchdog armed to force an exit <3 minutes.
    await bounded(cleanupAll(),30000,"WORDLIVE_TEST_FINALLY_CLEANUP_TIMEOUT");
  }
});

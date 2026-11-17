import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { readFileSync } from "node:fs";
import { WordLiveSessionPool, keyForWordPath, normalizeWordPath, hasPotentialWordLock, wordLockCandidates, verifiedOrphans } from "../dist/word-live-sessions.js";

test("canonical path key treats case-insensitive references as same session", ()=>{
  const dir=mkdtempSync(join(tmpdir(),"nhd-word-key-"));
  try {
    const p=join(dir,"Original.docx");writeFileSync(p,"dummy");
    assert.equal(keyForWordPath(p),keyForWordPath(p.toUpperCase()));
    assert.equal(normalizeWordPath(p),resolve(p));
    assert.throws(()=>normalizeWordPath(join(dir,"no-file.docx")),/WORD_LIVE_INVALID_PATH/);
  } finally {rmSync(dir,{recursive:true,force:true});}
});
test("stale lock candidates detectable without modifying user owner files",()=>{
  const dir=mkdtempSync(join(tmpdir(),"nhd-word-lock-"));
  try {
    const p=join(dir,"abc.docx");writeFileSync(p,"dummy");
    assert.equal(hasPotentialWordLock(p),false);
    const [lock]=wordLockCandidates(p);writeFileSync(lock,"stale");
    assert.equal(hasPotentialWordLock(p),true);
  } finally {rmSync(dir,{recursive:true,force:true});}
});
test("orphan selector requires registry, WINWORD image, matching start-time, and dead owner",()=>{
  const rows=[{pid:101,started:"t1",ownerPid:501},{pid:102,started:"t2",ownerPid:502},{pid:103,started:"t3",ownerPid:503}];
  const live=[{pid:101,name:"WINWORD",started:"t1"},{pid:102,name:"WINWORD",started:"changed"},{pid:103,name:"chrome",started:"t3"},{pid:104,name:"WINWORD",started:"t4"}];
  assert.deepEqual(verifiedOrphans(rows,live,new Set()),[rows[0]]);
  assert.deepEqual(verifiedOrphans(rows,live,new Set([501])),[]);
});
test("legacy Word Live no-path routing is preserved",()=>{
  const companion=readFileSync(new URL("../src/office-companion.ts",import.meta.url),"utf8");
  const bridge=readFileSync(new URL("../office/office-bridge.ps1",import.meta.url),"utf8");
  assert.match(companion,/typeof input.path === "string" && input.path/);
  assert.match(companion,/bridgeWorker.request\(action, input\)/);
  assert.match(bridge,/GetActiveObject\('Word.Application'\)/);
  const worker=readFileSync(new URL("../office/word-session-worker.ps1",import.meta.url),"utf8");
  assert.doesNotMatch(worker,/GetActiveObject/);
});
test("a DOCX already open in the user's Word list is rejected before creating any new worker",async()=>{
  const folder=mkdtempSync(join(tmpdir(),"nhd-word-user-open-"));
  const p=join(folder,"user-open.docx");writeFileSync(p,"test");
  let inspected=0;
  const pool=new WordLiveSessionPool({
    registryPath:join(folder,"registry.json"),
    externalWordDocuments:async()=>{inspected++;return [p];},
    workerPath:resolve("test","word-live-mock-worker.ps1")
  });
  try {
    await assert.rejects(pool.request("word_inspect",{path:p}),/WORD_LIVE_FILE_IN_USE/);
    assert.equal(pool.list().length,0);
    assert.equal(inspected,1);
  } finally {await pool.closeAll();rmSync(folder,{recursive:true,force:true});}
});
test("mock workers: same path queues, max pool returns WORD_LIVE_POOL_BUSY, PID registry", {skip:process.platform!=="win32",timeout:25000},async()=>{
  const folder=mkdtempSync(join(tmpdir(),"nhd-word-pool-"));
  const old=process.env.NHD_WORD_LIVE_POOL_WAIT_MS;
  process.env.NHD_WORD_LIVE_POOL_WAIT_MS="250";
  const p1=join(folder,"first.docx"),p2=join(folder,"second.docx");
  writeFileSync(p1,"test");writeFileSync(p2,"test");
  const pool=new WordLiveSessionPool({
    maxInstances:1,idleMs:60000,
    registryPath:join(folder,"registry.json"),
    workerPath:resolve("test","word-live-mock-worker.ps1")
  });
  try {
    const results=await Promise.all([pool.request("word_inspect",{path:p1}),pool.request("word_inspect",{path:p1})]);
    assert.equal(results.length,2);
    assert.equal(pool.list().length,1);
    assert.equal(pool.list()[0].workerPid>0,true);
    const registry=JSON.parse(readFileSync(join(folder,"registry.json"),"utf8"));
    assert.equal(registry[0].pid,888888);
    await assert.rejects(pool.request("word_inspect",{path:p2}),/WORD_LIVE_POOL_BUSY/);
    await pool.close(p1);
    const next=await pool.request("word_inspect",{path:p2});
    assert.equal(next.open,true);
  } finally {
    await pool.closeAll();
    if(old===undefined) delete process.env.NHD_WORD_LIVE_POOL_WAIT_MS;
    else process.env.NHD_WORD_LIVE_POOL_WAIT_MS=old;
    rmSync(folder,{recursive:true,force:true});
  }
});

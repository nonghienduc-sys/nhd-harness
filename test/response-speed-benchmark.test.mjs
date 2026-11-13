import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ResponseSpeedStore } from "../src/response-speed-benchmark.ts";

function makeSample(id, extra={}) {
  return {
    sampleId:id,measuredAtUtc:"2026-11-08T03:00:00.000Z",
    modelLabel:"GPT-6 High (manual)",workloadLabel:"TOEIC",
    timingOrigin:"submit_event",completionSignal:"ui_complete",quality:"observed",
    visibilityState:"visible",visibleChars:800,wordCount:135,
    observedDecodeMs:4000,timeToFirstVisibleMs:1200,totalVisibleElapsedMs:5200,
    sampleCount:14, responseText:"SECRET RESPONSE MUST NEVER PERSIST",
    promptText:"PRIVATE USER PROMPT", ...extra
  };
}
test("speed samples save only numeric metadata and derive speed from characters",()=>{
  const dir=mkdtempSync(join(tmpdir(),"nhd-ui-speed-"));
  try{
    const store=new ResponseSpeedStore(dir);
    const r=store.save(makeSample("sample-one-111"));
    assert.equal(r.saved,true);
    assert.equal(r.summary.samples,1);
    assert.equal(r.summary.medianEstimatedTokensPerSecond,50);
    assert.equal(r.summary.medianFirstVisibleMs,1200);
    const csv=readFileSync(store.csvPath,"utf8");
    const jsonl=readFileSync(store.jsonlPath,"utf8");
    assert.ok(existsSync(store.csvPath));
    assert.match(csv,/GPT-6 High/);
    assert.doesNotMatch(csv,/SECRET RESPONSE|PRIVATE USER/);
    assert.doesNotMatch(jsonl,/SECRET RESPONSE|PRIVATE USER/);
    assert.equal(JSON.parse(jsonl.trim()).estimatedOutputTokens,200);
    assert.equal(JSON.parse(jsonl.trim()).estimatedTokensPerSecond,50);
    assert.equal(store.save(makeSample("sample-one-111")).duplicate,true);
    assert.equal(store.summary().samples,1);
    // Service restart must not duplicate or lose the canonical JSONL history.
    const restored=new ResponseSpeedStore(dir);
    assert.equal(restored.summary().samples,1);
    assert.equal(restored.recent(1)[0].wordCount,135);
  }finally{rmSync(dir,{recursive:true,force:true});}
});
test("speed summary excludes unmeasurable single-chunk outputs from rate denominator",()=>{
  const dir=mkdtempSync(join(tmpdir(),"nhd-ui-speed-"));
  try {
    const store=new ResponseSpeedStore(dir);
    store.save(makeSample("single-chunk-222",{visibleChars:100,observedDecodeMs:0,sampleCount:1,timeToFirstVisibleMs:null,quality:"low_confidence"}));
    assert.equal(store.summary().samples,1);
    assert.equal(store.summary().validSpeedSamples,0);
    assert.equal(store.summary().medianEstimatedTokensPerSecond,null);
  }finally{rmSync(dir,{recursive:true,force:true});}
});
test("rejects invalid speed inputs without appending files",()=>{
  const dir=mkdtempSync(join(tmpdir(),"nhd-ui-speed-"));
  try {
    const store=new ResponseSpeedStore(dir);
    assert.throws(()=>store.save(makeSample("sample-bad-333",{visibleChars:-1})),/Invalid numeric/);
    assert.throws(()=>store.save(makeSample("sample-bad-334",{measuredAtUtc:"bogus"})),/Invalid sample timestamp/);
    assert.equal(store.summary().samples,0);
    assert.equal(existsSync(store.jsonlPath),false);
  }finally{rmSync(dir,{recursive:true,force:true});}
});

import test from "node:test";import assert from "node:assert/strict";
import {mkdtempSync} from "node:fs";import {tmpdir} from "node:os";import {join} from "node:path";
import {inspectSbcePatch} from "../dist/sbce-patch-gate.js";
import {parsedJudge} from "../dist/sbce-runner.js";
import {buildContextPack,CONTEXT_BUDGET} from "../dist/sbce-context.js";
import {parseFileRef} from "../dist/mcp-registries/delegation-tools.js";
import {SbceStore} from "../dist/sbce-store.js";
import {validateWorkOrder} from "../dist/sbce-core.js";

const gitDiff=["diff --git a/src/foo.ts b/src/foo.ts","index 1234abc..5678def 100644","--- a/src/foo.ts","+++ b/src/foo.ts","@@ -1,2 +1,2 @@"," const a = 1;","-const b = 2;","+const b = 3;",""].join("\n");
const newFile=["diff --git a/src/new.ts b/src/new.ts","new file mode 100644","index 0000000..e69de29","--- /dev/null","+++ b/src/new.ts","@@ -0,0 +1 @@","+export const x = 1;",""].join("\n");

test("patch gate accepts standard git diff headers and regular new files",()=>{
 assert.deepEqual(inspectSbcePatch(gitDiff,"code_change").violations,[]);
 assert.deepEqual(inspectSbcePatch(newFile,"code_change").violations,[]);
 const newTest=newFile.replaceAll("src/new.ts","test/new.test.mjs");
 assert.equal(inspectSbcePatch(newTest,"test_write").ok,true);
});
test("patch gate still denies deletes, renames, mode changes, executables and stray /dev/null",()=>{
 assert.equal(inspectSbcePatch(gitDiff.replace("index 1234abc..5678def 100644","deleted file mode 100644"),"code_change").ok,false);
 assert.equal(inspectSbcePatch(gitDiff.replace("index 1234abc..5678def 100644","old mode 100644\nnew mode 100755"),"code_change").ok,false);
 assert.equal(inspectSbcePatch(newFile.replace("new file mode 100644","new file mode 100755"),"code_change").ok,false);
 assert.equal(inspectSbcePatch(gitDiff.replace("index 1234abc..5678def 100644","similarity index 90%\nrename from src/a.ts\nrename to src/foo.ts"),"code_change").ok,false);
 // /dev/null only allowed after "new file mode"
 assert.equal(inspectSbcePatch(gitDiff.replace("--- a/src/foo.ts","--- /dev/null").replace("index 1234abc..5678def 100644\n",""),"code_change").ok,false);
 // index line inside a hunk is content and must start with ' ', '+' or '-'
 assert.equal(inspectSbcePatch(gitDiff+"index 1234abc..5678def\n","code_change").ok,false);
 assert.equal(inspectSbcePatch(newFile.replaceAll("src/new.ts","src/terminal.ts"),"code_change").ok,false);
});

test("judge parser accepts bare and fenced JSON but fails closed on prose",()=>{
 assert.deepEqual(parsedJudge('{"pass":true,"reason":"ok"}'),{pass:true,reason:"ok"});
 assert.deepEqual(parsedJudge('```json\n{"pass":true,"reason":"ok"}\n```'),{pass:true,reason:"ok"});
 assert.deepEqual(parsedJudge('```\n{"pass":false,"reason":"missing"}\n```'),{pass:false,reason:"missing"});
 assert.equal(parsedJudge('Looks fine. {"pass":true,"reason":"ok"}').reason,"SBCE_JUDGE_UNSTRUCTURED");
 assert.equal(parsedJudge('```json\n{"pass":"yes"}\n```').pass,false);
});

test("file refs support line ranges and are capped at 300 lines",()=>{
 assert.deepEqual(parseFileRef("file:src/a.ts"),{path:"src/a.ts",start:1,end:200});
 assert.deepEqual(parseFileRef("file:src/a.ts#L120-260"),{path:"src/a.ts",start:120,end:260});
 assert.deepEqual(parseFileRef("file:src/a.ts:120-260"),{path:"src/a.ts",start:120,end:260});
 assert.deepEqual(parseFileRef("file:src/a.ts#L50"),{path:"src/a.ts",start:50,end:249});
 assert.deepEqual(parseFileRef("file:src/a.ts:1-5000"),{path:"src/a.ts",start:1,end:300});
 assert.equal(parseFileRef("file:src/a.ts:300-100"),null);
});
test("code context budget fits whole functions; text budget unchanged",()=>{
 const big="x".repeat(7000);
 const code=buildContextPack([{source:"src/a.ts",locator:"src/a.ts:1-200",snippet:big},{source:"src/b.ts",locator:"src/b.ts:1-200",snippet:big}],CONTEXT_BUDGET.code.total,CONTEXT_BUDGET.code.perSnippet);
 assert.equal(code.chars,14000);
 const text=buildContextPack([{source:"a",locator:"a:1",snippet:big}]);
 assert.equal(text.chars,2400);
});

test("daily budget releases reservation of stopped jobs and counts actual spend",()=>{
 const dir=mkdtempSync(join(tmpdir(),"sbce-fix-"));const store=new SbceStore(join(dir,"jobs.sqlite"));
 const order=(n)=>validateWorkOrder({title:"Patch feature "+n,kind:"code_change",goal:"Implement safe feature "+n+" with tests",deliverables:["patch"],acceptance:[{type:"schema"}]},"shadow");
 try{
  const job=store.submit(order("one"),"owner");
  assert.equal(store.budget().usedVnd,20000);
  store.setStatus(job.id,"running");
  const call=store.reserveCall(job.id,"model-a",3000);
  store.settleCall(call.callId,1200);
  store.putReview(job.id,{jobId:job.id,state:"needs_brain",summary:"stopped",checks:[{name:"L0",ok:false}],costVnd:1200,tokensIn:1,tokensOut:1});
  assert.equal(store.budget().usedVnd,1200);
  for(let i=0;i<20;i++){const j=store.submit(order("n"+i),"owner");store.putReview(j.id,{jobId:j.id,state:"needs_brain",summary:"no model",checks:[{name:"L0",ok:false}],costVnd:0,tokensIn:0,tokensOut:0});}
  assert.equal(store.budget().usedVnd,1200);
 }finally{store.close();}
});

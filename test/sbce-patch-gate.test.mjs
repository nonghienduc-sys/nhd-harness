import test from "node:test";import assert from "node:assert/strict";
import {inspectSbcePatch} from "../dist/sbce-patch-gate.js";
const patch=file=>["diff --git a/"+file+" b/"+file,"--- a/"+file,"+++ b/"+file,"@@ -1 +1 @@","-old","+new",""].join("\n");
test("allowed source patch reports static-only and never pretends code execution",()=>{
 const p=inspectSbcePatch(patch("src/feature.ts"),"code_change");
 assert.equal(p.ok,true);assert.deepEqual(p.files,["src/feature.ts"]);assert.equal(p.staticOnly,true);
});
test("locked, protected, malicious and test-tamper diffs fail closed",()=>{
 for(const path of ["test/core.test.mjs","scripts/atomic-release.mjs","runtime/release-state.json","../../pwn.ts","C:/Windows/system.ts","src/.env","src/terminal.ts","src/bad.exe"]){
  const result=inspectSbcePatch(patch(path),"code_change");
  assert.equal(result.ok,false,path);
 }
 assert.equal(inspectSbcePatch(patch("src/feature.ts"),"code_change",["src"]).ok,false);
 assert.equal(inspectSbcePatch(patch("src/feature.ts"),"code_change",["src/feature.ts"]).ok,false);
 assert.equal(inspectSbcePatch(patch("test/core.test.mjs"),"test_write").ok,true);
 assert.equal(inspectSbcePatch(patch("src/feature.ts"),"test_write").ok,false);
 const tamper=patch("test/feature.test.mjs").replace("+new","+test.skip('anything',()=>{})");
 assert.equal(inspectSbcePatch(tamper,"test_write").ok,false);
});
test("binary, rename and invalid patch line are denied",()=>{
 assert.equal(inspectSbcePatch("diff --git a/src/a.ts b/src/b.ts\n--- a/src/a.ts\n+++ b/src/b.ts\n@@ -1 +1 @@\n-a\n+b","code_change").ok,false);
 assert.equal(inspectSbcePatch("diff --git a/src/a.ts b/src/a.ts\nnew file mode 100644\n","code_change").ok,false);
 assert.equal(inspectSbcePatch(patch("src/a.ts")+"\nGIT binary patch","code_change").ok,false);
 assert.equal(inspectSbcePatch("","code_change").ok,false);
});

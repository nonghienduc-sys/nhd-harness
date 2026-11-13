import test from "node:test";import assert from "node:assert/strict";import{inspectSbcePatch}from"../dist/sbce-patch-gate.js";
test("patch header without hunks cannot pass L0 integrity",()=>{
 assert.equal(inspectSbcePatch("diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n","code_change").ok,false);
});
test("protected auth/core modules cannot be changed by cheap model",()=>{
 for(const file of ["src/security.ts","src/server.ts","src/mcp.ts","src/sbce-patch-gate.ts","src/config.ts"]){
  const patch=["diff --git a/"+file+" b/"+file,"--- a/"+file,"+++ b/"+file,"@@ -1 +1 @@","-x","+y"].join("\n");
  assert.equal(inspectSbcePatch(patch,"code_change").ok,false,file);
 }
});

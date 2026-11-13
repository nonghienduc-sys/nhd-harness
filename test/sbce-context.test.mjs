import test from "node:test";import assert from "node:assert/strict";
import {buildContextPack,packToPrompt,classifyPack} from "../dist/sbce-context.js";
test("context packaging is bounded, source-located, ignores secret evidence",()=>{
 const c=buildContextPack([
 {locator:"src/a.ts:1",source:"a",snippet:"export const a = 1",label:"public/code"},
 {locator:"src/b.ts:9",source:"b",snippet:"x".repeat(20000),label:"internal"},
 {locator:"src/private.ts:10",source:"p",snippet:"Authorization: Bearer abcdefghijklmnopqrstuvwxyz"},
 ],700);
 assert.ok(c.chars<=700);
 assert.equal(c.untrusted,true);
 assert.equal(c.evidence.length,2);
 assert.equal(c.omitted,1);
 assert.equal(classifyPack(c.evidence),"internal");
 assert.match(packToPrompt(c),/UNTRUSTED/);
 assert.match(packToPrompt(c),/src\/a.ts:1/);
 assert.ok(!packToPrompt(c).includes("abcdefghijklmnopqrstuvwxyz"));
});
test("empty references never invent citations",()=>{const p=buildContextPack([]);assert.equal(p.evidence.length,0);assert.equal(packToPrompt(p),"");});

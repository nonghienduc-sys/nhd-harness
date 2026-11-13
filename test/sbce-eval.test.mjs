import test from "node:test";import assert from "node:assert/strict";
import {evaluateGoldenSet} from "../dist/sbce-eval.js";
const tasks=[{id:"C1",kind:"code_change"},{id:"D1",kind:"doc_write"}];
const record=(id,changes={})=>({id,source:"trusted_runtime",status:"accepted",l0:{pass:true,isolated:true,machineReceipt:"local-receipt.json"},l1:{pass:true,crossFamily:true},brainApproved:true,estimatedCostVnd:50,inputTokens:100,outputTokens:20,latencyMs:1000,...changes});
test("full set cannot claim pass while missing evidence",()=>{
 const r=evaluateGoldenSet(tasks,[]);assert.equal(r.missing,2);assert.equal(r.verifiedPass,0);assert.equal(r.status,"incomplete_evidence");
});
test("code cannot pass based on model self-report or unisolated L0",()=>{
 let r=evaluateGoldenSet(tasks,[record("C1",{source:"imported_external"}),record("D1")]);
 assert.equal(r.verifiedPass,1);assert.equal(r.rows[0].result,"not_verified");
 r=evaluateGoldenSet(tasks,[record("C1",{l0:{pass:true,isolated:false,machineReceipt:"fake"}}),record("D1")]);
 assert.equal(r.verifiedPass,1);
 r=evaluateGoldenSet(tasks,[record("C1",{brainApproved:false}),record("D1")]);assert.equal(r.verifiedPass,1);
});
test("complete trusted receipts are counted without claiming savings",()=>{
 const r=evaluateGoldenSet(tasks,[record("C1"),record("D1")]);
 assert.equal(r.verifiedPass,2);assert.equal(r.status,"fully_verified");assert.equal(r.cannotClaimSavingsWithoutBaseline,true);
});

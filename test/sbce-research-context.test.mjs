import test from "node:test";import assert from "node:assert/strict";
import {mkdtempSync,rmSync} from "node:fs";import {join} from "node:path";import {tmpdir} from "node:os";
import {buildContextPack} from "../dist/sbce-context.js";
import {SbceStore} from "../dist/sbce-store.js";
import {validateWorkOrder} from "../dist/sbce-core.js";
import {runSbceShadow} from "../dist/sbce-runner.js";
const models=[
 {id:"researcher",model:"fake-researcher",provider:"hhtech",protocol:"openai",family:"a",tier:"T1",roles:["researcher"],enabled:true,vndPerM:350,dataLabels:["internal"]},
 {id:"judge",model:"fake-judge",provider:"hhtech",protocol:"openai",family:"b",tier:"T1",roles:["judge"],enabled:true,vndPerM:400,dataLabels:["internal"]}
];
const work=(pack)=>validateWorkOrder({title:"Cited research",kind:"research",goal:"Provide a short answer with grounded citations for safe research",deliverables:["research.md"],acceptance:[{type:"rubric",text:"Cite source"}],...(pack?{context_pack:pack}:{})},"shadow");
const run=async(pack,generator)=>{
 const dir=mkdtempSync(join(tmpdir(),"sbce-research-")),db=new SbceStore(join(dir,"jobs.sqlite"));
 try{const job=db.submit(work(pack),"brain");const state=await runSbceShadow({store:db,jobId:job.id,models,generator,artifactRoot:join(dir,"artifacts"),mode:"shadow"});return state;}
 finally{db.close();rmSync(dir,{recursive:true,force:true});}
};
test("research without RAG evidence stops before paid API call",async()=>{
 let called=0;
 const state=await run(null,{generate(){called++;throw Error("must not call");}});
 assert.equal(state.status,"needs_brain");assert.equal(state.spentVnd,0);assert.equal(called,0);
});
test("citation checks and cross-family judge required for research",async()=>{
 const bounded=buildContextPack([{locator:"docs/source.md#section=2",source:"docs/source.md",snippet:"Example data are fictional but grounded to this test.",label:"internal"}]);
 const pack={evidence:bounded.evidence,sha256:bounded.sha256,untrusted:true};
 const provider={generate:async ({model})=>({text:model.id==="judge"?'{"pass":true,"reason":"cited"}':"The example source states that these are fictional reference facts. [EVIDENCE 1] This is the grounded conclusion.",usage:{input:90,output:40,cached:0},model:model.model,protocol:model.protocol})};
 const state=await run(pack,provider);
 assert.equal(state.status,"ready_for_review");assert.equal(state.review.checks.length,3);
});
test("uncited research draft cannot pass despite agreeing L1",async()=>{
 const bounded=buildContextPack([{locator:"docs/source.md#chunk=1",source:"docs/source.md",snippet:"A test-only data point.",label:"internal"}]);
 const pack={evidence:bounded.evidence,sha256:bounded.sha256,untrusted:true};
 const provider={generate:async ({model})=>({text:model.id==="judge"?'{"pass":true,"reason":"looks fine"}':"Uncited output that makes a statement with no source references and fails deterministic checks.",usage:{input:30,output:30,cached:0},model:model.model,protocol:model.protocol})};
 const state=await run(pack,provider);
 assert.equal(state.status,"needs_brain");
});

import test from "node:test";import assert from "node:assert/strict";
import {SbceCircuit} from "../dist/sbce-circuit.js";
import {HhtechProvider} from "../dist/sbce-provider.js";
const model={id:"test-model",model:"demo-model",provider:"hhtech",protocol:"openai",family:"demo",tier:"T1",roles:["writer"],enabled:true,vndPerM:500};
test("circuit opens on third transient failure and recovers after five minutes",()=>{
 let at=0;const circuit=new SbceCircuit(()=>at);
 circuit.failure(503);circuit.failure(429);assert.equal(circuit.state.open,false);
 circuit.failure("timeout");assert.equal(circuit.state.open,true);
 assert.throws(()=>circuit.beforeRequest(),/CIRCUIT_OPEN/);
 at+=5*60*1000+1;circuit.beforeRequest();circuit.success();assert.equal(circuit.state.open,false);
});
test("live adapter sends no fourth request while open",async()=>{
 let calls=0;const key="demo-not-a-real-key-123",provider=new HhtechProvider(()=>key,async()=>{
  calls++;return new Response("provider unavailable",{status:503});
 });
 for(let i=0;i<3;i++)await assert.rejects(provider.generate({model,system:"Writer",prompt:"Draft a test sentence",maxTokens:80}),/SBCE_PROVIDER_HTTP_503/);
 await assert.rejects(provider.generate({model,system:"Writer",prompt:"Draft a test sentence",maxTokens:80}),/SBCE_PROVIDER_CIRCUIT_OPEN/);
 assert.equal(calls,3);
});

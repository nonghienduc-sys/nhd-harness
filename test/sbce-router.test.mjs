import test from 'node:test';import assert from 'node:assert/strict';
import {routeSbceModel} from '../dist/sbce-router.js';
import {makeFailureSignature} from '../dist/sbce-failure-library.js';
const base=(id,price)=>({id,provider:'hhtech',protocol:'openai',model:'provider-'+id,family:id,tier:'T1',roles:['coder'],enabled:true,vndPerM:price,dataLabels:['public/code']});
const args={models:[base('cheap',350),base('new',500)],role:'coder',tier:'T1',label:'public/code',taskClass:'code_change',risk:'low'};
test('cold start uses lowest verified cost and never explores high risk',()=>{
 const a=routeSbceModel({...args,stats:[],rng:()=>0});
 assert.equal(a.model.id,'cheap');assert.equal(a.exploratory,false);
 const b=routeSbceModel({...args,stats:[{taskClass:'code_change',modelId:'cheap',accepted:20,rejected:0}],risk:'high',rng:()=>0});
 assert.equal(b.exploratory,false);
});
test('verified sampling respects exploration at most 10 percent and never unapproved models',()=>{
 const stats=[{taskClass:'code_change',modelId:'cheap',accepted:30,rejected:1}];
 const explored=routeSbceModel({...args,stats,rng:()=>0.05});
 assert.equal(explored.exploratory,true);
 assert.equal(explored.model.id,'new');
 const normal=routeSbceModel({...args,stats,rng:()=>0.9});
 assert.equal(normal.exploratory,false);
 const blocked=routeSbceModel({...args,models:args.models.map(m=>({...m,enabled:false})),stats,rng:()=>0});
 assert.equal(blocked,null);
});
test('failure signature ignores direct file path and normalization is stable',()=>{
 const a=makeFailureSignature('code_change','EXEC_TEST_TAMPER','D:\\private\\data\\a.ts line 123 broken');
 const b=makeFailureSignature('code_change','EXEC_TEST_TAMPER','D:\\another\\path\\b.ts line 456 broken');
 assert.equal(a.code,'EXEC_TEST_TAMPER');assert.equal(a.fingerprint,b.fingerprint);
});

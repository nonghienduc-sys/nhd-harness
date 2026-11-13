import test from 'node:test';import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import{workOrderSchema,validateWorkOrder}from'../dist/sbce-core.js';
const set=JSON.parse(readFileSync(new URL('../benchmarks/sbce-golden-set-v1.json',import.meta.url),'utf8'));
test('Golden Set has 40 sanitized real-workflow contracts and no invented performance baseline',()=>{
 assert.equal(set.schemaVersion,1);
 assert.equal(set.tasks.length,40);
 assert.equal(set.status.includes('no model performance baseline'),true);
 const ids=new Set();let code=0;
 for(const job of set.tasks){
  assert.ok(!ids.has(job.id));ids.add(job.id);
  const {id,...order}=job;
  const accepted=validateWorkOrder(order,'shadow');
  assert.equal(accepted.budget.vnd,20000);
  assert.ok(accepted.acceptance.length>0);
  if(['code_change','test_write'].includes(job.kind))code++;
 }
 assert.ok(code>=20);
});

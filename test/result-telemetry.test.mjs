import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ResultTelemetryService } from '../dist/result-telemetry.js';

test('result telemetry measures serialized chars without storing raw result content',()=>{
  const telemetry=new ResultTelemetryService({maxEntries:16,countCap:100000});
  const secret='DO_NOT_STORE_THIS_SECRET_ABC123';
  const result={structuredContent:{ok:true,secret},content:[{type:'text',text:secret}]};
  const before=JSON.stringify(result);
  const entry=telemetry.observe('sample_tool',result,1.23456);
  assert.equal(entry.resultChars,JSON.stringify(result).length);
  assert.equal(JSON.stringify(result),before);
  const status=telemetry.status();
  const serialized=JSON.stringify(status);
  assert.doesNotMatch(serialized,new RegExp(secret));
  assert.equal(status.storesRawResults,false);
  assert.equal(status.modifiesResults,false);
  assert.equal(status.calls,1);
});

test('telemetry thresholds, p50/p95, top payloads and flags are deterministic',()=>{
  const telemetry=new ResultTelemetryService({maxEntries:32,countCap:100000});
  telemetry.observe('small',{text:'x'.repeat(100)},2);
  telemetry.observe('large',{text:'x'.repeat(9000),next_cursor:'abc'},4);
  telemetry.observe('very_large',{text:'x'.repeat(18000),truncated:true},8);
  const status=telemetry.status();
  assert.equal(status.calls,3);
  assert.equal(status.largeResults,1);
  assert.equal(status.veryLargeResults,1);
  assert.equal(status.paginatedResults,1);
  assert.equal(status.truncatedResults,1);
  assert.equal(status.topPayloads[0].toolName,'very_large');
  assert.ok(status.p95ResultChars>=status.p50ResultChars);
  assert.ok(status.p95ElapsedMs>=status.p50ElapsedMs);
});

test('telemetry ring is bounded and count cap marks oversized results',()=>{
  const telemetry=new ResultTelemetryService({maxEntries:16,countCap:16000});
  for(let i=0;i<24;i++) telemetry.observe(`tool_${i}`,{text:'x'.repeat(i===23?50000:100+i)},i);
  const status=telemetry.status();
  assert.equal(status.calls,16);
  assert.equal(status.recent[0].toolName,'tool_23');
  assert.ok(status.cappedMeasurements>=1);
  assert.equal(status.topPayloads[0].sizeCapped,true);
});

test('global MCP wrapper observes every registered tool outside governor intercept, including tool_governor',()=>{
  const source=readFileSync(new URL('../src/mcp.ts',import.meta.url),'utf8');
  assert.match(source,/const output = shapeToolOutput\(name, args\[0\], await governor\.intercept\(name/);
  assert.match(source,/resultTelemetry\?\.observe\(name, output/);
  assert.match(source,/resultPayloadGateway\.process\(name, output/);
  assert.match(source,/let finalOutput: unknown = gatewayDecision\.output;/);
  assert.match(source,/return finalOutput;/);
  const observeAt=source.indexOf('resultTelemetry?.observe(name, output');
  const gatewayAt=source.indexOf('resultPayloadGateway.process(name, output',observeAt);
  const returnAt=source.indexOf('return finalOutput;',source.indexOf('let finalOutput: unknown = gatewayDecision.output;',gatewayAt));
  assert.ok(observeAt>0&&gatewayAt>observeAt&&returnAt>gatewayAt);
});


test('dashboard renders result-size p50/p95 and top payload table',()=>{
  const index=readFileSync(new URL('../dashboard/index.html',import.meta.url),'utf8');
  const app=readFileSync(new URL('../dashboard/app.js',import.meta.url),'utf8');
  assert.match(index,/resultTelemetryMetrics/);
  assert.match(index,/resultTelemetryBody/);
  assert.match(app,/p50ResultChars/);
  assert.match(app,/p95ResultChars/);
  assert.match(app,/topPayloads/);
});


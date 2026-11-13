import test from 'node:test';
import assert from 'node:assert/strict';
import { ResultTelemetryService } from '../dist/result-telemetry.js';

test('result telemetry emits metadata-only OpenInference-compatible TOOL spans',()=>{
  const telemetry=new ResultTelemetryService({maxEntries:16,countCap:100000});
  const secret='SENSITIVE_SAMPLE_ABC_987';
  const entry=telemetry.observe('terminal_preview',{structuredContent:{verification:'verified',secret}},12.5,{task_run_id:'task-abcdef123456'});
  assert.match(entry.traceId,/^[0-9a-f]{32}$/);
  assert.match(entry.spanId,/^[0-9a-f]{16}$/);
  assert.equal(entry.parentTaskRunId,'task-abcdef123456');
  assert.equal(entry.spanKind,'TOOL');
  const status=telemetry.status();
  assert.equal(status.storesRawInputs,false);
  assert.equal(status.storesRawResults,false);
  assert.equal(status.remoteExporterEnabled,false);
  assert.equal(status.recentSpans[0].attributes['openinference.span.kind'],'TOOL');
  assert.equal(status.recentSpans[0].status,'OK');
  assert.doesNotMatch(JSON.stringify(status),new RegExp(secret));
});

test('trace evaluation counts ambiguous and failed verification without replaying content',()=>{
  const telemetry=new ResultTelemetryService({maxEntries:16,countCap:100000});
  telemetry.observe('browser_click_verified',{structuredContent:{verification:'ambiguous'}},20);
  telemetry.observe('office_live_apply_edit',{structuredContent:{verification:'failed'}},30);
  telemetry.observe('fs_search',{structuredContent:{verification:'verified'}},5);
  const status=telemetry.status();
  assert.equal(status.evaluation.ambiguous,1);
  assert.equal(status.evaluation.errors,1);
  assert.equal(status.evaluation.verified,1);
  assert.equal(status.recentSpans.find(x=>x.name==='browser_click_verified').status,'UNSET');
  assert.equal(status.recentSpans.find(x=>x.name==='office_live_apply_edit').status,'ERROR');
});


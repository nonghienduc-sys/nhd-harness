import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { HealthSnapshotService } from '../dist/health-snapshot.js';

const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));

test('Fast Health exposes bounded collector latency telemetry without probing on read', async()=>{
  let calls=0;
  const service=new HealthSnapshotService(async()=>{calls++;await sleep(18);return{ok:true,calls};},{refreshIntervalMs:2000,staleAfterMs:6000});
  const refreshed=await service.refresh();
  assert.equal(calls,1);
  assert.equal(refreshed.state,'healthy');
  assert.equal(refreshed.collectorLatencyMs.samples,1);
  assert.ok(refreshed.collectorLatencyMs.last>=10);
  const a=service.snapshot();const b=service.snapshot();
  assert.equal(calls,1);
  assert.equal(a.collectorLatencyMs.samples,1);
  assert.equal(b.collectorLatencyMs.samples,1);
  service.stop();
});

test('dashboard health polling is Fast Health first with last-known-good and bounded deep fallback',()=>{
  const app=readFileSync(resolve('dashboard/app.js'),'utf8');
  assert.match(app,/timedJson\('\/api\/health\/fast'/);
  assert.match(app,/lastGoodState/);
  assert.match(app,/usingLastKnownGood/);
  assert.match(app,/refreshDeepHealth/);
  assert.match(app,/options\.forceDeep/);
  assert.match(app,/MCP reconnecting/);
  assert.match(app,/Last-known-good/);
  assert.match(app,/Fast Health/);
  assert.doesNotMatch(app,/Promise\.all\(\[json\('\/api\/health'/);
});

test('Fast Health snapshot data contains dashboard identity and tunnel fields',()=>{
  const server=readFileSync(resolve('src/server.ts'),'utf8');
  const index=readFileSync(resolve('dashboard/index.html'),'utf8');
  assert.match(server,/instanceId:config\.instanceId/);
  assert.match(server,/port:config\.port/);
  assert.match(server,/tunnel:tunnel\.status\(\)/);
  assert.match(server,/resumeContext:\{ available:true, deferred:true, source:"fast-health"/);
  const collector=server.slice(server.indexOf('const healthSnapshot = new HealthSnapshotService'),server.indexOf('healthSnapshot.start();'));
  assert.doesNotMatch(collector,/workspaceMemory\.bootstrap/);
  assert.match(index,/app\.js\?v=20261113-vi2/);
});


test('dashboard health hysteresis does not declare reconnecting after one Fast Health miss',()=>{
  const app=readFileSync(resolve('dashboard/app.js'),'utf8');
  assert.match(app,/fastFailureStreak===1\?'revalidating'/);
  assert.match(app,/fastFailureStreak>=2/);
  assert.match(app,/Fast Health missed 1 check; revalidating without declaring MCP offline/);
  assert.match(app,/Fast \+ Deep \+ Liveness checks failed/);
  assert.match(app,/fastFailureStreak>=5&&deepFailureStreak>=2/);
  assert.match(app,/fastLatencyMs:null,deepLatencyMs:null/);
});

test('Fast Health collector caches filesystem-heavy skill/runtime metadata and samples isolated status once',()=>{
  const server=readFileSync(resolve('src/server.ts'),'utf8');
  assert.match(server,/let fastSkillValidation = skills\.validate\(\)/);
  assert.match(server,/const fastRuntimeIdentity = runtimeIdentity\.identity\(\)/);
  assert.match(server,/skills:fastSkillValidation/);
  assert.match(server,/const isolatedStatus = isolatedAgent\.status\(\)/);
  assert.match(server,/executionLanes:executionLanes\.status\(isolatedStatus\), isolatedAgent:isolatedStatus/);
  assert.match(server,/fastSkillValidation = skills\.validate\(\)/);
});


test('cold-start health uses bounded revalidation before unavailable',()=>{
  const app=readFileSync(resolve('dashboard/app.js'),'utf8');
  assert.match(app,/function markColdStartFailure/);
  assert.match(app,/if\(fastFailureStreak<2\)\{scheduleHealthRetry\(900\);return\}/);
  assert.match(app,/Startup Fast \+ Deep \+ Liveness checks are still revalidating/);
  assert.match(app,/fastFailureStreak>=5&&deepFailureStreak>=2&&livenessFailureStreak>=2/);
  assert.match(app,/retrying without declaring MCP offline/);
  assert.match(app,/function scheduleHealthRetry/);
});


test('liveness is separated from readiness so Fast/Deep degradation is not false offline',()=>{
  const server=readFileSync(resolve('src/server.ts'),'utf8');
  const app=readFileSync(resolve('dashboard/app.js'),'utf8');
  assert.match(server,/app\.get\("\/api\/health\/live"/);
  assert.match(app,/timedJson\('\/api\/health\/live'/);
  assert.match(app,/function recentlyLive/);
  assert.match(app,/MCP liveness endpoint confirms the core is online/);
  assert.match(app,/Fast\/Deep readiness checks are degraded, but MCP liveness is confirmed/);
  assert.match(app,/livenessFailureStreak>=2/);
  assert.match(app,/live\+last-known-good/);
});

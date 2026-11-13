import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

test('dashboard exposes durable Plan State surfaces and API consumer',()=>{
  const index=readFileSync(resolve('dashboard/index.html'),'utf8');
  const app=readFileSync(resolve('dashboard/app.js'),'utf8');
  const redesign=readFileSync(resolve('dashboard/redesign.js'),'utf8');
  const server=readFileSync(resolve('src/server.ts'),'utf8');
  assert.match(index,/id="planStatePanel"/);
  assert.match(index,/id="planStateBody"/);
  assert.match(redesign,/id="planOverviewCard"/);
  assert.match(app,/\/api\/plans\?root=/);
  assert.match(app,/PHASE HIỆN TẠI/);
  assert.match(app,/TIẾP THEO/);
  assert.match(server,/app\.get\("\/api\/plans"/);
  assert.match(server,/plans\.taskCompletionGuard/);
});

test('MCP registers task_plan only when durable Plan State is injected',()=>{
  const source=readFileSync(resolve('src','mcp-registries','context-tools.ts'),'utf8');
  assert.match(source,/if \(planState\)/);
  assert.match(source,/registerTool\("task_plan"/);
  assert.match(source,/planState\.verifyPhase\(/);
});

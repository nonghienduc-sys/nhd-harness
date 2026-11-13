import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ToolGovernorService } from '../dist/tool-governor.js';

function runtimeFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'nhd-persistent-governor-'));
  const root = 'D:\\ChatGPT-Workstation-MCP';
  const fakeMemory = {
    stats: () => ({ activeProjectRoot: root }),
    listFacts: () => [{ key: 'runtime.version', value: '0.23.2-test', category: 'runtime', confidence: 'verified', updatedAt: '2026-10-15T00:00:00Z' }],
    projects: { status: input => ({ root: input || root }), listDecisions: () => [] },
    taskRuns: { list: () => [] },
  };
  let inventory = [
    { name: 'skills_search', group: 'Skills', description: 'Search skills.', enabled: true, status: 'enabled', permission: 'skills', destructive: false },
    { name: 'runtime_identity', group: 'Workstation', description: 'Runtime identity.', enabled: true, status: 'enabled', permission: 'read', destructive: false },
  ];
  const governor = new ToolGovernorService({
    dataDir: dir,
    workspaceMemory: fakeMemory,
    inventoryProvider: () => inventory,
    lifecycle: 'runtime-scoped-v1',
  });
  return {
    dir,
    root,
    governor,
    setInventory(next) { inventory = next; governor.setInventoryProvider(() => inventory); },
  };
}

test('runtime-scoped governor preserves active plan, duplicate tracking, safe cache and metrics across request-like calls', async () => {
  const { dir, root, governor } = runtimeFixture();
  try {
    const plan = governor.plan({ text: 'Implement persistent MCP governor runtime.', root });
    const initial = governor.status();
    assert.equal(initial.lifecycle, 'runtime-scoped-v1');
    assert.equal(initial.activePlans.length, 1);
    assert.equal(initial.activePlans[0].id, plan.planId);

    let underlyingRuns = 0;
    const request1 = await governor.intercept('skills_search', { query: 'persistent governor' }, { readOnlyHint: true }, async () => ({ run: ++underlyingRuns }));
    const afterRequest1 = governor.status();
    const request2 = await governor.intercept('skills_search', { query: 'persistent governor' }, { readOnlyHint: true }, async () => ({ run: ++underlyingRuns }));
    const afterRequest2 = governor.status();

    assert.deepEqual(request2, request1);
    assert.equal(underlyingRuns, 1, 'second request-like call should reuse the runtime safe metadata cache');
    assert.equal(afterRequest2.instanceId, afterRequest1.instanceId, 'runtime governor identity must remain stable');
    assert.equal(afterRequest2.activePlans.length, 1);
    assert.equal(afterRequest2.activePlans[0].id, plan.planId);
    assert.equal(afterRequest2.activePlans[0].toolCalls, 2);
    assert.ok(afterRequest2.metrics.interceptedCalls >= afterRequest1.metrics.interceptedCalls + 1);
    assert.ok(afterRequest2.metrics.duplicateCalls >= 1);
    assert.ok(afterRequest2.metrics.cacheHits >= 1);
    assert.equal(afterRequest2.closed, false);
  } finally {
    governor.close();
    governor.close(); // close is intentionally idempotent for backend shutdown races.
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runtime governor inventory provider can attach after dashboard MCP registry exists', () => {
  const { dir, governor, setInventory } = runtimeFixture();
  try {
    assert.equal(governor.capabilities().totalTools, 2);
    setInventory([
      { name: 'fs_read', group: 'Filesystem', description: 'Read file.', enabled: true, status: 'enabled', permission: 'read', destructive: false },
      { name: 'tool_governor', group: 'Workstation', description: 'Governor.', enabled: true, status: 'enabled', permission: 'mixed', destructive: false },
      { name: 'workstation_health_fast', group: 'Workstation', description: 'Fast health.', enabled: true, status: 'enabled', permission: 'read', destructive: false },
    ]);
    const capabilities = governor.capabilities();
    assert.equal(capabilities.totalTools, 3);
    assert.equal(capabilities.hiddenCapabilities, false);
  } finally {
    governor.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('server owns one governor and injects it into dashboard and every per-request MCP server', () => {
  const server = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');
  const mcp = readFileSync(new URL('../src/mcp.ts', import.meta.url), 'utf8');

  assert.match(server, /const governor = new ToolGovernorService\(/);
  assert.match(server, /lifecycle: "runtime-scoped-v1"/);
  assert.match(server, /governor\.setInventoryProvider\(\(\) => getWorkstationToolInventory\(dashboardMcp, config\)\)/);
  assert.match(server, /const workstationRuntime = createWorkstationRuntime\(\{/);
  assert.match(server, /planState: plans, governor,/);
  assert.ok((server.match(/createWorkstationMcp\(workstationRuntime[,)]/g) || []).length >= 2, 'dashboard and request MCP factories must share the same runtime container');
  assert.ok((server.match(/governor:governor\.status\(\)/g) || []).length >= 1, 'Fast Health must expose live governor status');
  assert.ok((server.match(/governor: governor\.status\(\)/g) || []).length >= 1, 'Deep Health must expose live governor status');
  assert.match(server, /try \{ governor\.close\(\); \} catch \{\}/);

  assert.match(mcp, /governor: sharedGovernor/);
  assert.match(mcp, /const governor = sharedGovernor \?\? new ToolGovernorService/);
  assert.match(mcp, /lifecycle: "mcp-instance-fallback-v1"/);
});

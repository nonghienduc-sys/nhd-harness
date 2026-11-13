import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createWorkstationRuntime } from '../dist/workstation-runtime.js';

test('WorkstationRuntime is a single frozen process-scoped dependency container', () => {
  const marker = {};
  const runtime = createWorkstationRuntime({ config: marker, store: marker, files: marker, terminal: marker, office: marker, skills: marker, screen: marker, projects: marker, documents: marker, desktop: marker, intake: marker, pdf: marker, desktopIntake: marker });
  assert.equal(Object.isFrozen(runtime), true);
  assert.equal(runtime.config, marker);
  assert.equal(runtime.office, marker);
  assert.throws(() => createWorkstationRuntime({ config: marker }), /missing required core services/i);
});

test('production MCP construction uses one WorkstationRuntime argument instead of positional service fan-out', () => {
  const mcp = readFileSync(new URL('../src/mcp.ts', import.meta.url), 'utf8');
  const server = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');
  assert.match(mcp, /createWorkstationMcp\(runtimeContext: WorkstationRuntime(?:, requestContext: McpRequestContext = \{\})?\)/);
  assert.match(server, /const workstationRuntime = createWorkstationRuntime\(\{/);
  assert.equal((server.match(/createWorkstationMcp\(workstationRuntime[,)]/g) ?? []).length, 2);
  assert.doesNotMatch(server, /createWorkstationMcp\(config, store, files, terminal/);
});

test('legacy positional construction is isolated to test fixtures and absent from production source', () => {
  const source = readFileSync(new URL('../src/mcp.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /createWorkstationMcp\(config: AppConfig, store: Store/);
  const fixture = readFileSync(new URL('./helpers/mcp-legacy.mjs', import.meta.url), 'utf8');
  assert.match(fixture, /createWorkstationRuntime/);
});

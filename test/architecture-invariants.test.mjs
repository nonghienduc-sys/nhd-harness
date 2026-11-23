import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const read = rel => readFileSync(resolve(root, rel), 'utf8').replace(/^\uFEFF/, '');

function catalog() {
  return JSON.parse(read('docs/generated/capability-catalog.json'));
}

test('generated architecture docs are deterministic and current', () => {
  for (const rel of ['docs/generated/CAPABILITIES.md', 'docs/generated/ARCHITECTURE.md', 'docs/generated/capability-catalog.json']) {
    assert.equal(existsSync(resolve(root, rel)), true, `${rel} must exist`);
  }
  execFileSync(process.execPath, [resolve(root, 'scripts/generate-architecture-docs.mjs'), '--check'], { cwd: root, stdio: 'pipe' });
});

test('generated capability catalog covers the full 167-tool surface exactly once', () => {
  const data = catalog();
  assert.equal(data.schemaVersion, 1);
  assert.equal(data.version, JSON.parse(read('package.json')).version);
  assert.equal(data.toolCount, 167);
  assert.equal(data.tools.length, 167);
  assert.equal(new Set(data.tools.map(tool => tool.name)).size, 167);
  for (const tool of data.tools) {
    assert.ok(tool.name);
    assert.ok(tool.registryDomain);
    assert.ok(tool.group);
    assert.ok(tool.permission);
    assert.ok(['background', 'isolated', 'either'].includes(tool.lane), tool.name);
    assert.ok(['read-only', 'reversible', 'mutation', 'destructive', 'dynamic'].includes(tool.risk), tool.name);
    assert.ok(Array.isArray(tool.runtimeRequirements), tool.name);
  }
  for (const name of ['harness_mode', 'delegate_task', 'review_pack', 'executor_admin', 'sbce_artifact_handoff', 'fs_apply_write', 'fs_apply_move', 'fs_apply_delete', 'workstation_plan', 'tool_governor', 'runtime_identity', 'context_payload_artifact', 'self_evolution_status', 'self_evolution_record_feedback', 'self_evolution_analyze', 'self_evolution_propose', 'self_evolution_evaluate']) {
    assert.ok(data.tools.some(tool => tool.name === name), `${name} must be generated`);
  }
});

test('production MCP construction uses one WorkstationRuntime and thirteen domain registries', () => {
  const runtime = read('src/workstation-runtime.ts');
  const mcp = read('src/mcp.ts');
  assert.match(runtime, /Object\.freeze\(\{ \.\.\.input \}\)/);
  assert.match(mcp, /createWorkstationMcp\(runtimeContext: WorkstationRuntime(?:, requestContext: McpRequestContext = \{\})?\)/);
  assert.equal((mcp.match(/server\.registerTool\(/g) ?? []).length, 0);
  for (const fn of ['registerExecutionPlatformTools', 'registerExecutionTerminalTools', 'registerFilesTools', 'registerProjectDocumentTools', 'registerContextTools', 'registerProjectRagTools', 'registerOfficeTools', 'registerBrowserTools', 'registerMediaTools']) {
    assert.match(mcp, new RegExp(`${fn}\\(registryContext\\)`), fn);
  }
  const files = readdirSync(resolve(root, 'src/mcp-registries')).filter(file => file.endsWith('-tools.ts')).sort();
  assert.match(mcp, /registerSelfEvolutionTools\(registryContext, selfEvolution\)/);
  assert.match(mcp, /registerDelegationTools\(registryContext, runtimeContext\.sbceExecutor\)/);
  assert.match(mcp, /registerBrainKitTools\(registryContext\)/);
  assert.match(mcp, /registerLessonTools\(registryContext, selfEvolution\)/);
  assert.match(mcp, /registerPlaybookTools\(registryContext\)/);
  assert.deepEqual(files, ['brain-kit-tools.ts', 'browser-tools.ts', 'code-run-tools.ts', 'context-tools.ts', 'delegation-tools.ts', 'document-template-tools.ts', 'execution-tools.ts', 'files-tools.ts', 'lesson-tools.ts', 'media-tools.ts', 'office-tools.ts', 'playbook-tools.ts', 'project-rag-tools.ts', 'self-evolution-tools.ts']);
});

test('Capability Registry remains the single deterministic metadata authority', () => {
  const capability = read('src/capability-registry.ts');
  const mcp = read('src/mcp.ts');
  const router = read('src/router.ts');
  const lanes = read('src/execution-lanes.ts');
  const governor = read('src/tool-governor.ts');
  for (const fn of ['capabilityGroup', 'capabilityPermission', 'capabilityIsMutation', 'capabilityLane', 'capabilityRisk', 'capabilityRuntimeRequirements', 'capabilityRuntimeState', 'capabilitiesFromRuntime']) assert.match(capability, new RegExp(`function ${fn}\\(`));
  assert.doesNotMatch(mcp, /function toolGroup\(/);
  assert.doesNotMatch(mcp, /function toolPermission\(/);
  assert.doesNotMatch(router, /function capabilitiesFromRuntime\(/);
  assert.match(router, /from "\.\/capability-registry\.js"/);
  assert.match(lanes, /BACKGROUND_LANE_CAPABILITIES/);
  assert.match(lanes, /BACKGROUND_LANE_FORBIDDEN/);
  assert.doesNotMatch(governor, /function toolIsMutation\(/);
  assert.match(governor, /capabilityIsMutation/);
});

test('Persistent Governor is runtime-scoped and UnifiedExecutionPlanner is read-only planning metadata', () => {
  const server = read('src/server.ts');
  const mcp = read('src/mcp.ts');
  const planner = read('src/execution-planner.ts');
  assert.match(server, /const governor = new ToolGovernorService\(/);
  assert.match(server, /planState: plans, governor,/);
  assert.match(mcp, /governor: sharedGovernor/);
  assert.match(mcp, /new UnifiedExecutionPlanner\(/);
  assert.match(planner, /kind: "unified-execution-plan"/);
  assert.match(planner, /executesActions: false/);
  assert.match(planner, /grantsAuthorization: false/);
  assert.match(planner, /neverReplayAmbiguousExecution: true/);
  assert.match(planner, /authorizationStillEnforcedByActionTool: true/);
});

test('Background lane cannot seize host foreground and atomic release requires smoke verification', () => {
  const lanes = read('src/capability-registry.ts');
  const execution = read('src/execution-lanes.ts');
  const release = read('scripts/atomic-release.mjs');
  assert.match(lanes, /"host-mouse"/);
  assert.match(lanes, /"host-keyboard-injection"/);
  assert.match(lanes, /"host-window-activation"/);
  assert.match(execution, /hostForegroundAllowed: false/);
  assert.match(release, /RELEASE_MODEL = 'atomic-json-pointer-v1'/);
  assert.match(release, /Candidate has not passed the smoke\/verification gate/);
  assert.match(release, /previous: state\.current/);
});

test('stale hand-maintained tool counts are replaced by generated/runtime references and CI enforces architecture checks', () => {
  const toolsDoc = read('docs/TOOLS.md');
  const workflow = read('.github/workflows/architecture.yml');
  const pkg = JSON.parse(read('package.json'));
  assert.doesNotMatch(toolsDoc, /52 tools|v0\.4\.0 Tools/);
  assert.match(toolsDoc, /docs\/generated\/CAPABILITIES\.md/);
  assert.equal(pkg.scripts['docs:architecture'], 'node scripts/generate-architecture-docs.mjs');
  assert.equal(pkg.scripts['docs:architecture:check'], 'node scripts/generate-architecture-docs.mjs --check');
  assert.match(pkg.scripts['test:architecture'], /architecture-invariants\.test\.mjs/);
  assert.match(workflow, /npm run test:architecture/);
});


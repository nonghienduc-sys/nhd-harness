import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BACKGROUND_LANE_CAPABILITIES,
  BACKGROUND_LANE_FORBIDDEN,
  capabilityStaticMetadata,
} from '../dist/capability-registry.js';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(scriptDir, '..');
const registriesRoot = join(root, 'src', 'mcp-registries');
const outputRoot = join(root, 'docs', 'generated');
const checkOnly = process.argv.includes('--check');
const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8').replace(/^\uFEFF/, ''));
const version = String(packageJson.version || '').trim();

const registryDomains = Object.freeze({
  'execution-tools.ts': 'Execution',
  'delegation-tools.ts': 'Delegation',
  'files-tools.ts': 'Files',
  'context-tools.ts': 'Context',
  'office-tools.ts': 'Office',
  'browser-tools.ts': 'Browser',
  'media-tools.ts': 'Media',
  'self-evolution-tools.ts': 'Self-Evolution',
});

const annotationProfiles = Object.freeze({
  readOnly: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  preview: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  destructive: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  reversibleMutation: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  navigation: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  webRead: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  webNavigation: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
});

function decodeQuoted(text, start) {
  const quote = text[start];
  if (!['"', "'", '`'].includes(quote)) return { value: '', end: start };
  let value = '';
  let escaped = false;
  for (let i = start + 1; i < text.length; i += 1) {
    const ch = text[i];
    if (escaped) {
      const map = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v' };
      value += map[ch] ?? ch;
      escaped = false;
      continue;
    }
    if (ch === '\\') { escaped = true; continue; }
    if (ch === quote) return { value, end: i + 1 };
    value += ch;
  }
  throw new Error('Unterminated string literal while generating architecture docs.');
}

function extractDescription(chunk) {
  const marker = chunk.search(/description\s*:/);
  if (marker < 0) return '';
  const colon = chunk.indexOf(':', marker);
  let i = colon + 1;
  while (/\s/.test(chunk[i] ?? '')) i += 1;
  if (!['"', "'", '`'].includes(chunk[i])) return '';
  const { value } = decodeQuoted(chunk, i);
  return value.replace(/\$\{[^}]+\}/g, '{dynamic}').replace(/\s+/g, ' ').trim();
}

function extractAnnotation(chunk) {
  const match = chunk.match(/annotations\s*:\s*(readOnly|preview|destructive|reversibleMutation|navigation|webRead|webNavigation)\b/);
  return match?.[1] ?? 'readOnly';
}

function literalRegistrations(file, registryDomain) {
  const text = readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  const starts = [...text.matchAll(/server\.registerTool\(\s*"([^"]+)"/g)];
  const records = [];
  for (let index = 0; index < starts.length; index += 1) {
    const current = starts[index];
    const nextIndex = starts[index + 1]?.index ?? text.length;
    const chunk = text.slice(current.index, nextIndex);
    const name = current[1];
    const annotation = extractAnnotation(chunk);
    const annotations = annotationProfiles[annotation];
    const meta = capabilityStaticMetadata(name, annotations);
    records.push({
      name,
      registryDomain,
      annotation,
      description: extractDescription(chunk),
      ...meta,
    });
  }
  if (text.includes('server.registerTool(`fs_apply_${kind}`')) {
    for (const kind of ['write', 'move', 'delete']) {
      const name = `fs_apply_${kind}`;
      const annotation = 'destructive';
      records.push({
        name,
        registryDomain,
        annotation,
        description: `Apply a previously previewed file ${kind} using its unexpired one-time confirmation token.`,
        ...capabilityStaticMetadata(name, annotationProfiles[annotation]),
      });
    }
  }
  return records;
}

const files = readdirSync(registriesRoot)
  .filter(name => registryDomains[name])
  .sort((a, b) => a.localeCompare(b));

const tools = files.flatMap(name => literalRegistrations(join(registriesRoot, name), registryDomains[name]));
const byName = new Map();
for (const tool of tools) {
  if (byName.has(tool.name)) throw new Error(`Duplicate generated capability entry: ${tool.name}`);
  byName.set(tool.name, tool);
}
const sortedTools = [...byName.values()].sort((a, b) => a.group.localeCompare(b.group) || a.name.localeCompare(b.name));
const EXPECTED_TOOL_COUNT = 167;
if (sortedTools.length !== EXPECTED_TOOL_COUNT) {
  throw new Error(`Capability catalog must cover exactly the live ${EXPECTED_TOOL_COUNT}-tool surface; generated ${sortedTools.length}. Fix registry parsing instead of weakening the invariant.`);
}

function countsBy(key) {
  const out = {};
  for (const tool of sortedTools) out[tool[key]] = (out[tool[key]] ?? 0) + 1;
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}

const catalog = {
  schemaVersion: 1,
  version,
  sourceOfTruth: {
    registration: 'src/mcp-registries/*.ts',
    capabilityPolicy: 'src/capability-registry.ts',
    executionPlan: 'src/execution-planner.ts',
  },
  toolCount: sortedTools.length,
  registryDomains: countsBy('registryDomain'),
  groups: countsBy('group'),
  permissions: countsBy('permission'),
  lanes: countsBy('lane'),
  risks: countsBy('risk'),
  backgroundLane: {
    capabilities: [...BACKGROUND_LANE_CAPABILITIES],
    forbidden: [...BACKGROUND_LANE_FORBIDDEN],
  },
  architecture: {
    runtimeContainer: 'WorkstationRuntime',
    capabilityRegistry: 'src/capability-registry.ts',
    domainRegistries: files.map(name => `src/mcp-registries/${name}`),
    executionPlanner: 'UnifiedExecutionPlanner',
    governorLifecycle: 'runtime-scoped-v1',
    releaseModel: 'atomic-json-pointer-v1',
    connectionModel: 'multi-harness-single-core-v1',
    remoteMcp: 'oauth-streamable-http-cloudflare',
    localMcp: 'loopback-streamable-http-stdio-proxy',
    localMcpDefault: '127.0.0.1:39104',
    privateCloudTunnel: 'openai-secure-mcp-tunnel-optional',
    hostForegroundPolicy: 'blocked',
    directFastLanePreserved: true,
    planningExecutesActions: false,
    planningGrantsAuthorization: false,
    ambiguousExecutionReplay: 'forbidden',
  },
  tools: sortedTools.map(tool => ({
    name: tool.name,
    registryDomain: tool.registryDomain,
    group: tool.group,
    permission: tool.permission,
    lane: tool.lane,
    risk: tool.risk,
    mutation: tool.mutation,
    destructive: tool.destructive,
    openWorld: tool.openWorld,
    runtimeRequirements: tool.runtimeRequirements,
    annotation: tool.annotation,
    description: tool.description,
  })),
};

function esc(value) {
  return String(value ?? '').replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ').trim();
}

const capabilityLines = [
  '# Generated Capability Catalog',
  '',
  '> GENERATED FILE. Do not maintain tool counts or capability policy by hand. Regenerate with `npm run docs:architecture` and verify with `npm run docs:architecture:check`.',
  '',
  `- Version: ${version}`,
  `- Registered tools: ${catalog.toolCount}`,
  '- Registration source: `src/mcp-registries/*.ts`',
  '- Capability policy source: `src/capability-registry.ts`',
  '- Runtime truth: `/api/tools` and `tool_governor action=capabilities`',
  '',
  '## Group counts',
  '',
  '| Group | Tools |',
  '| --- | ---: |',
  ...Object.entries(catalog.groups).map(([group, count]) => `| ${esc(group)} | ${count} |`),
  '',
  '## Tools',
  '',
  '| Tool | Registry | Group | Permission | Lane | Risk | Mutation | Open world | Runtime requirements | Purpose |',
  '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  ...catalog.tools.map(tool => `| \`${tool.name}\` | ${esc(tool.registryDomain)} | ${esc(tool.group)} | ${esc(tool.permission)} | ${esc(tool.lane)} | ${esc(tool.risk)} | ${tool.mutation ? 'yes' : 'no'} | ${tool.openWorld ? 'yes' : 'no'} | ${esc(tool.runtimeRequirements.join(', ') || 'none')} | ${esc(tool.description)} |`),
  '',
].join('\n');

const architectureLines = [
  '# Generated Architecture Contract',
  '',
  '> GENERATED FILE. This document is derived from current source contracts and is protected by architecture drift checks.',
  '',
  `Version: ${version}`,
  '',
  '## Runtime composition',
  '',
  '- `WorkstationRuntime` is the single frozen process-scope dependency container supplied to stateless MCP protocol instances.',
  '- MCP registration ownership is split across six domain registries: Execution, Files, Context, Office, Browser, and Media.',
  '- `src/capability-registry.ts` is the deterministic source for tool group, permission, mutation/risk baseline, lane, runtime requirements, and runtime capability state.',
  '- `UnifiedExecutionPlanner` composes Router, execution lane, risk policy, adaptive Office QA, Capability Registry metadata, and pure Tool Governor advice.',
  '- Planning is read-only metadata: it executes no action and grants no authorization.',
  '- Runtime-scoped Tool Governor preserves global capability visibility and Direct Fast Lane behavior.',
  '- Connection model is `multi-harness-single-core-v1`: remote OAuth MCP and loopback/stdio harness traffic converge on the same process-scoped `WorkstationRuntime`.',
  '- Remote MCP remains on the authenticated Cloudflare path; local harness MCP binds only to loopback and defaults to `127.0.0.1:39104`.',
  '- OpenAI Secure MCP Tunnel is optional and targets the private loopback MCP without requiring NHD to persist a control-plane API key.',
  '',
  '## Execution safety invariants',
  '',
  '- Background host foreground policy: **blocked**.',
  `- Background capabilities: ${BACKGROUND_LANE_CAPABILITIES.map(value => `\`${value}\``).join(', ')}.`,
  `- Background forbidden operations: ${BACKGROUND_LANE_FORBIDDEN.map(value => `\`${value}\``).join(', ')}.`,
  '- Ambiguous/interrupted side-effect execution is never replayed automatically.',
  '- Action tools continue to own preview/token/task-authorization/critical-confirmation enforcement.',
  '- Adaptive Office QA does not silently convert visual verification into host foreground control.',
  '',
  '## Deployment invariants',
  '',
  '- Release model: `atomic-json-pointer-v1`.',
  '- Candidate smoke verification is required before atomic promotion.',
  '- Previous immutable release remains the rollback target after promotion.',
  '- Generated docs are development/CI evidence; live runtime identity and capability endpoints remain authoritative for deployed state.',
  '',
  '## Drift enforcement',
  '',
  '- `npm run docs:architecture:check` fails when generated docs differ from current source.',
  '- `npm run test:architecture` checks generated docs and cross-module architecture invariants.',
  '- CI runs architecture checks on pushes and pull requests.',
  '',
].join('\n');

const outputs = new Map([
  [join(outputRoot, 'capability-catalog.json'), `${JSON.stringify(catalog, null, 2)}\n`],
  [join(outputRoot, 'CAPABILITIES.md'), capabilityLines],
  [join(outputRoot, 'ARCHITECTURE.md'), architectureLines],
]);

const drift = [];
for (const [path, content] of outputs) {
  const current = existsSync(path) ? readFileSync(path, 'utf8').replace(/^\uFEFF/, '') : null;
  if (current !== content) drift.push(relative(root, path).replace(/\\/g, '/'));
  if (!checkOnly) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content, 'utf8');
  }
}

if (checkOnly && drift.length) {
  console.error(`Generated architecture docs are stale: ${drift.join(', ')}`);
  process.exitCode = 1;
} else {
  process.stdout.write(`${JSON.stringify({ ok: true, mode: checkOnly ? 'check' : 'write', version, toolCount: catalog.toolCount, outputs: [...outputs.keys()].map(path => relative(root, path).replace(/\\/g, '/')) }, null, 2)}\n`);
}


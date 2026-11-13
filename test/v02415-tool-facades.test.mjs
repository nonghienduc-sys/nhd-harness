import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createWorkstationMcp } from './helpers/mcp-legacy.mjs';
import { prependText } from '../dist/output-shaping.js';
import { TOOL_FACADES, buildFacade, facadeHiddenNames, facadeOwnedNames } from '../dist/tool-facades.js';

const config = { roots:['D:/'], intakeRoots:['D:/inbox'], dataDir:'D:/tmp', backupDir:'D:/tmp/backups', writeEnabled:true, terminalEnabled:true, skillsEnabled:true, screenEnabled:true, desktopEnabled:true, browserEnabled:true, visualDesktopEnabled:true, intakeEnabled:true, ocrEnabled:true, emergencyStop:false };

async function connected() {
  const d = {};
  const server = createWorkstationMcp(config, d, d, d, { status: async () => ({}) }, d, d, d, d, { status: async () => ({}) }, { status: () => ({ availableRoots: 1 }) }, { status: async () => ({}) }, d, { status: async () => ({ executable: null }) });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'v02415-facades', version: '1.0.0' });
  await server.connect(b); await client.connect(a);
  return { server, client };
}

test('prependText mirrors the context header into structuredContent._nhdContext', () => {
  const out = prependText({ structuredContent: { ok: true }, content: [{ type: 'text', text: '{}' }] }, 'NHD context');
  assert.equal(out.content[0].text, 'NHD context');
  assert.equal(out.structuredContent._nhdContext, 'NHD context');
  assert.equal(out.structuredContent.ok, true);
  const plain = prependText({ content: [{ type: 'text', text: 'x' }] }, 'H');
  assert.equal(plain.structuredContent, undefined);
});

test('facade spec is consistent: unique names, owned names are default ops, no member in two facades', () => {
  const seen = new Set();
  for (const spec of TOOL_FACADES) {
    assert.ok(!seen.has(spec.name), spec.name); seen.add(spec.name);
    if (Object.values(spec.members).includes(spec.name)) assert.equal(spec.members[spec.defaultOp], spec.name, spec.name);
  }
  const members = TOOL_FACADES.flatMap(spec => Object.values(spec.members));
  assert.equal(new Set(members).size, members.length);
  for (const name of facadeOwnedNames()) assert.ok(!facadeHiddenNames().has(name));
});

test('facades hide old names from tools/list, keep them callable, and dispatch by op', async () => {
  const { server, client } = await connected();
  try {
    const names = (await client.listTools()).tools.map(t => t.name);
    assert.ok(names.includes('local_ai_router'));
    assert.ok(!names.includes('local_ai_status'));
    assert.ok(names.includes('skills_registry') && !names.includes('skills_search'));
    assert.ok(names.includes('fs_read') && names.includes('fs_preview_write'));
    const router = (await client.listTools()).tools.find(t => t.name === 'local_ai_router');
    assert.ok(router.inputSchema.properties.op.enum.includes('status'));
    assert.equal(router.annotations.readOnlyHint, true);

    const viaFacade = await client.callTool({ name: 'local_ai_router', arguments: { op: 'status' } });
    const viaAlias = await client.callTool({ name: 'local_ai_status', arguments: {} });
    assert.notEqual(viaFacade.isError, true);
    assert.deepEqual(Object.keys(viaFacade.structuredContent).sort(), Object.keys(viaAlias.structuredContent).sort());

    const missing = await client.callTool({ name: 'local_ai_router', arguments: {} });
    assert.equal(missing.isError, true);
    assert.match(missing.content[0].text, /status|op/);
  } finally { await client.close(); await server.close(); }
});

test('NHD_TOOL_FACADES=0 restores the flat tool list', async () => {
  process.env.NHD_TOOL_FACADES = '0';
  try {
    const { server, client } = await connected();
    try {
      const names = (await client.listTools()).tools.map(t => t.name);
      assert.ok(names.includes('local_ai_status'));
      assert.ok(!names.includes('local_ai_router'));
    } finally { await client.close(); await server.close(); }
  } finally { delete process.env.NHD_TOOL_FACADES; }
});

test('buildFacade refuses to merge tools with different safety annotations and validates member args', async () => {
  const ro = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
  const rw = { readOnlyHint: false, destructiveHint: true, openWorldHint: false };
  const spec = { name: 'demo', summary: 'Demo.', members: { a: 'demo_a', b: 'demo_b' } };
  const mixed = new Map([['demo_a', { definition: { annotations: ro, inputSchema: {} }, handler: () => 'a' }], ['demo_b', { definition: { annotations: rw, inputSchema: {} }, handler: () => 'b' }]]);
  assert.throws(() => buildFacade(spec, mixed), /TOOL_FACADE_ANNOTATION_MISMATCH/);
  const same = new Map([
    ['demo_a', { definition: { annotations: ro, inputSchema: { n: z.number() } }, handler: (input) => ({ got: input }) }],
    ['demo_b', { definition: { annotations: ro }, handler: () => ({ noArgs: true }) }],
  ]);
  const facade = buildFacade(spec, same);
  assert.deepEqual(await facade.handler({ op: 'a', n: 2 }), { got: { n: 2 } });
  assert.deepEqual(await facade.handler({ op: 'b', n: 2 }), { noArgs: true });
  const bad = await facade.handler({ op: 'a', n: 'x' });
  assert.equal(bad.isError, true);
  assert.match(bad.content[0].text, /demo op=a: invalid arguments/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createWorkstationMcp } from './helpers/mcp-legacy.mjs';
import { briefDescription, facadeHiddenNames, TOOL_FACADES } from '../dist/tool-facades.js';

const root = resolve(import.meta.dirname, '..');
const config = { roots:['D:/'], intakeRoots:['D:/inbox'], dataDir:'D:/tmp', backupDir:'D:/tmp/backups', writeEnabled:true, terminalEnabled:true, skillsEnabled:true, screenEnabled:true, desktopEnabled:true, browserEnabled:true, visualDesktopEnabled:true, intakeEnabled:true, ocrEnabled:true, emergencyStop:false };

async function listTools() {
  const d = {};
  const server = createWorkstationMcp(config, d, d, d, { status: async () => ({}) }, d, d, d, d, { status: async () => ({}) }, { status: () => ({ availableRoots: 1 }) }, { status: async () => ({}) }, d, { status: async () => ({ executable: null }) });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'v02417-surface', version: '1.0.0' });
  await server.connect(b); await client.connect(a);
  return (await client.listTools()).tools;
}

test('briefDescription keeps whole leading sentences within budget', () => {
  assert.equal(briefDescription('Short one.'), 'Short one.');
  const long = 'First sentence is here. ' + 'Second sentence goes on. '.repeat(10);
  const out = briefDescription(long, 60);
  assert.ok(out.startsWith('First sentence is here.'));
  assert.ok(out.length <= 60, out);
  const run = 'x'.repeat(500);
  assert.ok(briefDescription(run, 100).endsWith('...'));
});

test('office live tools share Word format schemas through $ref definitions', async () => {
  const tools = await listTools();
  for (const name of ['office_live_transaction', 'office_live_preview_edit']) {
    const tool = tools.find(t => t.name === name);
    const json = JSON.stringify(tool.inputSchema);
    assert.ok(json.includes('NhdWordFormat'), name);
    assert.ok(json.length < 7000, `${name} schema ${json.length} bytes`);
    assert.equal((json.match(/"fontColorHex"/g) || []).length, 1, name + ' Word format should be emitted once');
  }
});

test('facade descriptions stay compact', async () => {
  const tools = await listTools();
  for (const spec of TOOL_FACADES) {
    const tool = tools.find(t => t.name === spec.name);
    if (!tool) continue;
    const ops = Object.keys(spec.members).length;
    assert.ok(tool.description.length <= spec.summary.length + 30 + ops * 230, `${spec.name}: ${tool.description.length}`);
  }
});

test('packaged skills reference facade names, not deprecated aliases', () => {
  const hidden = [...facadeHiddenNames()];
  const offenders = [];
  const walk = (dir) => { for (const name of readdirSync(dir)) { const full = join(dir, name); if (statSync(full).isDirectory()) walk(full); else if (/\.md$/i.test(name)) { const text = readFileSync(full, 'utf8'); for (const old of hidden) if (new RegExp(`\\b${old}\\b`).test(text)) offenders.push(`${full}: ${old}`); } } };
  walk(join(root, 'skills'));
  assert.deepEqual(offenders, []);
});

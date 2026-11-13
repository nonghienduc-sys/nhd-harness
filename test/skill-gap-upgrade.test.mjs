import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../src/skills.ts', import.meta.url), 'utf8');
const expected = [
  'agent-security-regression',
  'mcp-security-audit',
  'mcp-trace-evaluation',
  'scientific-research-workflow',
  'semantic-code-navigation',
  'temporal-knowledge-graph',
];

test('repo-gap upgrade skills are registered in the packaged skill catalog', () => {
  for (const id of expected) assert.match(source, new RegExp(`id:\\s*["']${id}["']`), id);
});

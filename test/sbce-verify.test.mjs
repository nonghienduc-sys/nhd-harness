import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import process from 'node:process';

import { verifyPatchInCopy } from '../dist/sbce-verify.js';

const patch = [
  'diff --git a/src/a.ts b/src/a.ts',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1 +1 @@',
  '-export const a=1;',
  '+export const a=2;',
  '',
].join('\n');

async function setup(t) {
  const proj = await mkdtemp(join(tmpdir(), 'sbce-proj-'));
  await writeFile(join(proj, 'package.json'), '{}');
  await mkdir(join(proj, 'src'), { recursive: true });
  await writeFile(join(proj, 'src/a.ts'), 'export const a=1;\n');

  const tmp = await mkdtemp(join(tmpdir(), 'sbce-tmp-'));
  t.after(async () => {
    await rm(proj, { recursive: true, force: true });
    await rm(tmp, { recursive: true, force: true });
  });

  return { proj, tmp };
}

async function mkdir(path, options) {
  const { mkdir: makeDirectory } = await import('node:fs/promises');
  return makeDirectory(path, options);
}

test('reports a patch application failure', async (t) => {
  const { proj, tmp } = await setup(t);
  const calls = [];
  const answer = async () => ({ code: 1, output: 'error: patch failed' });
  const run = async (cmd, args, o) => {
    calls.push({ cmd, args, cwd: o.cwd, env: o.env });
    return answer(cmd, args);
  };

  const result = await verifyPatchInCopy({
    projectRoot: proj,
    patch,
    acceptance: [],
    tmpRoot: tmp,
    run,
  });

  assert.equal(result.ok, false);
  assert.equal(result.checks[0].name, 'patch_applies');
  assert.match(result.feedback, /patch failed/);
});

test('accepts artifacts and reports pending rubric and command checks', async (t) => {
  const { proj, tmp } = await setup(t);
  const calls = [];
  const answer = async () => ({ code: 0, output: '' });
  const run = async (cmd, args, o) => {
    calls.push({ cmd, args, cwd: o.cwd, env: o.env });
    return answer(cmd, args);
  };

  const result = await verifyPatchInCopy({
    projectRoot: proj,
    patch,
    acceptance: [
      { type: 'artifact_exists', paths: ['src/a.ts'] },
      { type: 'grep_absent', pattern: 'console\\.log', paths: ['src/a.ts'] },
      { type: 'rubric', text: 'only a.ts' },
      { type: 'command', run: 'npm test' },
    ],
    tmpRoot: tmp,
    run,
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.pending, ['only a.ts', 'npm test']);
});

test('fails when a forbidden pattern is present', async (t) => {
  const { proj, tmp } = await setup(t);
  const calls = [];
  const answer = async (cmd, args) => {
    const text = args.join(' ');
    return text.includes('const a')
      ? { code: 0, output: 'src/a.ts:1:export const a=1;\n' }
      : { code: 0, output: '' };
  };
  const run = async (cmd, args, o) => {
    calls.push({ cmd, args, cwd: o.cwd, env: o.env });
    return answer(cmd, args);
  };

  const result = await verifyPatchInCopy({
    projectRoot: proj,
    patch,
    acceptance: [
      { type: 'grep_absent', pattern: 'const a', paths: ['src/a.ts'] },
    ],
    tmpRoot: tmp,
    run,
  });

  assert.equal(result.ok, false);
  assert.equal(
    result.checks.find((check) => check.name === 'grep_absent').ok,
    false,
  );
});

test('reports command compiler errors and sanitizes its environment', async (t) => {
  const { proj, tmp } = await setup(t);
  const calls = [];
  const answer = async (cmd) => cmd === process.execPath
    ? { code: 2, output: 'error TS2322' }
    : { code: 0, output: '' };
  const run = async (cmd, args, o) => {
    calls.push({ cmd, args, cwd: o.cwd, env: o.env });
    return answer(cmd, args);
  };

  const result = await verifyPatchInCopy({
    projectRoot: proj,
    patch,
    acceptance: [
      { type: 'command', run: 'npx tsc --noEmit -p .' },
    ],
    tmpRoot: tmp,
    run,
  });

  assert.equal(result.ok, false);
  assert.match(result.feedback, /TS2322/);
  const compilerCall = calls.find(({ cmd }) => cmd === process.execPath);
  assert.deepEqual(Object.keys(compilerCall.env).sort(), ['PATH', 'SystemRoot', 'TEMP', 'TMP']);
});

test('cleans the temporary project copy after verification', async (t) => {
  const { proj, tmp } = await setup(t);
  const calls = [];
  const answer = async () => ({ code: 0, output: '' });
  const run = async (cmd, args, o) => {
    calls.push({ cmd, args, cwd: o.cwd, env: o.env });
    return answer(cmd, args);
  };

  await verifyPatchInCopy({
    projectRoot: proj,
    patch,
    acceptance: [],
    tmpRoot: tmp,
    run,
  });

  assert.deepEqual(await readdir(tmp), []);
});

test('sandbox access denial goes to pending instead of failing the worker', async (t) => {
  const { proj, tmp } = await setup(t);
  const run = async (cmd, args) =>
    args.includes('--test') ? { code: 1, output: "code: 'ERR_ACCESS_DENIED'" } : { code: 0, output: '' };
  const result = await verifyPatchInCopy({
    projectRoot: proj,
    patch,
    acceptance: [{ type: 'command', run: 'node --test test/x.test.mjs' }],
    tmpRoot: tmp,
    run,
  });
  assert.equal(result.ok, true);
  assert.equal(result.checks.some((c) => c.name === 'tests'), false);
  assert.match(result.pending[0], /ERR_ACCESS_DENIED/);
});

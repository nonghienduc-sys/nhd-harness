import assert from 'node:assert/strict';
import test from 'node:test';
import { join, delimiter } from 'node:path';

import { resolveNodeRunner } from '../dist/sbce-verify.js';

test('uses NHD_NODE_PATH when it exists', () => {
  const result = resolveNodeRunner(
    { NHD_NODE_PATH: '/custom/node', PATH: '/bin' },
    '/electron',
    true,
    (file) => file === '/custom/node',
  );

  assert.deepEqual(result, {
    cmd: '/custom/node',
    extraEnv: {},
  });
});

test('uses execPath outside Electron', () => {
  const result = resolveNodeRunner(
    { PATH: '/bin' },
    '/real/node',
    false,
    () => false,
  );

  assert.deepEqual(result, {
    cmd: '/real/node',
    extraEnv: {},
  });
});

test('uses the first node executable found on PATH in Electron', () => {
  const result = resolveNodeRunner(
    { PATH: ['/first', '/second'].join(delimiter) },
    '/electron',
    true,
    (file) => file === join('/second', 'node'),
  );

  assert.deepEqual(result, {
    cmd: join('/second', 'node'),
    extraEnv: {},
  });
});

test('runs Electron as Node when no Node executable is found', () => {
  const result = resolveNodeRunner(
    { PATH: '/bin' },
    '/electron',
    true,
    () => false,
  );

  assert.deepEqual(result, {
    cmd: '/electron',
    extraEnv: { ELECTRON_RUN_AS_NODE: '1' },
  });
});

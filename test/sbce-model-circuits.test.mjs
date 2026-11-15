import test from 'node:test';
import assert from 'node:assert/strict';
import { SbceModelCircuits } from '../dist/sbce-model-circuits.js';

test('opens only the model with three provider failures', () => {
  let now = 0;
  const c = new SbceModelCircuits(() => now);

  c.failure('a', 503);
  c.failure('a', 503);
  c.failure('a', 503);

  assert.equal(c.isOpen('a'), true);
  assert.throws(() => c.beforeRequest('a'), { message: "SBCE_PROVIDER_CIRCUIT_OPEN" });
  assert.equal(c.isOpen('b'), false);
  assert.doesNotThrow(() => c.beforeRequest('b'));
});

test('openModels lists open models', () => {
  let now = 0;
  const c = new SbceModelCircuits(() => now);

  c.failure('a', 503);
  c.failure('a', 503);
  c.failure('a', 503);

  assert.deepEqual(c.openModels(), ['a']);
});

test('circuit closes after the open interval', () => {
  let now = 0;
  const c = new SbceModelCircuits(() => now);

  c.failure('a', 503);
  c.failure('a', 503);
  c.failure('a', 503);

  now += 5 * 60_000 + 1;

  assert.equal(c.isOpen('a'), false);
});

test('non-provider failures do not open a circuit', () => {
  let now = 0;
  const c = new SbceModelCircuits(() => now);

  c.failure('x', 400);
  c.failure('x', 400);
  c.failure('x', 400);
  c.failure('y', 'timeout');
  c.failure('y', 'timeout');
  c.failure('y', 'timeout');

  assert.equal(c.isOpen('x'), false);
  assert.equal(c.isOpen('y'), true);
});

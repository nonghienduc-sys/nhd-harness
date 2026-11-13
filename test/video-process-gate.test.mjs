import test from 'node:test';
import assert from 'node:assert/strict';
import { VideoProcessGate } from '../dist/video-process-gate.js';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

test('video subprocess gate caps concurrent work and drains the queue', async () => {
  const gate = new VideoProcessGate(2, 10, 2000);
  let active = 0, maximum = 0;
  const tasks = Array.from({ length: 9 }, (_, i) => gate.withSlot(async () => {
    active++;
    maximum = Math.max(maximum, active);
    await delay(7);
    active--;
    return i;
  }));
  const result = await Promise.all(tasks);
  assert.equal(result.length, 9);
  assert.deepEqual(result, [0, 1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(maximum, 2);
  assert.equal(gate.status().active, 0);
  assert.equal(gate.status().queued, 0);
});

test('video gate handles failed tasks without leaking slots', async () => {
  const gate = new VideoProcessGate(1, 2, 2000);
  await assert.rejects(gate.withSlot(async () => { throw new Error('failed child'); }), /failed child/);
  assert.equal(await gate.withSlot(async () => 'reused'), 'reused');
  assert.equal(gate.status().active, 0);
});

test('video gate rejects over-capacity queue and times out waiting work', async () => {
  const gate = new VideoProcessGate(1, 1, 30);
  let release;
  const first = gate.withSlot(() => new Promise(resolve => { release = resolve; }));
  await delay(0);
  const queued = gate.withSlot(async () => 'not executed');
  await assert.rejects(gate.withSlot(async () => 'must not run'), /queue is full/);
  await assert.rejects(queued, /slot wait timed out/);
  release('completed');
  assert.equal(await first, 'completed');
  assert.deepEqual([gate.status().active, gate.status().queued], [0, 0]);
});

test('video subprocess cap rejects invalid configuration', () => {
  assert.throws(() => new VideoProcessGate(0), /Invalid/);
  assert.throws(() => new VideoProcessGate(9), /Invalid/);
});

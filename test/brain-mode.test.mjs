import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readBrainMode, writeBrainMode, isBrainOnlyActive, isDelegationBlocked, brainModeFile } from '../dist/brain-only.js';

const dir = mkdtempSync(join(tmpdir(), 'brain-mode-'));
test.after(() => rmSync(dir, { recursive: true, force: true }));

test('missing file defaults to harness (blocking)', () => {
  const f = join(dir, 'missing.json');
  assert.equal(readBrainMode(f), 'harness');
  assert.equal(isBrainOnlyActive({}, f), true);
});

test('write direct then read direct; switching back takes effect', () => {
  const f = join(dir, 'sub', 'mode.json');
  assert.equal(writeBrainMode('direct', f).mode, 'direct');
  assert.equal(readBrainMode(f), 'direct');
  assert.equal(isBrainOnlyActive({}, f), false);
  writeBrainMode('harness', f);
  assert.equal(readBrainMode(f), 'harness');
});

test('invalid JSON or invalid mode => harness', () => {
  const f = join(dir, 'bad.json');
  writeFileSync(f, '{not json');
  assert.equal(readBrainMode(f), 'harness');
  writeFileSync(f, JSON.stringify({ mode: 'whatever' }));
  assert.equal(readBrainMode(f), 'harness');
});

test('NHD_BRAIN_ONLY=0 overrides; bogus mode rejected; env file path', () => {
  assert.equal(isBrainOnlyActive({ NHD_BRAIN_ONLY: '0' }, join(dir, 'missing.json')), false);
  assert.throws(() => writeBrainMode('bogus', join(dir, 'x.json')));
  assert.equal(brainModeFile({ NHD_BRAIN_MODE_FILE: 'Z:/m.json' }), 'Z:/m.json');
});

test('self mode: tools open, delegation blocked', () => {
  const f = join(dir, 'self', 'mode.json');
  writeBrainMode('self', f);
  assert.equal(readBrainMode(f), 'self');
  assert.equal(isBrainOnlyActive({}, f), false);
  assert.equal(isDelegationBlocked({}, f), true);
  assert.equal(isDelegationBlocked({ NHD_BRAIN_ONLY: '0' }, f), true);
  writeBrainMode('harness', f);
  assert.equal(isDelegationBlocked({}, f), false);
  writeBrainMode('direct', f);
  assert.equal(isDelegationBlocked({}, f), false);
});


test('rapid mode changes are visible to repeated readers without stale cache', () => {
  const f = join(dir, 'shared', 'brain-mode.json');
  for (const mode of ['harness','self','harness','self','direct','self']) {
    writeBrainMode(mode, f);
    assert.equal(readBrainMode(f), mode);
  }
  assert.equal(isBrainOnlyActive({}, f), false);
  assert.equal(isDelegationBlocked({}, f), true);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  brainOnlyAllows, isBrainDetached, brainDetachedAllows, brainDetachedDenied,
  writeBrainMode, readBrainMode, isBrainOnlyActive, isDelegationBlocked,
} from '../dist/brain-only.js';

const root = new URL('../', import.meta.url);
const source = (name) => readFileSync(new URL(name, root), 'utf8');

test('harness_mode is available while BRAIN_ONLY rejects filesystem reads', () => {
  assert.equal(brainOnlyAllows('harness_mode'), true);
  assert.equal(brainOnlyAllows('fs_read'), false);
  assert.equal(brainOnlyAllows('fs_preview_write'), false);
});

test('Mode 2 allows direct MCP operations but disallows worker submission', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nhd-harness-mode-'));
  try {
    const file = join(dir, 'brain-mode.json');
    writeBrainMode('harness', file);
    assert.equal(isBrainOnlyActive({}, file), true);
    writeBrainMode('self', file);
    assert.equal(readBrainMode(file), 'self');
    assert.equal(isBrainOnlyActive({}, file), false);
    assert.equal(isDelegationBlocked({}, file), true);
    assert.equal(isDelegationBlocked({ NHD_BRAIN_ONLY: '0' }, file), true);
    writeBrainMode('direct', file);
    assert.equal(isBrainDetached(file), true);
    assert.equal(brainDetachedAllows('fs_read'), false);
    assert.equal(brainDetachedAllows('harness_mode'), true);
    assert.equal(brainDetachedDenied('fs_read').isError, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('MCP mode selection is task-bound and confirms before mutation', () => {
  const mcp = source('src/mcp.ts');
  const registry = source('src/mcp-registries/execution-tools.ts');
  assert.match(registry, /server\.registerTool\("harness_mode"/);
  assert.match(registry, /input\.confirmed !== true/);
  assert.match(registry, /task\.state !== "running"/);
  assert.match(registry, /authorizations\.allows\(input\.task_run_id, "moderate"\)/);
  assert.match(registry, /writeBrainMode\(input\.mode, file\)/);
  assert.match(mcp, /isBrainDetached\(\) && !brainDetachedAllows\(name\)/);
});

test('Dashboard mode switching does not depend on a live SBCE worker', () => {
  const server = source('src/server.ts');
  const api = server.slice(server.indexOf('app.get("/api/brain-mode"'), server.indexOf('app.get("/api/sbce/status"'));
  assert.ok(api.length > 100 && api.length < 4000, 'mode API segment exists');
  assert.doesNotMatch(api, /sbceReadGuard|sbceLocalGuard/);
  assert.match(api, /brainModeApiGuard/);
  assert.match(api, /BRAIN_MODE_CONFIRMATION_REQUIRED/);
  const ui = source('dashboard/brain-mode-panel.js');
  assert.match(ui, /confirmed: true/);
});

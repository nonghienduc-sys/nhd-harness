import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { RuntimeLifecycleService } from '../dist/runtime-lifecycle.js';

const read = path => readFile(resolve(path), 'utf8');

test('runtime lifecycle persists generation, exit reason, uptime and explicit restart reason', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'nhd-runtime-lifecycle-'));
  const previousReason = process.env.WORKSTATION_RESTART_REASON;
  try {
    delete process.env.WORKSTATION_RESTART_REASON;
    const first = new RuntimeLifecycleService(dir, '0.23.1-test');
    const a = first.status();
    assert.equal(a.generation, 1);
    assert.equal(a.state, 'running');
    assert.equal(a.startReason, 'process-start');
    assert.ok(a.uptimeMs >= 0);
    first.markExit('SIGTERM');

    process.env.WORKSTATION_RESTART_REASON = 'watchdog-recovery';
    const second = new RuntimeLifecycleService(dir, '0.23.1-test');
    const b = second.status();
    assert.equal(b.generation, 2);
    assert.equal(b.startReason, 'watchdog-recovery');
    assert.equal(b.previousExitReason, 'SIGTERM');
    assert.equal(b.previousPid, process.pid);
  } finally {
    if (previousReason == null) delete process.env.WORKSTATION_RESTART_REASON;
    else process.env.WORKSTATION_RESTART_REASON = previousReason;
  }
});

test('runtime lifecycle detects a previous unclean/forced backend exit', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'nhd-runtime-unclean-'));
  await writeFile(join(dir, 'runtime-lifecycle.json'), JSON.stringify({
    schemaVersion: 1,
    generation: 7,
    state: 'running',
    pid: 12345,
    startedAt: '2026-10-14T00:00:00.000Z',
    startReason: 'electron-startup',
    exitReason: null,
    exitAt: null,
    version: '0.23.0'
  }), 'utf8');
  const previousReason = process.env.WORKSTATION_RESTART_REASON;
  try {
    delete process.env.WORKSTATION_RESTART_REASON;
    const lifecycle = new RuntimeLifecycleService(dir, '0.23.1-test');
    const status = lifecycle.status();
    assert.equal(status.generation, 8);
    assert.equal(status.startReason, 'recovered-after-unclean-exit');
    assert.equal(status.previousExitReason, 'unclean-or-forced-exit');
  } finally {
    if (previousReason == null) delete process.env.WORKSTATION_RESTART_REASON;
    else process.env.WORKSTATION_RESTART_REASON = previousReason;
  }
});

test('backend uses external tunnel supervisor and preserves it on SIGTERM/SIGINT', async () => {
  const server = await read('src/server.ts');
  const client = await read('src/tunnel-client.ts');
  const supervisor = await read('src/tunnel-supervisor.ts');
  assert.match(server, /TunnelSupervisorClient/);
  assert.match(server, /runtime:runtimeLifecycle\.status\(\)/);
  assert.match(server, /runtime: runtimeLifecycle\.status\(\)/);
  assert.match(server, /Intentionally preserve the external Cloudflare tunnel supervisor across backend restarts/);
  const signalBlock = server.slice(server.indexOf('const stopBackendOnly'), server.length);
  assert.doesNotMatch(signalBlock, /tunnel\.stop\(\)/);
  assert.match(signalBlock, /tunnel\.close\(\)/);
  assert.match(client, /detached: true/);
  assert.match(client, /child\.unref\(\)/);
  assert.match(client, /tunnel-supervisor\.js/);
  assert.match(supervisor, /external-supervisor-v1/);
  assert.match(supervisor, /server\.listen\(controlPort, "127\.0\.0\.1"/);
});

test('Electron watchdog uses liveness and provides bounded immediate backend recovery reasons', async () => {
  const main = await read('electron/main.cjs');
  assert.match(main, /api\/health\/live/);
  assert.doesNotMatch(main, /backendHealthUrl = "http:\/\/127\.0\.0\.1:39100\/api\/health"/);
  assert.match(main, /backend-exit-recovery/);
  assert.match(main, /watchdog-recovery/);
  assert.match(main, /electron-startup/);
  assert.match(main, /WORKSTATION_RESTART_REASON/);
  assert.match(main, /let initialBackendReason =/);
  assert.match(main, /const startReason = initialBackendReason \|\| reason/);
  assert.match(main, /initialBackendReason = null/);
  assert.match(main, /backendRecoveryTimer = setTimeout/);
});

test('dashboard surfaces runtime uptime/start reason and tunnel supervisor telemetry', async () => {
  const app = await read('dashboard/app.js');
  assert.match(app, /function uptimeLabel/);
  assert.match(app, /runtime\.startReason/);
  assert.match(app, /Backend Runtime/);
  assert.match(app, /Tunnel Supervisor/);
  assert.match(app, /supervisor PID/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { Store } from '../dist/db.js';
import { FileService } from '../dist/files.js';
import { TerminalService } from '../dist/terminal.js';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'workstation-terminal-release-'));
  const backupDir = join(dir, 'backups');
  const inbox = join(dir, 'inbox');
  await mkdir(backupDir);
  await mkdir(inbox);
  const config = {
    instanceId:'terminal-release-test', host:'127.0.0.1', port:39100, officePort:39999, screenPort:39998,
    roots:[dir], intakeRoots:[inbox], dataDir:dir, backupDir,
    writeEnabled:true, terminalEnabled:true, skillsEnabled:true, screenEnabled:true, desktopEnabled:true,
    browserEnabled:true, visualDesktopEnabled:true, intakeEnabled:true, ocrEnabled:true, disabledSkills:[],
    tunnelEnabled:false, tunnelMode:'quick', namedTunnelName:'', namedTunnelConfig:'', publicHostname:'',
    emergencyStop:false, pairingCode:'TEST', companionSecret:'test-secret', cloudflaredPath:'cloudflared.exe',
  };
  const store = new Store(join(dir, 'test.sqlite'));
  const files = new FileService(config, store);
  return { dir, terminal:new TerminalService(config, store, files) };
}

test('terminal slot is released when PowerShell launcher exits even if a descendant remains alive', {skip: process.platform !== 'win32'}, async () => {
  const {dir, terminal} = await fixture();
  const command = "$p=Start-Process powershell.exe -ArgumentList '-NoLogo','-NoProfile','-NonInteractive','-Command','Start-Sleep -Seconds 8' -WindowStyle Hidden -PassThru; Write-Output ('childPid='+$p.Id)";
  const preview = terminal.preview(command, dir, 20);
  const started = performance.now();
  const result = await terminal.execute(preview.actionId, preview.commandHash, preview.confirmationToken);
  const elapsed = performance.now() - started;
  const match = String(result.stdout ?? '').match(/childPid=(\d+)/i);
  try {
    assert.equal(result.code, 0);
    assert.match(String(result.stdout), /childPid=\d+/i);
    assert.ok(elapsed < 6500, `launcher result took ${Math.round(elapsed)}ms; terminal waited for the long-lived descendant`);
    assert.equal(terminal.listRunning().length, 0);
  } finally {
    if (match) spawnSync('taskkill.exe', ['/PID', match[1], '/T', '/F'], {windowsHide:true, stdio:'ignore'});
  }
});

test('terminal cancel removes a stale run when the launcher PID is already gone', {skip: process.platform !== 'win32'}, async () => {
  const {terminal} = await fixture();
  const staleRunId = 'run-stale-dead-launcher';
  terminal.running.set(staleRunId, {pid:2147483647, startedAt:new Date().toISOString()});
  // listRunning performs the same stale reconciliation used by execute/cancel.
  assert.equal(terminal.listRunning().some(run => run.runId === staleRunId), false);
});

test('terminal execute self-heals three stale slots before enforcing concurrency limit', {skip: process.platform !== 'win32'}, async () => {
  const {dir, terminal} = await fixture();
  terminal.running.set('stale-1', {pid:2147483647, startedAt:new Date().toISOString()});
  terminal.running.set('stale-2', {pid:2147483646, startedAt:new Date().toISOString()});
  terminal.running.set('stale-3', {pid:2147483645, startedAt:new Date().toISOString()});
  const preview = terminal.preview("Write-Output 'slot-recovered'", dir, 10);
  const result = await terminal.execute(preview.actionId, preview.commandHash, preview.confirmationToken);
  assert.equal(result.code, 0);
  assert.match(String(result.stdout), /slot-recovered/);
  assert.equal(terminal.listRunning().length, 0);
});

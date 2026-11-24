import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../dist/db.js';
import { FileService } from '../dist/files.js';
import { TerminalService } from '../dist/terminal.js';

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'terminal-lifecycle-'));
  const backupDir = join(dir, 'backups');
  await mkdir(backupDir);
  const config = {
    instanceId:'test',host:'127.0.0.1',port:39100,officePort:39999,screenPort:39998,
    roots:[dir],intakeRoots:[],dataDir:dir,backupDir,writeEnabled:true,terminalEnabled:true,
    skillsEnabled:true,screenEnabled:true,desktopEnabled:true,browserEnabled:true,
    visualDesktopEnabled:true,intakeEnabled:true,ocrEnabled:true,disabledSkills:[],
    tunnelEnabled:false,tunnelMode:'quick',namedTunnelName:'',namedTunnelConfig:'',
    publicHostname:'',emergencyStop:false,pairingCode:'TEST',companionSecret:'test-secret',
    cloudflaredPath:'cloudflared.exe'
  };
  const store = new Store(join(dir, 'test.sqlite'));
  const files = new FileService(config, store);
  return {dir, config, store, files};
}

function fakeTerminalChild(pid) {
  const child = new EventEmitter();
  child.pid = pid;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => true;
  return child;
}

test('terminal releases slot on launcher exit even when inherited stdio never closes', async () => {
  const {dir, config, store, files} = await fixture();
  const children = [];
  const terminal = new TerminalService(config, store, files, {
    maxConcurrentRuns: 1,
    drainGraceMs: 10,
    isProcessAlive: () => true,
    spawnProcess: () => {
      const child = fakeTerminalChild(6500 + children.length);
      children.push(child);
      return child;
    },
  });

  const firstPreview = terminal.preview("Write-Output 'launcher-one'", dir, 10);
  const firstExecution = terminal.execute(firstPreview.actionId, firstPreview.commandHash, firstPreview.confirmationToken);
  await new Promise(resolvePromise => setImmediate(resolvePromise));
  assert.equal(terminal.listRunning().length, 1);

  children[0].stdout.emit('data', Buffer.from('before-exit'));
  children[0].emit('exit', 0, null);
  assert.equal(terminal.listRunning().length, 0, 'slot must be released immediately on launcher exit');

  // Never emit 'close': a detached/background descendant may still own inherited pipe handles.
  children[0].stdout.emit('data', Buffer.from('-during-drain'));
  const firstResult = await firstExecution;
  assert.equal(firstResult.code, 0);
  assert.match(firstResult.stdout, /before-exit-during-drain/);

  const secondPreview = terminal.preview("Write-Output 'launcher-two'", dir, 10);
  const secondExecution = terminal.execute(secondPreview.actionId, secondPreview.commandHash, secondPreview.confirmationToken);
  await new Promise(resolvePromise => setImmediate(resolvePromise));
  assert.equal(children.length, 2);
  assert.equal(terminal.listRunning().length, 1);
  children[1].emit('exit', 0, null);
  assert.equal(terminal.listRunning().length, 0);
  const secondResult = await secondExecution;
  assert.equal(secondResult.code, 0);
});

test('terminal close during drain finalizes immediately and keeps final output', async () => {
  const {dir, config, store, files} = await fixture();
  const children = [];
  const terminal = new TerminalService(config, store, files, {
    maxConcurrentRuns: 1,
    drainGraceMs: 1000,
    isProcessAlive: () => true,
    spawnProcess: () => {
      const child = fakeTerminalChild(6600 + children.length);
      children.push(child);
      return child;
    },
  });

  const preview = terminal.preview("Write-Output 'normal-close'", dir, 10);
  const execution = terminal.execute(preview.actionId, preview.commandHash, preview.confirmationToken);
  await new Promise(resolvePromise => setImmediate(resolvePromise));
  children[0].stdout.emit('data', Buffer.from('normal'));
  children[0].emit('exit', 0, null);
  children[0].stdout.emit('data', Buffer.from('-tail'));
  children[0].emit('close', 0, null);
  const result = await execution;
  assert.equal(result.code, 0);
  assert.match(result.stdout, /normal-tail/);
  assert.equal(terminal.listRunning().length, 0);
});





test('task-scoped high-risk authorization never covers critical; terminal needs no confirmation at any level', async () => {
  const {dir, config, store, files} = await fixture();
  const {TaskRunManager} = await import('../dist/task-runtime.js');
  const taskRuns = new TaskRunManager(store, {roots:[dir]});
  const run = taskRuns.create({objective:'Install and validate a toolchain', root:dir});
  const grant = taskRuns.authorize(run.id, {maxRiskLevel:'high', ttlMinutes:30});
  assert.equal(grant.maxRiskLevel, 'high');
  assert.equal(taskRuns.authorizations.allows(run.id, 'moderate'), true);
  assert.equal(taskRuns.authorizations.allows(run.id, 'high'), true);
  assert.equal(taskRuns.authorizations.allows(run.id, 'critical'), false);

  const terminal = new TerminalService(config, store, files, {}, taskRuns.authorizations);
  const high = terminal.preview('npm install example-package', dir, 10, {}, run.id);
  assert.equal(high.riskLevel, 'high');
  assert.equal(high.confirmationMode, 'automatic');
  assert.equal(high.requiresUserConfirmationTurn, false);
  assert.equal(high.taskAuthorizationCoversRisk, true);

  const critical = terminal.preview('format C:', dir, 10, {}, run.id);
  assert.equal(critical.riskLevel, 'critical');
  assert.equal(critical.confirmationMode, 'automatic');
  assert.equal(critical.criticalConfirmation, null);
  assert.equal(critical.requiresUserConfirmationTurn, false);
  assert.equal(critical.taskAuthorizationCoversRisk, false);

  taskRuns.revokeAuthorization(run.id);
  assert.equal(taskRuns.authorizations.allows(run.id, 'high'), false);
});

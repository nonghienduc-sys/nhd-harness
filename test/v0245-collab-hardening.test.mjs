import test from 'node:test';
import assert from 'node:assert/strict';
import { linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Document, Packer, Paragraph } from 'docx';
import { Store } from '../dist/db.js';
import { FileService } from '../dist/files.js';
import { OfficeService } from '../dist/office.js';
import { ProjectService } from '../dist/project.js';
import { DocumentService } from '../dist/document.js';
import { WorkspaceContextService } from '../dist/workspace-memory.js';
import { TaskRunManager } from '../dist/task-runtime.js';
import { TaskAuthorizationService, HARD_DENY_CAPABILITIES } from '../dist/task-authorization.js';
import { ExecutionLaneService } from '../dist/execution-lanes.js';
import { CocCocBridgeService } from '../dist/coc-coc-bridge.js';
import {
  canonicalizeResourceList,
  describeFileResourceIdentity,
  setConfiguredRoots,
} from '../dist/resource-guard.js';

function createHarnessFixture() {
  const root = mkdtempSync(resolve('D:\\', 'nhd-v0245-adv-'));
  const outsideRoot = mkdtempSync(resolve('D:\\', 'nhd-v0245-outside-'));
  const dataDir = resolve(root, 'data');
  const backupDir = resolve(root, 'backups');
  const workspaceRoot = resolve(root, 'projects');
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(backupDir, { recursive: true });
  mkdirSync(workspaceRoot, { recursive: true });
  const config = {
    port: 0,
    roots: [root],
    intakeRoots: [root],
    dataDir,
    backupDir,
    projectWorkspaceRoot: workspaceRoot,
    writeEnabled: true,
    terminalEnabled: false,
    skillsEnabled: false,
    screenEnabled: false,
    desktopEnabled: false,
    browserEnabled: true,
    visualDesktopEnabled: false,
    intakeEnabled: false,
    ocrEnabled: false,
    emergencyStop: false,
    allowedOrigins: [],
  };
  setConfiguredRoots([root]);
  const store = new Store(resolve(dataDir, 'index.sqlite'));
  const executionLanes = new ExecutionLaneService(store, resolve(root, 'exchange'));
  const taskRuns = new TaskRunManager(store, { roots: [root] });
  const authorizations = new TaskAuthorizationService(store);
  const files = new FileService(config, store);
  const office = new OfficeService(config, store, files);
  const projects = new ProjectService(config, store, files);
  const documents = new DocumentService(config, store, files, projects, office);
  const workspaceMemory = new WorkspaceContextService(config, projects, taskRuns);
  const cocCoc = new CocCocBridgeService(store, authorizations);

  function createActiveTask(objective = 'Active workstation task', state = 'running') {
    const created = taskRuns.create({ objective, root });
    if (state === 'planned') return created;
    const started = taskRuns.start(created.id);
    if (state === 'running') return started;
    if (state === 'waiting_confirmation') {
      return taskRuns.beginStep(started.id, {
        route: 'files',
        description: 'Step awaiting confirmation',
        requiresConfirmation: true,
      });
    }
    if (state === 'paused') return taskRuns.pause(started.id);
    if (state === 'completed') return taskRuns.completeRun(started.id);
    if (state === 'failed') return taskRuns.failRun(started.id, 'forced failure');
    if (state === 'cancelled') return taskRuns.cancel(started.id, 'forced cancel');
    return started;
  }

  function cleanup() {
    try { workspaceMemory.close(); } catch {}
    try { store.db.close(); } catch {}
    try { rmSync(root, { recursive: true, force: true }); } catch {}
    try { rmSync(outsideRoot, { recursive: true, force: true }); } catch {}
  }

  return {
    root,
    outsideRoot,
    config,
    store,
    executionLanes,
    taskRuns,
    authorizations,
    files,
    office,
    projects,
    documents,
    workspaceMemory,
    cocCoc,
    createActiveTask,
    cleanup,
  };
}

test('(A) anonymous write vs anonymous write on the same file conflicts and fails closed', async () => {
  const f = createHarnessFixture();
  try {
    const docPath = resolve(f.root, 'shared-anon.docx');
    const docBuffer = await Packer.toBuffer(
      new Document({ sections: [{ children: [new Paragraph('Initial content')] }] }),
    );
    writeFileSync(docPath, docBuffer);

    const anonPreview1 = f.files.preview('write', { path: docPath, content: 'anon-1' });
    assert.ok(anonPreview1.actionId);

    const activeLocks = f.executionLanes.listLocks();
    assert.equal(activeLocks.length, 1);
    assert.equal(activeLocks[0].ownerKind, 'ephemeral');
    assert.match(activeLocks[0].taskRunId, /^ephemeral:pending:/);

    assert.throws(
      () => f.files.preview('write', { path: docPath, content: 'anon-2' }),
      /Resource is busy.*ephemeral:pending:/i,
    );
    assert.throws(
      () => f.office.previewEdit(docPath, { type: 'replace_text', find: 'Initial', replace: 'Office anon' }),
      /Resource is busy.*ephemeral:pending:/i,
    );
  } finally {
    f.cleanup();
  }
});

test('(B) anonymous vs task-scoped mutations conflict in both directions', async () => {
  const f = createHarnessFixture();
  try {
    const docPath = resolve(f.root, 'shared-both-dirs.docx');
    const docBuffer = await Packer.toBuffer(
      new Document({ sections: [{ children: [new Paragraph('Initial content')] }] }),
    );
    writeFileSync(docPath, docBuffer);

    // Direction 1: Anonymous preview holds lock -> Task A is blocked
    const anonPreview = f.files.preview('write', { path: docPath, content: 'anon-1' });
    const taskA = f.createActiveTask('Task A');
    assert.throws(
      () => f.files.preview('write', { path: docPath, content: 'task-a-write' }, taskA.id),
      /Resource is busy.*ephemeral:pending:/i,
    );
    assert.throws(
      () => f.executionLanes.acquireLock({
        resource: docPath,
        mode: 'write',
        taskRunId: taskA.id,
      }),
      /Resource is busy.*ephemeral:pending:/i,
    );

    const applied = f.files.apply(anonPreview.actionId, anonPreview.confirmationToken, 'write');
    assert.equal(applied.applied, true);
    assert.equal(f.executionLanes.listLocks().length, 0);

    // Direction 2: Task A holds lock -> Anonymous mutation is blocked
    f.executionLanes.acquireLock({
      resource: docPath,
      mode: 'write',
      taskRunId: taskA.id,
    });
    assert.throws(
      () => f.files.preview('write', { path: docPath, content: 'anon-after-task-lock' }),
      new RegExp(`locked by task ${taskA.id}`, 'i'),
    );
  } finally {
    f.cleanup();
  }
});

test('(C) preview/apply gap protection: wrong token or task hijack preserves lock; valid apply releases without leak', () => {
  const f = createHarnessFixture();
  try {
    const filePath = resolve(f.root, 'gap-target.txt');
    writeFileSync(filePath, 'v1', 'utf8');

    const p1 = f.files.preview('write', { path: filePath, content: 'v2' });
    assert.equal(f.executionLanes.listLocks().length, 1);

    // Wrong confirmation token fails closed and MUST NOT release the ephemeral lock
    assert.throws(
      () => f.files.apply(p1.actionId, 'wrong-token-12345', 'write'),
      /Invalid confirmation token/i,
    );
    assert.equal(f.executionLanes.listLocks().length, 1, 'Lock must remain active after bad token attempt');

    // Foreign task cannot hijack an anonymous preview during apply
    const taskA = f.createActiveTask('Task A hijacker');
    assert.throws(
      () => f.files.apply(p1.actionId, p1.confirmationToken, 'write', taskA.id),
      /Foreign pending file action denied: anonymous preview cannot be applied by task/i,
    );
    assert.equal(f.executionLanes.listLocks().length, 1, 'Lock must remain active after hijack attempt');

    // Valid apply succeeds and releases the ephemeral lock without leak
    const res = f.files.apply(p1.actionId, p1.confirmationToken, 'write');
    assert.equal(res.applied, true);
    assert.equal(f.executionLanes.listLocks().length, 0, 'Ephemeral lock must be released after apply');

    // Subsequent anonymous preview succeeds immediately
    const p2 = f.files.preview('write', { path: filePath, content: 'v3' });
    assert.ok(p2.actionId);
    f.files.apply(p2.actionId, p2.confirmationToken, 'write');
    assert.equal(f.executionLanes.listLocks().length, 0);
  } finally {
    f.cleanup();
  }
});

test('(D) stale ephemeral cleanup: expired pending or expired TTL claims are automatically purged', () => {
  const f = createHarnessFixture();
  try {
    const filePath = resolve(f.root, 'stale-target.txt');
    writeFileSync(filePath, 'v1', 'utf8');

    const p1 = f.files.preview('write', { path: filePath, content: 'v2' });
    assert.equal(f.executionLanes.listLocks().length, 1);

    // Simulate abandoned preview whose pending action expired
    f.store.db.prepare('UPDATE pending SET expires_at=? WHERE id=?').run(
      new Date(Date.now() - 10_000).toISOString(),
      p1.actionId,
    );

    // Next anonymous preview automatically reconciles and cleans up the stale ephemeral claim
    const p2 = f.files.preview('write', { path: filePath, content: 'v3' });
    assert.ok(p2.actionId);
    assert.notEqual(p2.actionId, p1.actionId);
    const locks = f.executionLanes.listLocks();
    assert.equal(locks.length, 1);
    assert.equal(locks[0].taskRunId, `ephemeral:pending:${p2.actionId}`);

    f.files.apply(p2.actionId, p2.confirmationToken, 'write');
    assert.equal(f.executionLanes.listLocks().length, 0);
  } finally {
    f.cleanup();
  }
});

test('(E) hardlink aliases converge on physical volume+inode identity while retaining canonicalPath diagnostics', async () => {
  const f = createHarnessFixture();
  try {
    const realFile = resolve(f.root, 'contract.docx');
    const docBuffer = await Packer.toBuffer(
      new Document({ sections: [{ children: [new Paragraph('Clause 1')] }] }),
    );
    writeFileSync(realFile, docBuffer);

    const hardlinkFile = resolve(f.root, 'contract-hardlink.docx');
    linkSync(realFile, hardlinkFile);

    const idReal = describeFileResourceIdentity(realFile, [f.root]);
    const idHardlink = describeFileResourceIdentity(hardlinkFile, [f.root]);

    assert.match(idReal.key, /^file:id:[0-9a-f]+:[0-9a-f]+$/);
    assert.equal(idReal.key, idHardlink.key);
    assert.equal(idReal.physicalId, idHardlink.physicalId);
    assert.match(idReal.canonicalPath, /^file:d:\//);

    const previewReal = f.files.preview('write', { path: realFile, content: 'updated' });
    const lockInfo = f.executionLanes.listLocks()[0];
    assert.equal(lockInfo.resource, idReal.key);
    assert.equal(lockInfo.canonicalPath, idReal.canonicalPath);
    assert.equal(lockInfo.physicalId, idReal.physicalId);

    assert.throws(
      () => f.files.preview('write', { path: hardlinkFile, content: 'via-hardlink' }),
      /Resource is busy/i,
    );
    assert.throws(
      () => f.office.previewEdit(hardlinkFile, { type: 'replace_text', find: 'Clause', replace: 'via-office-hardlink' }),
      /Resource is busy/i,
    );
    f.files.apply(previewReal.actionId, previewReal.confirmationToken, 'write');
  } finally {
    f.cleanup();
  }
});

test('(F) safe in-root junction/reparse alias converges on physical identity and blocks cross-alias writes', async () => {
  const f = createHarnessFixture();
  try {
    const subDir = resolve(f.root, 'real-dir');
    mkdirSync(subDir, { recursive: true });
    const realFile = resolve(subDir, 'contract.docx');
    const docBuffer = await Packer.toBuffer(
      new Document({ sections: [{ children: [new Paragraph('Clause 1')] }] }),
    );
    writeFileSync(realFile, docBuffer);

    const inRootJunction = resolve(f.root, 'junction-dir');
    symlinkSync(subDir, inRootJunction, 'junction');
    const junctionFile = resolve(inRootJunction, 'contract.docx');

    const idReal = describeFileResourceIdentity(realFile, [f.root]);
    const idJunction = describeFileResourceIdentity(junctionFile, [f.root]);

    assert.equal(idReal.key, idJunction.key);
    assert.equal(idReal.physicalId, idJunction.physicalId);
    assert.equal(idJunction.reparseResolved, true);
    assert.equal(idJunction.canonicalPath, idReal.canonicalPath);

    const previewReal = f.files.preview('write', { path: realFile, content: 'updated' });
    assert.throws(
      () => f.files.preview('write', { path: junctionFile, content: 'via-junction' }),
      /Resource is busy/i,
    );
    assert.throws(
      () => f.office.previewEdit(junctionFile, { type: 'replace_text', find: 'Clause', replace: 'via-office-junction' }),
      /Resource is busy/i,
    );
    f.files.apply(previewReal.actionId, previewReal.confirmationToken, 'write');
  } finally {
    f.cleanup();
  }
});

test('(G) reparse/junction escape outside configured roots is rejected before mutation', () => {
  const f = createHarnessFixture();
  try {
    const outsideTargetFile = resolve(f.outsideRoot, 'secret-outside.txt');
    writeFileSync(outsideTargetFile, 'outside secret', 'utf8');
    const escapeJunction = resolve(f.root, 'escape-junction');
    symlinkSync(f.outsideRoot, escapeJunction, 'junction');
    const escapedExistingPath = resolve(escapeJunction, 'secret-outside.txt');
    const escapedNewPath = resolve(escapeJunction, 'new-outside.txt');

    assert.throws(
      () => f.files.resolvePath(escapedExistingPath),
      /Symbolic links and junction traversal outside configured roots are blocked/i,
    );
    assert.throws(
      () => f.files.resolvePath(escapedNewPath),
      /Symbolic links and junction traversal outside configured roots are blocked/i,
    );
    assert.throws(
      () => f.files.preview('write', { path: escapedExistingPath, content: 'pwn' }),
      /Symbolic links and junction traversal outside configured roots are blocked/i,
    );
    assert.throws(
      () => f.files.preview('write', { path: escapedNewPath, content: 'pwn-new' }),
      /Symbolic links and junction traversal outside configured roots are blocked/i,
    );
    const taskA = f.createActiveTask('Task A');
    assert.throws(
      () => f.executionLanes.acquireLock({
        resource: escapedExistingPath,
        mode: 'write',
        taskRunId: taskA.id,
      }),
      /Symbolic links and junction traversal outside configured roots are blocked/i,
    );
  } finally {
    f.cleanup();
  }
});

test('(H) nonexistent target identity via safely-resolved parent + basename and pre->post creation lock bridging', () => {
  const f = createHarnessFixture();
  try {
    const realParent = resolve(f.root, 'parent-dir');
    mkdirSync(realParent, { recursive: true });
    const junctionParent = resolve(f.root, 'parent-alias');
    symlinkSync(realParent, junctionParent, 'junction');

    const newViaReal = resolve(realParent, 'NewReport.DOCX');
    const newViaJunction = resolve(junctionParent, '.\\newreport.docx');

    const descReal = describeFileResourceIdentity(newViaReal, [f.root]);
    const descJunction = describeFileResourceIdentity(newViaJunction, [f.root]);
    assert.equal(descReal.targetExists, false);
    assert.equal(descReal.key, descJunction.key);
    assert.equal(descReal.physicalId, descJunction.physicalId);
    assert.match(descReal.physicalId, /^parent-vol:[0-9a-f]+:ino:[0-9a-f]+\/newreport\.docx$/);

    // Concurrent anonymous create via real path vs junction path conflicts!
    const pCreate = f.files.preview('write', { path: newViaReal, content: 'created content' });
    assert.throws(
      () => f.files.preview('write', { path: newViaJunction, content: 'collide create' }),
      /Resource is busy/i,
    );

    f.files.apply(pCreate.actionId, pCreate.confirmationToken, 'write');
    assert.equal(f.executionLanes.listLocks().length, 0);

    // Pre-creation task lock bridges seamlessly to post-creation physical identity!
    const taskA = f.createActiveTask('Task A creator');
    const taskB = f.createActiveTask('Task B contender');
    const bridgedPath = resolve(realParent, 'bridged-target.txt');
    const bridgedAlias = resolve(junctionParent, 'bridged-target.txt');

    const preLock = f.executionLanes.acquireLock({
      resource: bridgedPath,
      mode: 'write',
      taskRunId: taskA.id,
    });
    assert.match(preLock.resource, /^file:d:\//);

    writeFileSync(bridgedPath, 'materialized', 'utf8');
    const postDesc = describeFileResourceIdentity(bridgedPath, [f.root]);
    assert.equal(postDesc.targetExists, true);
    assert.match(postDesc.key, /^file:id:/);

    assert.throws(
      () => f.files.preview('write', { path: bridgedAlias, content: 'taskB hijack' }, taskB.id),
      new RegExp(`locked by task ${taskA.id}`, 'i'),
    );
    assert.throws(
      () => f.files.preview('write', { path: bridgedPath, content: 'anon hijack' }),
      new RegExp(`locked by task ${taskA.id}`, 'i'),
    );
    f.executionLanes.releaseLock(preLock.id, taskA.id);
  } finally {
    f.cleanup();
  }
});

test('(I) cross-route FS / Office / Semantic Document physical conflict across hardlink and junction aliases', async () => {
  const f = createHarnessFixture();
  try {
    const projRoot = resolve(f.root, 'doc-proj');
    mkdirSync(projRoot, { recursive: true });
    const pInit = f.projects.previewInit(projRoot, 'DocProj', 'document');
    f.projects.applyInit(pInit.actionId, pInit.confirmationToken);

    const docPath = resolve(projRoot, 'spec.docx');
    const docHardlink = resolve(projRoot, 'spec-link.docx');
    const docBuf = await Packer.toBuffer(
      new Document({
        sections: [{
          children: [
            new Paragraph({ text: '1. Scope' }),
            new Paragraph({ text: 'Original body paragraph.' }),
          ],
        }],
      }),
    );
    writeFileSync(docPath, docBuf);
    linkSync(docPath, docHardlink);

    const indexed = await f.documents.index(projRoot, docPath);
    const nodes = f.projects.getNodes(projRoot, indexed.documentId);
    const targetNode = nodes[0].id;

    // Semantic Document preview on canonical path blocks anonymous FS write and Office edit on hardlink alias!
    const semPreview = await f.documents.previewReplace(projRoot, indexed.documentId, targetNode, [
      { type: 'paragraph', text: 'Updated body paragraph.' },
    ]);
    assert.throws(
      () => f.files.preview('write', { path: docHardlink, content: 'bypass via hardlink' }),
      /Resource is busy/i,
    );
    assert.throws(
      () => f.office.previewEdit(docHardlink, { type: 'replace_text', find: 'Original', replace: 'bypass via office hardlink' }),
      /Resource is busy/i,
    );
    await f.documents.applyReplace(semPreview.actionId, semPreview.confirmationToken);
    assert.equal(f.executionLanes.listLocks().length, 0);
  } finally {
    f.cleanup();
  }
});

test('(J) anonymous Browser/Cốc Cốc in-flight tab mutations and Project-Memory/Decision mutations conflict when overlapping', async () => {
  const f = createHarnessFixture();
  try {
    f.cocCoc.pulse({
      tabId: 55,
      windowId: 1,
      url: 'https://example.com/form',
      title: 'Example Form',
      active: true,
      focused: true,
      visible: true,
      bridgeVersion: '0.24.5',
    });

    const inspectPromise = f.cocCoc.inspect('', 20, 55);
    const inspectPoll = f.cocCoc.pulse({
      tabId: 55,
      windowId: 1,
      url: 'https://example.com/form',
      title: 'Example Form',
    });
    f.cocCoc.resolveResult({
      id: inspectPoll.commands[0].id,
      ok: true,
      result: {
        page: { title: 'Example Form', url: 'https://example.com/form' },
        controls: [
          {
            selectorId: 'sel-input-1',
            tag: 'input',
            role: 'textbox',
            name: 'search',
            text: '',
            type: 'text',
            href: '',
            value: '',
            disabled: false,
            formAssociated: false,
            download: false,
          },
        ],
        total: 1,
        truncated: false,
      },
    });
    await inspectPromise;

    const fill1Promise = f.cocCoc.fill('sel-input-1', 'first anonymous fill');

    await assert.rejects(
      () => f.cocCoc.fill('sel-input-1', 'second concurrent anonymous fill'),
      /Resource is busy.*browser:coccoc:tab:55/i,
    );
    const taskA = f.createActiveTask('Task A browser contender');
    await assert.rejects(
      () => f.cocCoc.fill('sel-input-1', 'task A concurrent fill', taskA.id),
      /Resource is busy.*browser:coccoc:tab:55/i,
    );

    const fillPoll = f.cocCoc.pulse({
      tabId: 55,
      windowId: 1,
      url: 'https://example.com/form',
      title: 'Example Form',
    });
    f.cocCoc.resolveResult({
      id: fillPoll.commands[0].id,
      ok: true,
      result: { ok: true },
    });
    const fill1Res = await fill1Promise;
    assert.equal(fill1Res.ok, true);
    assert.equal(f.executionLanes.listLocks().length, 0);

    // Project-Memory / Decision anonymous concurrency
    const projRoot = resolve(f.root, 'mem-proj');
    mkdirSync(projRoot, { recursive: true });
    const initP = f.projects.previewInit(projRoot, 'MemProj', 'research');
    f.projects.applyInit(initP.actionId, initP.confirmationToken);

    const memP1 = f.projects.previewMemoryUpdate(projRoot, 'memory', '# Updated by anon 1\n');
    assert.throws(
      () => f.projects.previewMemoryUpdate(projRoot, 'memory', '# Updated by anon 2\n'),
      /Resource is busy/i,
    );
    assert.throws(
      () => f.workspaceMemory.checkpoint(projRoot, { summary: 'Concurrent semantic checkpoint', kind: 'semantic' }),
      /Resource is busy/i,
    );
    f.projects.applyMemoryUpdate(memP1.actionId, memP1.confirmationToken);

    const cp = f.workspaceMemory.checkpoint(projRoot, { summary: 'Clean semantic checkpoint', kind: 'semantic' });
    assert.equal(cp.stored, true);
    assert.equal(f.executionLanes.listLocks().length, 0);
  } finally {
    f.cleanup();
  }
});

test('(K) restart recovery, emergency stop, and TTL expiry clean up both task-scoped and ephemeral locks', () => {
  const f = createHarnessFixture();
  try {
    const fileA = resolve(f.root, 'alpha.txt');
    const fileB = resolve(f.root, 'beta.txt');
    writeFileSync(fileA, 'alpha', 'utf8');
    writeFileSync(fileB, 'beta', 'utf8');

    const task1 = f.createActiveTask('Task 1');
    f.executionLanes.acquireLock({ resource: fileA, mode: 'write', taskRunId: task1.id });
    f.files.preview('write', { path: fileB, content: 'beta-anon' });
    assert.equal(f.executionLanes.listLocks().length, 2);

    const stopRes = f.taskRuns.pauseForEmergencyStop('Emergency drill');
    assert.equal(stopRes, 1);
    assert.equal(f.executionLanes.listLocks().length, 0, 'Emergency stop must purge both task and ephemeral locks');

    const task2 = f.createActiveTask('Task 2 before restart');
    f.executionLanes.acquireLock({ resource: fileA, mode: 'write', taskRunId: task2.id });
    f.files.preview('write', { path: fileB, content: 'beta-anon-2' });
    assert.equal(f.executionLanes.listLocks().length, 2);

    f.taskRuns.recoverAfterRestart();
    assert.equal(f.executionLanes.listLocks().length, 0, 'Restart recovery must purge all locks');
  } finally {
    f.cleanup();
  }
});

test('(L) v0.24.4 invariants preserved across physical identities: fake task IDs rejected, READ+READ, renew/upgrade, multi-resource ordering, capability hard-deny', () => {
  const f = createHarnessFixture();
  try {
    const fileA = resolve(f.root, 'alpha.txt');
    const fileB = resolve(f.root, 'beta.txt');
    writeFileSync(fileA, 'alpha', 'utf8');
    writeFileSync(fileB, 'beta', 'utf8');
    const fileAHardlink = resolve(f.root, 'alpha-link.txt');
    linkSync(fileA, fileAHardlink);

    // Fake ephemeral task IDs cannot be passed to acquireLock or releaseLock
    assert.throws(
      () => f.executionLanes.acquireLock({
        resource: fileA,
        mode: 'write',
        taskRunId: 'ephemeral:op:fake123456',
      }),
      /ephemeral owner IDs cannot be used as durable taskRunIds/i,
    );

    // READ + READ coexistence across physical hardlink aliases
    const task1 = f.createActiveTask('Reader 1');
    const task2 = f.createActiveTask('Reader 2');
    const r1 = f.executionLanes.acquireLock({ resource: fileA, mode: 'read', taskRunId: task1.id });
    const r2 = f.executionLanes.acquireLock({ resource: fileAHardlink, mode: 'read', taskRunId: task2.id });
    assert.equal(r1.resource, r2.resource);
    f.executionLanes.releaseLock(r2.id, task2.id);

    // Same-owner idempotent renew and read -> write -> exclusive upgrade across hardlink alias
    const upgradedWrite = f.executionLanes.acquireLock({ resource: fileAHardlink, mode: 'write', taskRunId: task1.id });
    assert.equal(upgradedWrite.id, r1.id);
    assert.equal(upgradedWrite.mode, 'write');
    assert.equal(upgradedWrite.upgraded, true);

    const upgradedExcl = f.executionLanes.acquireLock({ resource: fileA, mode: 'exclusive', taskRunId: task1.id });
    assert.equal(upgradedExcl.id, r1.id);
    assert.equal(upgradedExcl.mode, 'exclusive');

    // Multi-resource deterministic ordering across physical identities
    const list1 = canonicalizeResourceList([fileB, fileAHardlink]);
    const list2 = canonicalizeResourceList([fileA, fileB]);
    assert.deepEqual(list1, list2);

    // Capability Lease hard-deny remains enforced
    for (const denied of HARD_DENY_CAPABILITIES) {
      assert.throws(
        () => f.authorizations.grantCapability(task1.id, {
          appScope: 'domain:example.com',
          actions: [denied],
        }),
        /platform-hard-denied|hard-denied|not allowed|unsupported/i,
      );
    }
  } finally {
    f.cleanup();
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Document, Packer, Paragraph } from 'docx';
import { Store } from '../dist/db.js';
import { FileService } from '../dist/files.js';
import { OfficeService } from '../dist/office.js';
import { ProjectService } from '../dist/project.js';
import { DocumentService } from '../dist/document.js';
import { WorkspaceContextService } from '../dist/workspace-memory.js';
import { TaskRunManager } from '../dist/task-runtime.js';
import { TaskAuthorizationService } from '../dist/task-authorization.js';
import { ExecutionLaneService } from '../dist/execution-lanes.js';
import { CocCocBridgeService } from '../dist/coc-coc-bridge.js';
import { BrowserService } from '../dist/browser.js';
import { canonicalizeResourceKey, canonicalizeResourceList } from '../dist/resource-guard.js';

function createHarnessFixture() {
  const root = mkdtempSync(resolve('D:\\', 'nhd-v0244-adv-'));
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
  const browser = new BrowserService(config, store);

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
  }

  return {
    root,
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
    browser,
    createActiveTask,
    cleanup,
  };
}

test('A & B: foreign lock and reservation release without owner or with wrong owner are rejected (fail closed)', () => {
  const f = createHarnessFixture();
  try {
    const taskA = f.createActiveTask('Task A owner');
    const taskB = f.createActiveTask('Task B foreign caller');

    const lock = f.executionLanes.acquireLock({
      resource: 'file:D:/Project/Report.docx',
      mode: 'write',
      taskRunId: taskA.id,
      lane: 'background',
    });
    const reservation = f.executionLanes.reserve({
      lane: 'background',
      taskRunId: taskA.id,
      stepId: 'step-1',
    });

    // A: Release without owner -> rejected
    assert.throws(
      () => f.executionLanes.releaseLock(lock.id),
      /taskRunId is required.*ownerless release is forbidden/i,
    );
    assert.throws(
      () => f.executionLanes.releaseLock(lock.id, ''),
      /taskRunId is required.*ownerless release is forbidden/i,
    );
    assert.throws(
      () => f.executionLanes.releaseReservation(reservation.id),
      /taskRunId is required.*ownerless release is forbidden/i,
    );

    // B: Release with wrong owner or nonexistent owner -> rejected
    assert.throws(
      () => f.executionLanes.releaseLock(lock.id, taskB.id),
      /Foreign lock release denied/i,
    );
    assert.throws(
      () => f.executionLanes.releaseLock(lock.id, 'task-does-not-exist'),
      /Task run 'task-does-not-exist' does not exist/i,
    );
    assert.throws(
      () => f.executionLanes.releaseReservation(reservation.id, taskB.id),
      /Foreign reservation release denied/i,
    );

    // Ownership remains intact after rejected attempts
    assert.equal(f.executionLanes.listLocks().length, 1);
    assert.equal(f.executionLanes.listLocks()[0].taskRunId, taskA.id);
    assert.equal(f.executionLanes.listReservations().length, 1);

    // Legitimate owner release succeeds
    assert.equal(f.executionLanes.releaseLock(lock.id, taskA.id).released, true);
    assert.equal(f.executionLanes.releaseReservation(reservation.id, taskA.id).released, true);
    assert.equal(f.executionLanes.listLocks().length, 0);
  } finally {
    f.cleanup();
  }
});

test('C: Windows path alias, case, separator, prefix, and dot-segment variants map to one canonical lock key and reject traversal/ambiguous paths', () => {
  const f = createHarnessFixture();
  try {
    const taskA = f.createActiveTask('Task A lock holder');
    const taskB = f.createActiveTask('Task B alias caller');

    const variants = [
      'file:D:/Project/Report.docx',
      'file:d:/project/./Report.docx',
      'file:D:\\PROJECT\\sub\\..\\Report.docx',
      'doc:d:\\Project\\\\Report.docx\\',
      'office:D:/Project/./sub/../REPORT.DOCX',
      'D:\\Project\\Report.docx',
    ];
    for (const variant of variants) {
      assert.equal(canonicalizeResourceKey(variant), 'file:d:/project/report.docx', `Failed variant: ${variant}`);
    }

    const acquired = f.executionLanes.acquireLock({
      resource: variants[0],
      mode: 'write',
      taskRunId: taskA.id,
      lane: 'background',
    });
    assert.equal(acquired.resource, 'file:d:/project/report.docx');

    for (const alias of variants.slice(1)) {
      assert.throws(
        () =>
          f.executionLanes.acquireLock({
            resource: alias,
            mode: 'write',
            taskRunId: taskB.id,
            lane: 'background',
          }),
        /Resource is busy: file:d:\/project\/report\.docx is locked by task/i,
      );
    }

    // Reject relative, traversal-above-root, UNC, device namespace, and NUL paths
    for (const invalid of [
      'file:relative/report.docx',
      'file:./report.docx',
      'file:../report.docx',
      'file:D:/../../escape.docx',
      'file://server/share/report.docx',
      'file:\\\\?\\D:\\Project\\Report.docx',
    ]) {
      assert.throws(
        () => canonicalizeResourceKey(invalid),
        /Invalid|traversal|must be an absolute Windows drive path|forbidden|UNC and device paths/i,
      );
    }
  } finally {
    f.cleanup();
  }
});

test('D: nonexistent and non-active task states (planned, paused, completed, failed, cancelled, expired) cannot acquire or renew locks', () => {
  const f = createHarnessFixture();
  try {
    // Nonexistent task
    assert.throws(
      () =>
        f.executionLanes.acquireLock({
          resource: 'file:D:/Project/A.docx',
          mode: 'write',
          taskRunId: 'task-does-not-exist',
          lane: 'background',
        }),
      /Task run 'task-does-not-exist' does not exist/i,
    );

    // Non-active states: planned, paused, completed, failed, cancelled
    for (const state of ['planned', 'paused', 'completed', 'failed', 'cancelled']) {
      const task = f.createActiveTask(`Task in ${state}`, state);
      assert.throws(
        () =>
          f.executionLanes.acquireLock({
            resource: `file:D:/Project/${state}.docx`,
            mode: 'write',
            taskRunId: task.id,
            lane: 'background',
          }),
        new RegExp(`Task run '${task.id}' is in state '${state}'; only active tasks`, 'i'),
      );
    }

    // Expired task (past deadline_at)
    const expiringTask = f.createActiveTask('Expiring task', 'running');
    const lockBeforeExpiry = f.executionLanes.acquireLock({
      resource: 'file:D:/Project/expiring.docx',
      mode: 'write',
      taskRunId: expiringTask.id,
      lane: 'background',
    });
    assert.ok(lockBeforeExpiry.id);
    f.store.db
      .prepare('UPDATE agent_runs SET deadline_at=? WHERE id=?')
      .run(new Date(Date.now() - 5_000).toISOString(), expiringTask.id);

    assert.throws(
      () =>
        f.executionLanes.acquireLock({
          resource: 'file:D:/Project/expiring.docx',
          mode: 'write',
          taskRunId: expiringTask.id,
          lane: 'background',
        }),
      /has expired|is in state 'expired'/i,
    );
    assert.equal(f.executionLanes.listLocks().length, 0);

    // Both allowed active states (running and waiting_confirmation) succeed
    const runningTask = f.createActiveTask('Running task', 'running');
    const waitingTask = f.createActiveTask('Waiting confirmation task', 'waiting_confirmation');
    assert.ok(
      f.executionLanes.acquireLock({
        resource: 'file:D:/Project/running-ok.docx',
        mode: 'write',
        taskRunId: runningTask.id,
        lane: 'background',
      }).id,
    );
    assert.ok(
      f.executionLanes.acquireLock({
        resource: 'file:D:/Project/waiting-ok.docx',
        mode: 'write',
        taskRunId: waitingTask.id,
        lane: 'background',
      }).id,
    );
  } finally {
    f.cleanup();
  }
});

test('E: end-to-end automatic enforcement prevents cross-tool write bypass between Filesystem, Office, and Semantic Document routes', async () => {
  const f = createHarnessFixture();
  try {
    const taskA = f.createActiveTask('Task A writer');
    const taskB = f.createActiveTask('Task B colliding writer');

    const docxPath = resolve(f.root, 'Shared-Contract.docx');
    const aliasPath = docxPath.replace(/\\/g, '/').replace('/Shared-Contract.docx', '/./shared-contract.docx');
    const docBuffer = await Packer.toBuffer(
      new Document({
        sections: [
          {
            children: [
              new Paragraph('CHƯƠNG I QUY ĐỊNH CHUNG'),
              new Paragraph('Điều 1. Phạm vi điều chỉnh'),
              new Paragraph('1. Nội dung gốc ban đầu.'),
            ],
          },
        ],
      }),
    );
    writeFileSync(docxPath, docBuffer);

    // 1. Task A calls Office previewEdit WITHOUT manually calling execution_lock
    const officePreview = f.office.previewEdit(
      docxPath,
      { type: 'replace_text', find: 'ban đầu', replace: 'đã cập nhật' },
      taskA.id,
    );
    assert.ok(officePreview.actionId);

    // Verify canonical lock was automatically acquired in Store
    const locksAfterOfficePreview = f.executionLanes.listLocks();
    assert.equal(locksAfterOfficePreview.length, 1);
    assert.equal(locksAfterOfficePreview[0].taskRunId, taskA.id);
    assert.equal(locksAfterOfficePreview[0].resource, canonicalizeResourceKey(docxPath));

    // 2. Task B tries to mutate the same file via Filesystem write/delete/move using an alias path -> BLOCKED!
    assert.throws(
      () => f.files.preview('write', { path: aliasPath, content: 'overwrite attempt' }, taskB.id),
      /Resource is busy/i,
    );
    assert.throws(
      () => f.files.preview('delete', { path: aliasPath }, taskB.id),
      /Resource is busy/i,
    );
    assert.throws(
      () => f.files.preview('move', { path: aliasPath, destination: resolve(f.root, 'Moved.docx') }, taskB.id),
      /Resource is busy/i,
    );
    // Even an ownerless/anonymous call without taskRunId cannot bypass Task A's lock!
    assert.throws(
      () => f.files.preview('write', { path: aliasPath, content: 'anonymous bypass' }),
      /Resource is busy/i,
    );

    // 3. Task B tries to mutate the same file via Office previewEdit or previewExport -> BLOCKED!
    assert.throws(
      () =>
        f.office.previewEdit(
          aliasPath,
          { type: 'replace_text', find: 'ban đầu', replace: 'task B hijack' },
          taskB.id,
        ),
      /Resource is busy/i,
    );
    assert.throws(
      () => f.office.previewExport('word', aliasPath, resolve(f.root, 'Out.pdf'), taskB.id),
      /Resource is busy/i,
    );

    // 4. Task A applies its Office edit and completes -> lock is automatically released
    const applied = await f.office.applyEdit(officePreview.actionId, officePreview.confirmationToken, taskA.id);
    assert.equal(applied.applied, true);
    f.taskRuns.completeRun(taskA.id);
    assert.equal(f.executionLanes.listLocks().length, 0);

    // 5. Reverse direction: Task B previews a Filesystem write on docxPath, blocking Task C on Semantic Document & Office
    const taskC = f.createActiveTask('Task C semantic doc writer');
    const proj = f.projects.autoInitTaskProject('Semantic Doc Project', 'document');
    const indexed = await f.documents.index(proj.root, docxPath, 'shared-contract', taskC.id);
    // Release Task C's index lock so Task B can lock the file via Filesystem
    f.executionLanes.releaseTaskResources(taskC.id, 'test_setup_clear');

    const fsPreviewB = f.files.preview('write', { path: aliasPath, content: 'pending write by B' }, taskB.id);
    assert.ok(fsPreviewB.actionId);

    // Task C attempting semantic document replace or index on docxPath is blocked by Task B's FS lock!
    await assert.rejects(
      () => f.documents.index(proj.root, docxPath, 'shared-contract', taskC.id),
      /Resource is busy/i,
    );
    assert.throws(
      () =>
        f.office.previewEdit(
          docxPath,
          { type: 'replace_text', find: 'Điều 1', replace: 'Điều 1 mới' },
          taskC.id,
        ),
      /Resource is busy/i,
    );
  } finally {
    f.cleanup();
  }
});

test('F: two tasks mutating the same browser tab/target are blocked while distinct tabs succeed', async () => {
  const f = createHarnessFixture();
  try {
    const taskA = f.createActiveTask('Task A browser');
    const taskB = f.createActiveTask('Task B browser');

    // Authorize both tasks for moderate Cốc Cốc actions
    f.authorizations.authorize(taskA.id, 'moderate');
    f.authorizations.authorize(taskB.id, 'moderate');

    const pulseTab = (tabId, active = true) =>
      f.cocCoc.pulse({
        tabId,
        windowId: 1,
        url: `https://example.com/tab-${tabId}`,
        title: `Tab ${tabId}`,
        active,
        focused: active,
        visible: true,
        bridgeVersion: '0.3.0',
      });

    pulseTab(10, true);
    pulseTab(20, false);

    async function inspectTab(tabId) {
      const p = f.cocCoc.inspect('', 20, tabId);
      const pulled = pulseTab(tabId, tabId === 10);
      f.cocCoc.resolveResult({
        id: pulled.commands[0].id,
        ok: true,
        result: {
          page: { title: `Tab ${tabId}`, url: `https://example.com/tab-${tabId}` },
          controls: [
            {
              selectorId: `sel-input-${tabId}`,
              tag: 'input',
              role: 'textbox',
              name: 'Search query',
              text: '',
              type: 'text',
              href: '',
              value: '',
              disabled: false,
              formAssociated: true,
              download: false,
              bounds: null,
            },
          ],
          total: 1,
          truncated: false,
        },
      });
      return p;
    }

    async function roundTripFill(tabId, selectorId, text, taskRunId) {
      const p = f.cocCoc.fill(selectorId, text, taskRunId);
      const pulled = pulseTab(tabId, tabId === 10);
      f.cocCoc.resolveResult({
        id: pulled.commands[0].id,
        ok: true,
        result: { ok: true, selectorId, characters: text.length },
      });
      return p;
    }

    const inspected10 = await inspectTab(10);
    const inspected20 = await inspectTab(20);
    const sel10 = inspected10.controls[0].selectorId;
    const sel20 = inspected20.controls[0].selectorId;

    // Task A mutates Tab 10 -> automatically locks browser:coccoc:tab:10
    await roundTripFill(10, sel10, 'Task A query', taskA.id);

    // Task B attempting to mutate Tab 10 -> rejected!
    await assert.rejects(
      () => f.cocCoc.fill(sel10, 'Task B colliding query', taskB.id),
      /Resource is busy: browser:coccoc:tab:10 is locked by task/i,
    );
    await assert.rejects(
      () => f.cocCoc.action({ action: 'scroll', tabId: 10, deltaY: 200, taskRunId: taskB.id }),
      /Resource is busy: browser:coccoc:tab:10 is locked by task/i,
    );

    // Task B mutating Tab 20 -> succeeds because Tab 20 is a different canonical resource!
    const fillTab20 = await roundTripFill(20, sel20, 'Task B independent tab 20', taskB.id);
    assert.equal(fillTab20.characters, 'Task B independent tab 20'.length);

    // Dedicated browser target conflict check
    f.executionLanes.acquireLock({
      resource: 'browser:dedicated:target:active',
      mode: 'write',
      taskRunId: taskA.id,
      lane: 'background',
    });
    await assert.rejects(
      () => f.browser.navigate('https://example.com', taskB.id),
      /Resource is busy: browser:dedicated:target:active is locked by task/i,
    );
  } finally {
    f.cleanup();
  }
});

test('G: two tasks mutating the same project-memory or decision scope are conflict-enforced', () => {
  const f = createHarnessFixture();
  try {
    const taskA = f.createActiveTask('Task A memory owner');
    const taskB = f.createActiveTask('Task B memory contender');

    const proj = f.projects.autoInitTaskProject('Shared Project Memory Test', 'software');

    // Task A checkpoints project memory -> automatically guards checkpoint + memory:workspace + memory:memory
    const cpA = f.workspaceMemory.checkpoint(
      proj.root,
      { summary: 'Task A architecture milestone', nextAction: 'Verify locks', objective: 'Upgrade locks' },
      taskA.id,
    );
    assert.equal(cpA.stored, true);

    // Task B attempting concurrent checkpoint, working-state mutation, or project memory update on the same project is rejected!
    assert.throws(
      () =>
        f.workspaceMemory.checkpoint(
          proj.root,
          { summary: 'Task B conflicting checkpoint' },
          taskB.id,
        ),
      /Resource is busy/i,
    );
    assert.throws(
      () =>
        f.workspaceMemory.recordWorkingState(
          proj.root,
          { operation: 'conflicting_op', status: 'running' },
          taskB.id,
        ),
      /Resource is busy/i,
    );
    assert.throws(
      () => f.projects.previewMemoryUpdate(proj.root, 'memory', '# Conflicting memory overwrite', taskB.id),
      /Resource is busy/i,
    );

    // Task A previews a project decision -> locks project decisions scope
    const decPreviewA = f.projects.previewDecision(
      proj.root,
      { title: 'Lock Policy', value: 'Fail closed', status: 'verified' },
      taskA.id,
    );
    assert.ok(decPreviewA.actionId);

    // Task B attempting to add a decision to the same project is rejected!
    assert.throws(
      () =>
        f.projects.previewDecision(
          proj.root,
          { title: 'Lock Policy', value: 'Advisory only', status: 'proposed' },
          taskB.id,
        ),
      /Resource is busy/i,
    );
  } finally {
    f.cleanup();
  }
});

test('H & I: READ+READ coexistence works and same-owner renew / read->write->exclusive upgrade are idempotent where safe', () => {
  const f = createHarnessFixture();
  try {
    const taskA = f.createActiveTask('Task A reader/upgrader');
    const taskB = f.createActiveTask('Task B co-reader');

    // H: READ + READ coexistence across alias paths
    const readA = f.executionLanes.acquireLock({
      resource: 'file:D:/Project/Spec.docx',
      mode: 'read',
      taskRunId: taskA.id,
      lane: 'background',
    });
    const readB = f.executionLanes.acquireLock({
      resource: 'file:d:/project/./spec.docx',
      mode: 'read',
      taskRunId: taskB.id,
      lane: 'isolated',
    });
    assert.ok(readA.id);
    assert.ok(readB.id);
    assert.notEqual(readA.id, readB.id);
    assert.equal(f.executionLanes.listLocks().length, 2);

    // I (unsafe upgrade): While Task B also holds a READ lock, Task A cannot upgrade READ -> WRITE
    assert.throws(
      () =>
        f.executionLanes.acquireLock({
          resource: 'file:D:/Project/Spec.docx',
          mode: 'write',
          taskRunId: taskA.id,
          lane: 'background',
        }),
      /Resource is busy/i,
    );

    // Release Task B's read lock; now Task A is the sole holder
    assert.equal(f.executionLanes.releaseLock(readB.id, taskB.id).released, true);

    // Same-owner READ renewal is idempotent
    const renewedRead = f.executionLanes.acquireLock({
      resource: 'file:d:/project/spec.docx',
      mode: 'read',
      taskRunId: taskA.id,
      lane: 'background',
    });
    assert.equal(renewedRead.id, readA.id);
    assert.equal(renewedRead.renewed, true);
    assert.equal(renewedRead.upgraded, false);
    assert.equal(renewedRead.mode, 'read');

    // Same-owner READ -> WRITE upgrade succeeds idempotently on the same lock ID
    const upgradedWrite = f.executionLanes.acquireLock({
      resource: 'file:D:/Project/Spec.docx',
      mode: 'write',
      taskRunId: taskA.id,
      lane: 'background',
    });
    assert.equal(upgradedWrite.id, readA.id);
    assert.equal(upgradedWrite.renewed, true);
    assert.equal(upgradedWrite.upgraded, true);
    assert.equal(upgradedWrite.mode, 'write');
    assert.equal(f.executionLanes.listLocks().length, 1);

    // Same-owner WRITE -> EXCLUSIVE upgrade succeeds idempotently
    const upgradedExclusive = f.executionLanes.acquireLock({
      resource: 'file:D:/Project/Spec.docx',
      mode: 'exclusive',
      taskRunId: taskA.id,
      lane: 'background',
    });
    assert.equal(upgradedExclusive.id, readA.id);
    assert.equal(upgradedExclusive.upgraded, true);
    assert.equal(upgradedExclusive.mode, 'exclusive');

    // Requesting READ when already holding EXCLUSIVE renews without downgrading
    const renewedExclusive = f.executionLanes.acquireLock({
      resource: 'file:D:/Project/Spec.docx',
      mode: 'read',
      taskRunId: taskA.id,
      lane: 'background',
    });
    assert.equal(renewedExclusive.id, readA.id);
    assert.equal(renewedExclusive.mode, 'exclusive');
    assert.equal(renewedExclusive.upgraded, false);
  } finally {
    f.cleanup();
  }
});

test('J & K: complete, fail, cancel, pause, emergency-stop, restart recovery, and TTL expiration automatically release locks', () => {
  const f = createHarnessFixture();
  try {
    const resource = 'file:D:/Project/Lifecycle.docx';

    // 1. Pause releases locks
    const tPause = f.createActiveTask('Task pause');
    f.executionLanes.acquireLock({ resource, mode: 'write', taskRunId: tPause.id, lane: 'background' });
    f.taskRuns.pause(tPause.id);
    assert.equal(f.executionLanes.listLocks().length, 0);

    // 2. Complete releases locks
    const tComplete = f.createActiveTask('Task complete');
    f.executionLanes.acquireLock({ resource, mode: 'write', taskRunId: tComplete.id, lane: 'background' });
    f.taskRuns.completeRun(tComplete.id);
    assert.equal(f.executionLanes.listLocks().length, 0);

    // 3. Fail releases locks
    const tFail = f.createActiveTask('Task fail');
    f.executionLanes.acquireLock({ resource, mode: 'write', taskRunId: tFail.id, lane: 'background' });
    f.taskRuns.failRun(tFail.id, 'error');
    assert.equal(f.executionLanes.listLocks().length, 0);

    // 4. Cancel releases locks
    const tCancel = f.createActiveTask('Task cancel');
    f.executionLanes.acquireLock({ resource, mode: 'write', taskRunId: tCancel.id, lane: 'background' });
    f.taskRuns.cancel(tCancel.id, 'cancelled');
    assert.equal(f.executionLanes.listLocks().length, 0);

    // 5. Emergency stop releases all locks
    const tEmergency = f.createActiveTask('Task emergency');
    f.executionLanes.acquireLock({ resource, mode: 'write', taskRunId: tEmergency.id, lane: 'background' });
    f.taskRuns.pauseForEmergencyStop('emergency_stop');
    assert.equal(f.executionLanes.listLocks().length, 0);

    // 6. Restart recovery (recoverAfterRestart) releases locks of interrupted running tasks
    const tRestart = f.createActiveTask('Task interrupted by restart');
    f.taskRuns.beginStep(tRestart.id, { route: 'files', description: 'In-flight write' });
    f.executionLanes.acquireLock({ resource, mode: 'write', taskRunId: tRestart.id, lane: 'background' });
    assert.equal(f.executionLanes.listLocks().length, 1);
    const recoveredCount = f.taskRuns.recoverAfterRestart();
    assert.equal(recoveredCount, 1);
    assert.equal(f.executionLanes.listLocks().length, 0);

    // 7. K: TTL / stale-lock cleanup releases expired locks automatically
    const tStale = f.createActiveTask('Task with stale TTL lock');
    const contender = f.createActiveTask('Contender task');
    const staleLock = f.executionLanes.acquireLock({
      resource,
      mode: 'write',
      taskRunId: tStale.id,
      lane: 'background',
      ttlSeconds: 5,
    });
    f.store.db
      .prepare('UPDATE execution_resource_locks SET expires_at=? WHERE id=?')
      .run(new Date(Date.now() - 1_000).toISOString(), staleLock.id);

    // Contender can immediately acquire the resource after TTL expiry
    const contenderLock = f.executionLanes.acquireLock({
      resource,
      mode: 'write',
      taskRunId: contender.id,
      lane: 'background',
    });
    assert.equal(contenderLock.taskRunId, contender.id);
    assert.equal(f.executionLanes.listLocks().length, 1);
  } finally {
    f.cleanup();
  }
});

test('L: multi-resource actions sort canonical keys deterministically and roll back atomically on partial conflict (deadlock-free)', () => {
  const f = createHarnessFixture();
  try {
    const taskA = f.createActiveTask('Task A multi-resource');
    const taskB = f.createActiveTask('Task B multi-resource');

    // Canonical list sorting is deterministic regardless of input order or casing
    const order1 = canonicalizeResourceList([
      'file:D:/Z_Last.docx',
      'file:d:/a_first.docx',
      'file:D:/M_Middle.docx',
      'doc:D:\\A_FIRST.docx',
    ]);
    const order2 = canonicalizeResourceList([
      'file:D:/M_Middle.docx',
      'file:D:/A_First.docx',
      'file:d:/z_last.docx',
    ]);
    assert.deepEqual(order1, ['file:d:/a_first.docx', 'file:d:/m_middle.docx', 'file:d:/z_last.docx']);
    assert.deepEqual(order1, order2);

    // Task B holds the last resource in the sorted order
    f.executionLanes.acquireLock({
      resource: 'file:D:/Z_Last.docx',
      mode: 'write',
      taskRunId: taskB.id,
      lane: 'background',
    });

    // Task A requests [A_First, M_Middle, Z_Last] in reverse order -> fails on Z_Last and rolls back A_First & M_Middle!
    assert.throws(
      () =>
        f.executionLanes.acquireLocks({
          resources: ['file:D:/Z_Last.docx', 'file:D:/M_Middle.docx', 'file:D:/A_First.docx'],
          mode: 'write',
          taskRunId: taskA.id,
          lane: 'background',
        }),
      /Resource is busy: file:d:\/z_last\.docx is locked by task/i,
    );
    // Verify Task A holds ZERO locks (atomic rollback prevented partial lock holding / deadlock)
    assert.deepEqual(
      f.executionLanes.listLocks().map((item) => item.taskRunId),
      [taskB.id],
    );

    // Once Task B releases Z_Last, Task A acquires all 3 in canonical sorted order
    f.executionLanes.releaseTaskResources(taskB.id, 'done');
    const batch = f.executionLanes.acquireLocks({
      resources: ['file:D:/Z_Last.docx', 'file:D:/M_Middle.docx', 'file:D:/A_First.docx'],
      mode: 'write',
      taskRunId: taskA.id,
      lane: 'background',
    });
    assert.deepEqual(
      batch.locks.map((item) => item.resource),
      ['file:d:/a_first.docx', 'file:d:/m_middle.docx', 'file:d:/z_last.docx'],
    );
    assert.deepEqual(
      batch.canonicalOrder,
      ['file:d:/a_first.docx', 'file:d:/m_middle.docx', 'file:d:/z_last.docx'],
    );
  } finally {
    f.cleanup();
  }
});

test('M: AsyncLocalStorage task context propagation (withTaskContext) and Capability Lease hard-deny invariants', () => {
  const f = createHarnessFixture();
  try {
    const taskA = f.createActiveTask('Task A via AsyncLocalStorage');
    const taskB = f.createActiveTask('Task B via AsyncLocalStorage');
    const targetFile = resolve(f.root, 'Context-Guarded.txt');

    // Task A runs inside store.withTaskContext without passing explicit taskRunId to files.preview
    const previewA = f.store.withTaskContext(taskA.id, () =>
      f.files.preview('write', { path: targetFile, content: 'context-propagated write' }),
    );
    assert.ok(previewA.actionId);
    assert.equal(f.executionLanes.listLocks().length, 1);
    assert.equal(f.executionLanes.listLocks()[0].taskRunId, taskA.id);

    // Task B running inside its own withTaskContext is automatically blocked on the same file
    assert.throws(
      () =>
        f.store.withTaskContext(taskB.id, () =>
          f.files.preview('write', { path: targetFile, content: 'colliding context write' }),
        ),
      /Resource is busy/i,
    );

    // Capability lease hard-deny invariants remain intact
    for (const denied of ['credentials', 'payment', 'transfer', 'purchase', 'call', 'script_protocol']) {
      assert.throws(
        () => f.authorizations.grantCapability(taskA.id, { appScope: 'domain:example.com', actions: [denied] }),
        /platform-hard-denied/i,
      );
    }
    assert.throws(
      () => f.authorizations.grantCapability(taskA.id, { appScope: '*', actions: ['submit'] }),
      /Wildcard app scopes are not allowed/i,
    );
  } finally {
    f.cleanup();
  }
});

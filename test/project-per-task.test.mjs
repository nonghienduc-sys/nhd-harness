import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../dist/db.js';
import { FileService } from '../dist/files.js';
import { ProjectService } from '../dist/project.js';
import { WorkspaceContextService } from '../dist/workspace-memory.js';

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'nhd-project-per-task-'));
  const backupDir = join(dir, 'backups');
  const projectWorkspaceRoot = join(dir, 'NHD Projects');
  await mkdir(backupDir, { recursive:true });
  const config = {
    instanceId:'test',host:'127.0.0.1',port:39100,officePort:39999,screenPort:39998,
    roots:[dir],intakeRoots:[],dataDir:join(dir,'data'),backupDir,projectWorkspaceRoot,
    writeEnabled:true,terminalEnabled:true,skillsEnabled:true,screenEnabled:true,desktopEnabled:true,
    browserEnabled:true,visualDesktopEnabled:true,intakeEnabled:true,ocrEnabled:true,disabledSkills:[],
    tunnelEnabled:false,tunnelMode:'quick',namedTunnelName:'',namedTunnelConfig:'',publicHostname:'',
    emergencyStop:false,pairingCode:'TEST',companionSecret:'test-secret',cloudflaredPath:'cloudflared.exe'
  };
  await mkdir(config.dataDir, { recursive:true });
  const store = new Store(join(dir, 'runtime.sqlite'));
  const files = new FileService(config, store);
  const projects = new ProjectService(config, store, files);
  const memory = new WorkspaceContextService(config, projects);
  return { dir, config, store, files, projects, memory };
}

test('auto task project creates physical folder/state and collision-safe sibling', async () => {
  const { config, projects, memory } = await fixture();
  const first = projects.autoInitTaskProject('Quarterly HTX honey report', 'mixed');
  assert.equal(first.autoCreated, true);
  assert.equal(first.root.startsWith(config.projectWorkspaceRoot), true);
  assert.equal((await stat(first.root)).isDirectory(), true);
  assert.equal((await stat(first.stateDir)).isDirectory(), true);
  const marker = JSON.parse(await readFile(join(first.root, '.nhd-project.json'), 'utf8'));
  assert.equal(marker.projectId, first.projectId);
  const registered = memory.recordWorkingState(first.root, { operation:'task_create', status:'planned', artifact:'task-one', source:'test' });
  assert.equal(registered.root, first.root);

  const second = projects.autoInitTaskProject('Quarterly HTX honey report', 'mixed');
  assert.notEqual(second.root, first.root);
  assert.equal((await stat(second.root)).isDirectory(), true);
  memory.close();
});

test('task marker and external file binding survive active-project changes', async () => {
  const { dir, projects, memory } = await fixture();
  const alpha = projects.autoInitTaskProject('Project Alpha', 'mixed');
  const beta = projects.autoInitTaskProject('Project Beta', 'mixed');
  const taskMarker = projects.bindTask(alpha.root, 'task-alpha', 'Project Alpha');
  assert.equal(taskMarker.taskId, 'task-alpha');
  const markerOnDisk = JSON.parse(await readFile(join(alpha.root, '.nhd-task.json'), 'utf8'));
  assert.equal(markerOnDisk.projectId, alpha.projectId);

  const externalDir = join(dir, 'external');
  await mkdir(externalDir, { recursive:true });
  const external = join(externalDir, 'source.docx');
  await writeFile(external, 'fixture', 'utf8');

  memory.recordWorkingState(alpha.root, { path:external, operation:'bind_source', status:'verified', source:'test' });
  memory.bootstrap(beta.root, { activate:true });
  const routed = memory.recordWorkingState(undefined, { path:external, operation:'edit_again', status:'verified', source:'test' });
  assert.equal(routed.root, alpha.root);

  const alphaBootstrap = memory.bootstrap(alpha.root, { activate:false });
  assert.equal(alphaBootstrap.workingState['working.current_document.path'], external);
  memory.close();
});

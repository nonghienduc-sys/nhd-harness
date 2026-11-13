import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../dist/db.js';
import { FileService } from '../dist/files.js';
import { TerminalService } from '../dist/terminal.js';
import { TerminalSessionManager } from '../dist/terminal-session.js';
import { TerminalSessionCoordinator } from '../dist/terminal-session-coordinator.js';

async function fixture(){
  const dir=await mkdtemp(join(tmpdir(),'nhd-terminal-session-exec-'));
  const backupDir=join(dir,'backups'); await mkdir(backupDir);
  const config={instanceId:'test',host:'127.0.0.1',port:39100,officePort:39999,screenPort:39998,roots:[dir],intakeRoots:[],dataDir:dir,backupDir,writeEnabled:true,terminalEnabled:true,skillsEnabled:true,screenEnabled:true,desktopEnabled:true,browserEnabled:true,visualDesktopEnabled:true,intakeEnabled:true,ocrEnabled:true,disabledSkills:[],tunnelEnabled:false,tunnelMode:'quick',namedTunnelName:'',namedTunnelConfig:'',publicHostname:'',emergencyStop:false,pairingCode:'TEST',companionSecret:'test',cloudflaredPath:'cloudflared.exe'};
  const store=new Store(join(dir,'test.sqlite'));
  const files=new FileService(config,store);
  const terminal=new TerminalService(config,store,files);
  const sessions=new TerminalSessionManager({roots:[dir],ttlMs:60_000});
  const coordinator=new TerminalSessionCoordinator(sessions,terminal);
  return {dir,coordinator};
}

test('session executes previewed steps sequentially and preserves approved environment context',async()=>{
  const {dir,coordinator}=await fixture();
  const session=coordinator.create(dir,{PYTHONUTF8:'1'});
  const p1=coordinator.preview(session.id,"Write-Output $env:PYTHONUTF8",10);
  const r1=await coordinator.execute(session.id,p1.preview.actionId,p1.preview.commandHash,p1.preview.confirmationToken);
  assert.equal(r1.result.code,0);
  assert.match(String(r1.result.stdout),/^1\s*$/m);
  assert.equal(r1.session.state,'open');
  assert.equal(r1.session.sequence,1);
  assert.equal(r1.session.history.length,1);
  assert.equal(r1.session.history[0].verified,true);

  const p2=coordinator.preview(session.id,"Write-Output 'second'",10);
  const r2=await coordinator.execute(session.id,p2.preview.actionId,p2.preview.commandHash,p2.preview.confirmationToken);
  assert.equal(r2.result.code,0);
  assert.match(String(r2.result.stdout),/second/);
  assert.equal(r2.session.sequence,2);
  assert.deepEqual(r2.session.history.map(x=>x.sequence),[1,2]);
});

test('invalid confirmation token never executes and marks session failed without automatic retry',async()=>{
  const {dir,coordinator}=await fixture();
  const session=coordinator.create(dir);
  const preview=coordinator.preview(session.id,"Write-Output 'should-not-run'",10);
  await assert.rejects(()=>coordinator.execute(session.id,preview.preview.actionId,preview.preview.commandHash,'wrong-token'),/token|pending|confirmation/i);
  const failed=coordinator.status(session.id);
  assert.equal(failed.state,'failed');
  assert.equal(failed.sequence,1);
  assert.equal(failed.history.length,1);
  assert.equal(failed.history[0].verified,false);
  assert.equal(failed.history[0].exitCode,-1);
});

test('critical session command still requires exact TerminalService confirmation phrase',async()=>{
  const {dir,coordinator}=await fixture();
  const session=coordinator.create(dir);
  const preview=coordinator.preview(session.id,"Remove-Item 'D:\\danger-test' -Recurse -Force",10);
  assert.equal(preview.preview.risk,'critical');
  await assert.rejects(()=>coordinator.execute(session.id,preview.preview.actionId,preview.preview.commandHash,preview.preview.confirmationToken,'wrong'),/confirmation phrase/i);
  assert.equal(coordinator.status(session.id).state,'failed');
});

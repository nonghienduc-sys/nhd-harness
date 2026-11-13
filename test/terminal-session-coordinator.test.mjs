import test from 'node:test';
import assert from 'node:assert/strict';
import { TerminalSessionManager } from '../dist/terminal-session.js';
import { TerminalSessionCoordinator } from '../dist/terminal-session-coordinator.js';

function fakeTerminal() {
  const calls=[];
  return {
    calls,
    preview(command,cwd,timeoutSeconds){
      calls.push({command,cwd,timeoutSeconds});
      return {actionId:'a1',confirmationToken:'t1',commandHash:'b'.repeat(64),risk:'normal',criticalConfirmation:null,cwd,timeoutSeconds};
    }
  };
}

function setup(){
  const sessions=new TerminalSessionManager({roots:['D:/workspace'],ttlMs:60_000});
  const terminal=fakeTerminal();
  return {sessions,terminal,coordinator:new TerminalSessionCoordinator(sessions,terminal)};
}

test('coordinator preview always uses session cwd and existing TerminalService preview',()=>{
  const {coordinator,terminal}=setup();
  const session=coordinator.create('D:/workspace/app');
  const out=coordinator.preview(session.id,"Write-Output 'ok'",30);
  assert.equal(out.session.id,session.id);
  assert.equal(out.preview.commandHash,'b'.repeat(64));
  assert.deepEqual(terminal.calls,[{command:"Write-Output 'ok'",cwd:'D:\\workspace\\app',timeoutSeconds:30}]);
});

test('coordinator preview does not begin or execute a session step',()=>{
  const {coordinator}=setup();
  const session=coordinator.create('D:/workspace');
  coordinator.preview(session.id,'Get-Location',10);
  const after=coordinator.status(session.id);
  assert.equal(after.state,'open');
  assert.equal(after.sequence,0);
  assert.equal(after.activeStep,null);
});

test('confirmed step identity must use preview command hash',()=>{
  const {coordinator}=setup();
  const session=coordinator.create('D:/workspace');
  const preview=coordinator.preview(session.id,'Get-Location',10);
  const busy=coordinator.beginConfirmedStep(session.id,preview.preview.commandHash);
  assert.equal(busy.state,'busy');
  assert.equal(busy.activeStep.commandHash,preview.preview.commandHash);
});

test('failed completion does not mutate cwd',()=>{
  const {coordinator}=setup();
  const session=coordinator.create('D:/workspace');
  const preview=coordinator.preview(session.id,"Write-Output 'failed step'",10);
  const busy=coordinator.beginConfirmedStep(session.id,preview.preview.commandHash);
  const failed=coordinator.completeStep(session.id,{sequence:busy.activeStep.sequence,commandHash:preview.preview.commandHash,exitCode:1,verified:false,nextCwd:'D:/workspace/child'});
  assert.equal(failed.state,'failed');
  assert.equal(failed.cwd,'D:\\workspace');
});

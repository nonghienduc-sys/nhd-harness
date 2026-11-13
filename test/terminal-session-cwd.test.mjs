import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { TerminalSessionManager, TerminalSessionError } from '../dist/terminal-session.js';
import { TerminalSessionCoordinator } from '../dist/terminal-session-coordinator.js';

function fakeTerminal(){
  let previews=0;
  return {
    get previews(){return previews;},
    preview(command,cwd,timeout,environment){previews++;return {actionId:'a',confirmationToken:'t',commandHash:'e'.repeat(64),cwd,timeout,risk:'normal',criticalConfirmation:null,environmentNames:Object.keys(environment??{})};}
  };
}

test('setCwd updates persistent session cwd only inside configured roots',()=>{
  const m=new TerminalSessionManager({roots:['D:/workspace']});
  const s=m.create('D:/workspace/a');
  const moved=m.setCwd(s.id,'D:/workspace/b');
  assert.equal(moved.cwd,'D:\\workspace\\b');
  assert.throws(()=>m.setCwd(s.id,'C:/outside'),e=>e instanceof TerminalSessionError && e.code==='INVALID_CWD');
});

test('production-style session manager can require cwd to exist',async()=>{
  const root=await mkdtemp(join(tmpdir(),'nhd-session-cwd-'));
  const child=join(root,'child'); await mkdir(child);
  const m=new TerminalSessionManager({roots:[root],requireExistingCwd:true});
  const s=m.create(root);
  assert.equal(m.setCwd(s.id,child).cwd,resolve(child));
  assert.throws(()=>m.setCwd(s.id,join(root,'missing')),e=>e instanceof TerminalSessionError && e.code==='INVALID_CWD');
});

test('persistent session blocks shell cwd-changing commands and requires setCwd',()=>{
  const terminal=fakeTerminal();
  const sessions=new TerminalSessionManager({roots:['D:/workspace']});
  const c=new TerminalSessionCoordinator(sessions,terminal);
  const s=c.create('D:/workspace');
  assert.throws(()=>c.preview(s.id,'Set-Location D:/workspace/child',10),/set_cwd/i);
  assert.throws(()=>c.preview(s.id,'cd child',10),/set_cwd/i);
  assert.equal(terminal.previews,0);
  c.setCwd(s.id,'D:/workspace/child');
  c.preview(s.id,'Get-Location',10);
  assert.equal(terminal.previews,1);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../dist/db.js';
import { FileService } from '../dist/files.js';
import { TerminalService } from '../dist/terminal.js';

async function fixture(){
  const dir=await mkdtemp(join(tmpdir(),'nhd-terminal-context-'));
  const backupDir=join(dir,'backups'); await mkdir(backupDir);
  const config={instanceId:'test',host:'127.0.0.1',port:39100,officePort:39999,screenPort:39998,roots:[dir],intakeRoots:[],dataDir:dir,backupDir,writeEnabled:true,terminalEnabled:true,skillsEnabled:true,screenEnabled:true,desktopEnabled:true,browserEnabled:true,visualDesktopEnabled:true,intakeEnabled:true,ocrEnabled:true,disabledSkills:[],tunnelEnabled:false,tunnelMode:'quick',namedTunnelName:'',namedTunnelConfig:'',publicHostname:'',emergencyStop:false,pairingCode:'TEST',companionSecret:'test',cloudflaredPath:'cloudflared.exe'};
  const store=new Store(join(dir,'test.sqlite'));
  const files=new FileService(config,store);
  return {dir,terminal:new TerminalService(config,store,files)};
}

test('terminal preview binds approved environment names into command hash',async()=>{
  const {dir,terminal}=await fixture();
  const a=terminal.preview("Write-Output $env:PYTHONUTF8",dir,10,{PYTHONUTF8:'1'});
  const b=terminal.preview("Write-Output $env:PYTHONUTF8",dir,10,{PYTHONUTF8:'2'});
  assert.notEqual(a.commandHash,b.commandHash);
  assert.deepEqual(a.environmentNames,['PYTHONUTF8']);
  assert.deepEqual(b.environmentNames,['PYTHONUTF8']);
});

test('terminal execute receives exactly the preview-bound approved environment delta',async()=>{
  const {dir,terminal}=await fixture();
  const preview=terminal.preview("Write-Output $env:PYTHONUTF8",dir,10,{PYTHONUTF8:'1'});
  const result=await terminal.execute(preview.actionId,preview.commandHash,preview.confirmationToken);
  assert.equal(result.code,0);
  assert.match(String(result.stdout),/^1\s*$/m);
});

test('terminal preview blocks unapproved or control-character environment values',async()=>{
  const {dir,terminal}=await fixture();
  assert.throws(()=>terminal.preview('Get-Location',dir,10,{PATH:'C:/evil'}),/not allowed/i);
  assert.throws(()=>terminal.preview('Get-Location',dir,10,{NODE_ENV:'a\nb'}),/invalid value/i);
});

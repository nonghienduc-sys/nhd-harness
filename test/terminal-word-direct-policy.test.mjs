import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../dist/db.js';
import { FileService } from '../dist/files.js';
import { TerminalService } from '../dist/terminal.js';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'terminal-word-policy-'));
  const backupDir = join(dir, 'backups'); mkdirSync(backupDir);
  const config = { instanceId:'test',host:'127.0.0.1',port:39100,officePort:39999,screenPort:39998,
    roots:[dir],intakeRoots:[],dataDir:dir,backupDir,writeEnabled:true,terminalEnabled:true,skillsEnabled:true,screenEnabled:true,desktopEnabled:true,browserEnabled:true,
    visualDesktopEnabled:true,intakeEnabled:true,ocrEnabled:true,disabledSkills:[],tunnelEnabled:false,tunnelMode:'quick',namedTunnelName:'',namedTunnelConfig:'',publicHostname:'',emergencyStop:false,pairingCode:'TEST',companionSecret:'TEST',cloudflaredPath:'cloudflared.exe' };
  const store = new Store(join(dir,'test.sqlite')); const files = new FileService(config,store); const terminal = new TerminalService(config,store,files);
  return {dir,terminal};
}

test('blocks Invoke-Expression and IEX before execution', () => {
  const {dir,terminal}=fixture();
  assert.throws(()=>terminal.preview("Invoke-Expression $code",dir,10),/POWERSHELL_POLICY_BLOCKED/);
  assert.throws(()=>terminal.preview("iex ($x)",dir,10),/POWERSHELL_POLICY_BLOCKED/);
});

test('allows routine Word COM mutation as a standard terminal route', () => {
  const {dir,terminal}=fixture();
  const script=join(dir,'word-routine.ps1');
  writeFileSync(script, "$word=[Runtime.InteropServices.Marshal]::GetActiveObject('Word.Application')\n$doc=$word.ActiveDocument\n$r=$doc.Range($doc.Content.End-1,$doc.Content.End-1)\n$r.Text='Tiếng Việt'\n$r.Font.Bold=-1\n$r.ParagraphFormat.SpaceAfter=2\n", 'utf8');
  const preview=terminal.preview(`& '${script}'`,dir,180);
  assert.equal(preview.timeoutSeconds,180);
  assert.equal(preview.requestedTimeoutSeconds,180);
  assert.equal(preview.launchMode,'utf8_encoded_script');
  assert.equal(preview.terminalPolicy,'standard');
});

test('complex Word COM also uses the standard terminal timeout and policy', () => {
  const {dir,terminal}=fixture();
  const script=join(dir,'word-table.ps1');
  writeFileSync(script, "$word=[Runtime.InteropServices.Marshal]::GetActiveObject('Word.Application')\n$doc=$word.ActiveDocument\n$doc.Tables.Add($doc.Range(0,0),2,2)\n", 'utf8');
  const preview=terminal.preview(`& '${script}'`,dir,180);
  assert.equal(preview.timeoutSeconds,180);
  assert.equal(preview.requestedTimeoutSeconds,180);
  assert.equal(preview.launchMode,'utf8_encoded_script');
  assert.equal(preview.terminalPolicy,'standard');
});

test('standalone UTF-8 ps1 runs via EncodedCommand and preserves Vietnamese without BOM', async () => {
  const {dir,terminal}=fixture();
  const script=join(dir,'unicode.ps1');
  writeFileSync(script, "Write-Output 'Tiếng Việt – HS-482'\n", 'utf8');
  const preview=terminal.preview(`& '${script}'`,dir,10);
  assert.equal(preview.launchMode,'utf8_encoded_script');
  const result=await terminal.execute(preview.actionId,preview.commandHash,preview.confirmationToken);
  assert.equal(result.code,0);
  assert.match(result.stdout,/Tiếng Việt – HS-482/);
});

test('generic PowerShell command launches in encoded UTF-8 mode', async () => {
  const {dir,terminal}=fixture();
  const preview=terminal.preview("Write-Output 'Đúng UTF-8'",dir,10);
  assert.equal(preview.launchMode,'utf8_encoded_command');
  const result=await terminal.execute(preview.actionId,preview.commandHash,preview.confirmationToken);
  assert.equal(result.code,0);
  assert.match(result.stdout,/Đúng UTF-8/);
});


test('blocks nested or argument-bearing ps1 invocation so Windows PowerShell cannot reinterpret file encoding', () => {
  const {dir,terminal}=fixture();
  const script=join(dir,'args.ps1');
  writeFileSync(script, "param([string]$Name)\nWrite-Output ('Xin chào '+$Name)\n", 'utf8');
  assert.throws(()=>terminal.preview(`powershell.exe -NoProfile -File '${script}' -Name test`,dir,30),/POWERSHELL_SCRIPT_RUNNER_REQUIRED/);
  assert.throws(()=>terminal.preview(`& '${script}' -Name test`,dir,30),/POWERSHELL_SCRIPT_RUNNER_REQUIRED/);
});


test('ASCII generic command keeps low-latency command mode while Unicode keeps encoded mode', () => {
  const {dir,terminal}=fixture();
  const ascii=terminal.preview("Write-Output 'ascii'",dir,10);
  const unicode=terminal.preview("Write-Output 'Tiếng Việt'",dir,10);
  assert.equal(ascii.launchMode,'command');
  assert.equal(unicode.launchMode,'utf8_encoded_command');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Store } from '../dist/db.js';
import { FileService } from '../dist/files.js';
import { BackgroundTurboService, isTurboSafePowerShell } from '../dist/background-turbo.js';
import { qaLevelForOperation } from '../dist/office.js';

function fixture(){
  const dir=mkdtempSync(join(tmpdir(),'nhd-background-turbo-')); const backupDir=join(dir,'backups');mkdirSync(backupDir);
  const config={instanceId:'turbo-test',host:'127.0.0.1',port:39990,officePort:39991,screenPort:39992,roots:[dir],intakeRoots:[dir],dataDir:dir,backupDir,writeEnabled:true,terminalEnabled:true,skillsEnabled:true,screenEnabled:false,desktopEnabled:false,visualDesktopEnabled:false,intakeEnabled:true,ocrEnabled:true,disabledSkills:[],tunnelEnabled:false,tunnelMode:'quick',namedTunnelName:'',namedTunnelConfig:'',publicHostname:'',emergencyStop:false,pairingCode:'TEST',companionSecret:'TEST_SECRET',cloudflaredPath:'cloudflared.exe'};
  const store=new Store(join(dir,'test.sqlite')); const files=new FileService(config,store); const turbo=new BackgroundTurboService(store,files,undefined,process.cwd());
  return {dir,store,files,turbo,cleanup(){turbo.stop();try{store.db.close()}catch{};try{rmSync(dir,{recursive:true,force:true})}catch{}}};
}

test('PowerShell turbo allowlist is read-only and rejects mutation/shell escapes',()=>{
  assert.equal(isTurboSafePowerShell('Get-Date'),true);
  assert.equal(isTurboSafePowerShell('Test-Path .'),true);
  assert.equal(isTurboSafePowerShell('Get-ChildItem | Select-Object -First 2'),true);
  for(const cmd of ['Remove-Item x','Set-Content x y','Start-Process notepad','Get-Date; Remove-Item x','Get-Date > x','node -e "1"','python -c "1"','Get-Date $(whoami)']) assert.equal(isTurboSafePowerShell(cmd),false,cmd);
});

test('persistent warm PowerShell and Python workers execute bounded pure work',async()=>{
  const f=fixture();try{
    await f.turbo.prewarm();
    const ps1=await f.turbo.execPowerShellQuery('Get-Date',f.dir); const ps2=await f.turbo.execPowerShellQuery('Test-Path .',f.dir);
    assert.equal(ps1.code,0); assert.equal(ps2.code,0); assert.equal(ps1.turbo,true);
    const py=await f.turbo.pythonEval('sum(range(10))'); assert.equal(py.result,45);
    await assert.rejects(()=>f.turbo.pythonEval('__import__("os").system("whoami")'),/not allowed|blocked|Function|Private|Only math\/json\/re/i);
    const status=f.turbo.status(); assert.ok(status.workers.powershell.every(w=>w.online)); assert.equal(status.workers.python.online,true);
  }finally{f.cleanup()}
});

test('Python worker distinguishes sandbox request errors from transport health and recovers current status',async()=>{
  const f=fixture();try{
    await f.turbo.prewarm();
    await assert.rejects(()=>f.turbo.pythonEval('__import__(\"os\")'),/not allowed|blocked|Function|Private/i);
    let status=f.turbo.status().workers.python;
    assert.equal(status.online,true); assert.equal(status.healthy,true); assert.equal(status.failures,1); assert.equal(status.requestErrors,1); assert.equal(status.transportFailures,0); assert.equal(status.timeouts,0); assert.equal(status.consecutiveFailures,1); assert.equal(status.consecutiveTransportFailures,0); assert.equal(status.lastFailureKind,'request'); assert.ok(status.lastFailureAt);
    const ok=await f.turbo.pythonEval('40+2'); assert.equal(ok.result,42);
    status=f.turbo.status().workers.python;
    assert.equal(status.healthy,true); assert.equal(status.failures,1); assert.equal(status.requestErrors,1); assert.equal(status.consecutiveFailures,0); assert.equal(status.consecutiveTransportFailures,0); assert.ok(status.lastSuccessAt);
  }finally{f.cleanup()}
});

test('micro batch and DAG execute independent read operations concurrently and preserve dependencies',async()=>{
  const f=fixture();try{
    const file=join(f.dir,'a.txt');writeFileSync(file,'hello\nworld','utf8');await f.turbo.prewarm();
    const batch=await f.turbo.runBatch([{kind:'file_stat',path:file},{kind:'python_eval',code:'6*7'},{kind:'powershell_query',command:'Test-Path .',cwd:f.dir}],3);
    assert.equal(batch.ok,true);assert.equal(batch.results.op2.result,42);
    const dag=await f.turbo.runDag([{id:'a',op:{kind:'python_eval',code:'1+1'}},{id:'b',dependsOn:['a'],op:{kind:'file_read',path:file,startLine:1,endLine:1}}],2);
    assert.equal(dag.ok,true);assert.equal(dag.results.a.result,2);assert.match(dag.results.b.text,/hello/);
    await assert.rejects(()=>f.turbo.runDag([{id:'a',dependsOn:['b'],op:{kind:'python_eval',code:'1'}},{id:'b',dependsOn:['a'],op:{kind:'python_eval',code:'2'}}],2),/dependency cycle/);
  }finally{f.cleanup()}
});

test('zero-copy artifact handle fingerprints without copying bytes',()=>{
  const f=fixture();try{const file=join(f.dir,'artifact.txt');writeFileSync(file,'abc','utf8');const h=f.turbo.artifactHandle(file);assert.equal(h.zeroCopy,true);assert.match(h.handle,/^artifact:sha256:/);assert.equal(h.size,3);assert.equal(h.path,file);}finally{f.cleanup()}
});

test('adaptive Office QA requires visual review only for layout/formatting-sensitive operations',()=>{
  assert.equal(qaLevelForOperation({type:'word_append',blocks:[{text:'x'}]}),'structural');
  assert.equal(qaLevelForOperation({type:'word_append',blocks:[{text:'x',format:{fontName:'Times New Roman',fontSize:13}}]}),'visual');
  assert.equal(qaLevelForOperation({type:'word_insert_at_cursor',blocks:[{text:'x',format:{fontColorHex:'FF0000'}}]}),'visual');
  assert.equal(qaLevelForOperation({type:'word_format',scope:'selection',format:{bold:true}}),'visual');
  assert.equal(qaLevelForOperation({type:'word_save'}),'machine');
});

test('Office companion source uses a persistent bridge worker and protocol v3',()=>{
  const source=readFileSync(resolve(process.cwd(),'src','office-companion.ts'),'utf8');
  assert.match(source,/class OfficeBridgeWorker/);assert.match(source,/protocolVersion: 3/);assert.match(source,/office-bridge-worker\.ps1/);assert.match(source,/not replayed/i);
});

test('a missing Python executable reports a worker error without crashing the backend', async()=>{
  const f=fixture();try{
    f.turbo.pyWorker.spec.command=join(f.dir,'missing-python.exe');
    await assert.rejects(()=>f.turbo.pythonEval('1+1'),/failed to start.*ENOENT/);
    assert.equal(f.turbo.status().workers.python.online,false);
    assert.equal(f.turbo.status().workers.python.pending,0);
    assert.equal(f.turbo.status().workers.python.failures,1);
    assert.equal(f.turbo.status().workers.python.transportFailures,1);
    assert.equal(f.turbo.status().workers.python.healthy,false);
    assert.equal(f.turbo.status().workers.python.lastFailureKind,'transport');
  }finally{f.cleanup()}
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../dist/db.js';
import { FileService } from '../dist/files.js';
import { Document, Packer, Paragraph } from 'docx';

async function fixture(){
  const dir=await mkdtemp(join(tmpdir(),'nhd-index-watch-'));
  const store=new Store(join(dir,'workstation.sqlite'));
  const config={roots:[dir],projectWorkspaceRoot:dir,backupDir:join(dir,'backups'),emergencyStop:false,writeEnabled:true};
  const files=new FileService(config,store);
  return {dir,store,files};
}

test('single-path incremental refresh indexes changes and removes deleted stale entries',async()=>{
  const {dir,store,files}=await fixture();
  const path=join(dir,'note.txt');
  await writeFile(path,'alpha incremental marker','utf8');
  let result=await files.refreshIndexPath(path);
  assert.equal(result.status,'indexed');
  assert.equal(files.search('alpha',10).length,1);
  await new Promise(resolve=>setTimeout(resolve,20));
  await writeFile(path,'beta incremental marker updated','utf8');
  result=await files.refreshIndexPath(path);
  assert.equal(result.status,'indexed');
  assert.equal(files.search('beta',10).length,1);
  assert.equal(files.search('alpha',10).length,0);
  await rm(path);
  result=await files.refreshIndexPath(path);
  assert.equal(result.status,'removed');
  assert.equal(files.search('beta',10).length,0);
  store.db.close();
});

test('incremental watch can start and stop without changing file contents',async()=>{
  const {dir,store,files}=await fixture();
  const started=files.startWatch(dir);
  assert.equal(started.watching,true);
  assert.equal(started.roots.length,1);
  const stopped=files.stopWatch(dir);
  assert.equal(stopped.watching,false);
  assert.equal(stopped.pending,0);
  store.db.close();
});

test('FTS updates and deletes preserve other paths with identical tokenizer terms',()=>{
  const store=new Store(':memory:');
  try {
    const a='D:\\Du an tieng Viet\\read-me.txt';
    const b='D:\\Du an tieng Viet\\read_me.txt';
    const quoted='D:\\query\\a" OR content:everything ".txt';
    store.indexReplace(a,'text','firstuniquemarker',10,1);
    store.indexReplace(b,'text','seconduniquemarker',10,1);
    store.indexReplace(quoted,'text','thirduniquemarker',10,1);
    store.indexReplace(a,'text','updateduniquemarker',10,2);
    assert.equal(store.search('firstuniquemarker',10).length,0);
    assert.equal(store.search('seconduniquemarker',10).length,1);
    assert.equal(store.indexDelete(a),true);
    assert.equal(store.search('updateduniquemarker',10).length,0);
    assert.equal(store.search('seconduniquemarker',10).length,1);
    assert.equal(store.indexDelete(quoted),true);
    assert.equal(store.search('thirduniquemarker',10).length,0);
    assert.equal(store.indexDelete('D:\\absent\\state.sqlite-wal'),false);
  }finally{store.db.close()}
});

test('watcher ignores SQLite/WAL churn while continuing to index document changes',async()=>{
  const {dir,store,files}=await fixture();
  try{
    files.startWatch(dir);
    for(const name of ['state.sqlite','state.sqlite-wal','state.sqlite-shm','state.db-journal'])await writeFile(join(dir,name),'internal binary state');
    await new Promise(r=>setTimeout(r,500));
    assert.equal(files.watchStatus().events,0);
    await writeFile(join(dir,'watched.txt'),'watcherregressionmarker');
    const deadline=Date.now()+5000;
    while(Date.now()<deadline && !store.search('watcherregressionmarker',10).length)await new Promise(r=>setTimeout(r,50));
    assert.equal(store.search('watcherregressionmarker',10).length,1);
    assert.equal(files.watchStatus().errors,0);
  }finally{files.stopWatch();store.db.close()}
});

test('watcher recovers from transient Office ZIP saves and ignores Office temp files',async()=>{
  const {dir,store,files}=await fixture();
  try{
    files.startWatch(dir);
    const path=join(dir,'draft.docx');
    await writeFile(path,'partial-not-yet-a-zip');
    await new Promise(r=>setTimeout(r,550));
    const doc=new Document({sections:[{children:[new Paragraph('transientofficerecoverymarker')]}]});
    await writeFile(path,await Packer.toBuffer(doc));
    const deadline=Date.now()+7000;
    while(Date.now()<deadline && !store.search('transientofficerecoverymarker',10).length)await new Promise(r=>setTimeout(r,50));
    assert.equal(store.search('transientofficerecoverymarker',10).length,1);
    let status=files.watchStatus();
    assert.equal(status.errors,0);
    assert.ok(status.transientRetries>=1);
    assert.ok(status.transientRecoveries>=1);
    await writeFile(join(dir,'~$draft.docx'),'temporary-office-lock-file');
    await new Promise(r=>setTimeout(r,500));
    status=files.watchStatus();
    assert.equal(status.errors,0);
    assert.ok(status.ignoredTempFiles>=1);
  }finally{files.stopWatch();store.db.close()}
});

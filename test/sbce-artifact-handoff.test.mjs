import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,existsSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {Store} from '../dist/db.js';
import {FileService} from '../dist/files.js';
import {TaskRunManager} from '../dist/task-runtime.js';
import {SbceArtifactHandoff} from '../dist/sbce-artifact-handoff.js';
import {brainOnlyAllows} from '../dist/brain-only.js';
const JOB='job-00000000-0000-4000-8000-000000000001';
const sha=s=>createHash('sha256').update(s).digest('hex');

test('Mode 1 trusted SBCE handoff enforces review, authorization, sandbox mode, no-overwrite, and SHA-256',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'nhd-sbce-host-handoff-'));
  const store=new Store(join(dir,'workstation.sqlite'));
  try{
    const config={roots:[dir],writeEnabled:true,emergencyStop:false,backupDir:join(dir,'backups')};
    const files=new FileService(config,store);
    const taskRuns=new TaskRunManager(store,{roots:[dir]});
    const task=taskRuns.create({objective:'Validate SBCE host handoff',root:dir,maxSteps:10,maxRuntimeMs:15*60*1000});
    taskRuns.start(task.id);
    const text='NHD_MODE1_WORKER_TO_HARNESS_CANARY_20261114_OK\n';
    let jobStatus='accepted',applyMode='apply_after_accept',workerMode='on',draft=text;
    const executor={
      get mode(){return workerMode;},
      async request(method,path,body){
        assert.equal(method,'POST');
        assert.equal(body.owner,task.id);
        if(path.endsWith('/status'))return{owner:task.id,status:jobStatus,applyMode,
          review:{artifacts:{draft:'worker-artifact'},checks:[{name:'L0',ok:true},{name:'L1',ok:true}]}};
        if(path.endsWith('/pull')){const max=body.max_chars??8000,offset=body.start_char??0;
          return {job_id:JOB,kind:'draft',offset,text:draft.slice(offset,offset+max),total_chars:draft.length,truncated:offset+max<draft.length};}
        throw Error('Unexpected worker route '+path);
      }
    };
    const handoff=new SbceArtifactHandoff({runtime:{taskRuns,config,files,store}},executor);
    const output=join(dir,'output.txt');
    assert.equal(brainOnlyAllows('sbce_artifact_handoff'),true);
    await assert.rejects(handoff.preview(task.id,JOB,output),/AUTHORIZATION_REQUIRED/);
    taskRuns.authorizations.authorize(task.id,'moderate');

    jobStatus='ready_for_review';
    await assert.rejects(handoff.preview(task.id,JOB,output),/BRAIN_ACCEPTANCE_REQUIRED/);
    jobStatus='accepted';applyMode='sandbox_only';
    await assert.rejects(handoff.preview(task.id,JOB,output),/SANDBOX_ONLY_DENIED/);
    applyMode='apply_after_accept';workerMode='shadow';
    await assert.rejects(handoff.preview(task.id,JOB,output),/EXECUTOR_NOT_ON/);
    workerMode='on';
    await assert.rejects(handoff.preview(task.id,JOB,join(dir,'malicious.ps1')),/TEXT_EXTENSION_ONLY/);
    await assert.rejects(handoff.preview(task.id,JOB,join(dir,'..','escape.txt')),/OUTSIDE_TASK_ROOT/);

    const before=await handoff.preview(task.id,JOB,output);
    assert.equal(existsSync(output),false,'preview is read-only');
    assert.equal(before.sha256,sha(text));
    const verified=await handoff.apply(task.id,before.actionId,before.confirmationToken);
    assert.equal(verified.verified,true);
    assert.equal(verified.sha256,sha(text));
    assert.equal(readFileSync(output,'utf8'),text);
    assert.equal(verified.hostReceipt.applied,true);
    await assert.rejects(handoff.apply(task.id,before.actionId,before.confirmationToken),/already used/);
    await assert.rejects(handoff.preview(task.id,JOB,output),/WOULD_OVERWRITE/);

    const race=join(dir,'race.txt');
    const racePreview=await handoff.preview(task.id,JOB,race);
    writeFileSync(race,'external write before apply','utf8');
    await assert.rejects(handoff.apply(task.id,racePreview.actionId,racePreview.confirmationToken),/WOULD_OVERWRITE/);
    assert.equal(readFileSync(race,'utf8'),'external write before apply');

    draft='[HIDDEN]';
    await assert.rejects(handoff.preview(task.id,JOB,join(dir,'masked.txt')),/INCOMPLETE_OR_MASKED_DRAFT|MASKED_CONTENT_DENIED/);
  }finally{
    store.db.close();
    try{rmSync(dir,{recursive:true,force:true,maxRetries:10,retryDelay:150});}catch(e){console.warn('Fixture cleanup deferred:',e.code);}
  }
});

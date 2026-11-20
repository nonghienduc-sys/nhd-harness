import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { registerDocumentTemplateTools } from '../dist/mcp-registries/document-template-tools.js';
import { validationIssuesFromOutput } from '../dist/mcp-validation-audit.js';
import { TerminalService } from '../dist/terminal.js';

const python = spawnSync('python', ['-I', '-c', 'import sys;print(sys.version_info.major)'], {encoding:'utf8', windowsHide:true});
const pythonReady = python.status === 0 && python.stdout.includes('3');
const root = resolve(import.meta.dirname, '..');
const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex');

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'nhd-doc-template-'));
  const audit = [];
  const config = { documentTemplateTools:{}, writeEnabled:true, emergencyStop:false, terminalEnabled:true };
  const store = {audit: (action,status,detail)=>audit.push({action,status,detail}),
    createPending:()=>({id:'pending-test',confirmationToken:'test',expiresAt:new Date(Date.now()+60000).toISOString()})};
  const files = {resolvePath(path) {
    const candidate = resolve(path);
    if (candidate !== dir && !candidate.startsWith(dir+sep)) throw Error('Path is outside configured roots.');
    return candidate;
  }};
  const tools = new Map();
  registerDocumentTemplateTools({
    server:{registerTool(name,schema,handler){tools.set(name,{schema,handler});}},
    runtime:{config,files,store}
  });
  return {dir,audit,config,store,files,tools,
    close:()=>rmSync(dir,{recursive:true,force:true})};
}

test('document tools fail safely without configuration; root and overwrite policies', {skip:!pythonReady}, async () => {
  const f = fixture();
  try {
    const build=f.tools.get('doc_from_template').handler;
    const check=f.tools.get('doc_format_check').handler;
    const template=join(f.dir,'template.docx'),replacements=join(f.dir,'replacements.json'),output=join(f.dir,'new.docx');
    writeFileSync(template,'source fixture');
    writeFileSync(replacements,'{}');
    assert.match(JSON.stringify(await build({template,output,replacements_json:replacements})),/Chưa cấu hình/);
    assert.match(JSON.stringify(await check({path:template})),/Chưa cấu hình/);
    const script=join(f.dir,'fake-build.py');
    writeFileSync(script,[
      'from pathlib import Path','import sys',
      'assert sys.argv[3] == "--thay"',
      'Path(sys.argv[2]).write_text("DAT",encoding="utf-8")',
      'print("BUILD SUCCESS")',
    ].join('\n'));
    const format=join(f.dir,'fake-format.py');
    writeFileSync(format,[
      'from pathlib import Path','import sys',
      'ok=Path(sys.argv[1]).read_text(encoding="utf-8")=="DAT"',
      'sys.stdout.buffer.write(("TỔNG: ĐẠT" if ok else "TỔNG: LỖI").encode("utf-8"))'
    ].join('\n'));
    f.config.documentTemplateTools={python:'python',buildScript:script,formatCheckScript:format};
    assert.match(JSON.stringify(await build({template,output:join(f.dir,'..','outside.docx'),replacements_json:replacements})),/outside configured roots/);
    const created=await build({template,output,replacements_json:replacements,a4:true});
    assert.equal(created.isError,undefined,JSON.stringify(created));
    assert.equal(created.structuredContent.exitCode,0);
    assert.equal(created.structuredContent.sha256,hash(output));
    assert.equal(readFileSync(output,'utf8'),'DAT');
    assert.match(JSON.stringify(await build({template,output,replacements_json:replacements})),/overwrite=true/);
    const dat=await check({path:output,template,forbid:['SECRET_SENTINEL_9283']});
    assert.equal(dat.structuredContent.verdict,'DAT',JSON.stringify(dat));
    assert.equal(dat.structuredContent.exitCode,0);
    assert.equal(dat.structuredContent.outputTail,'TỔNG: ĐẠT');
    const before=hash(output);
    writeFileSync(join(f.dir,'failed.docx'),'NO');
    const loi=await check({path:join(f.dir,'failed.docx')});
    assert.equal(loi.structuredContent.verdict,'LOI');
    assert.equal(hash(output),before,'format check cannot alter an input');
    f.config.writeEnabled=false;
    assert.match(JSON.stringify(await build({template,output,replacements_json:replacements,overwrite:true})),/disabled/);
    f.config.writeEnabled=true;f.config.emergencyStop=true;
    assert.match(JSON.stringify(await build({template,output,replacements_json:replacements,overwrite:true})),/disabled/);
    assert.ok(f.audit.filter(x=>x.action==='doc_from_template').some(x=>x.status==='ok'));
    assert.ok(f.audit.filter(x=>x.action==='doc_from_template').some(x=>x.status==='error'));
    assert.ok(f.audit.filter(x=>x.action==='doc_format_check').some(x=>x.status==='ok'));
    assert.ok(!JSON.stringify(f.audit).includes('SECRET_SENTINEL_9283'));
  } finally {f.close();}
});

test('terminal preview gives Word-template advice only for code Word mutations',()=>{
  const f=fixture();
  try {
    f.files.resolvePath=path=>resolve(path);
    const terminal = new TerminalService(f.config,f.store,f.files);
    const command='python -c "from docx import Document; doc = Document(\'sample.docx\'); doc.save(\'new.docx\')"';
    const advice=terminal.preview(command,f.dir);
    assert.match(advice.advice,/doc_from_template.*doc_format_check/);
    const normal=terminal.preview('Get-Item sample.docx',f.dir);
    assert.equal(normal.advice,undefined);
    const other=terminal.preview('Get-Date',f.dir);
    assert.equal(other.advice,undefined);
  } finally {f.close();}
});

test('invalid-params audit metadata never records incoming values',()=>{
  const privateValue='DO_NOT_LOG_PAYLOAD_84624';
  const output={isError:true,content:[{type:'text',text:'Input validation error: '+JSON.stringify([
    {code:'invalid_type',path:['path'],expected:'string',received:privateValue},
    {code:'too_small',path:['limit'],message:privateValue}])}]};
  const issues=validationIssuesFromOutput(output);
  assert.deepEqual(issues,['path:invalid_type','limit:too_small']);
  assert.ok(!JSON.stringify(issues).includes(privateValue));
  assert.deepEqual(validationIssuesFromOutput({isError:true,content:[{type:'text',text:'Input validation error: unrecognized format '+privateValue}]}),['$:invalid_schema']);
  assert.equal(validationIssuesFromOutput({content:[]}),null);
});

test('audit-summary counts tool actions and >30s quiet intervals using read-only database',()=>{
  const dir=mkdtempSync(join(tmpdir(),'nhd-audit-summary-'));
  const dbPath=join(dir,'audit.sqlite');
  try {
    const db=new DatabaseSync(dbPath);
    db.exec('CREATE TABLE audit(id INTEGER PRIMARY KEY,at TEXT,action TEXT,status TEXT,detail TEXT)');
    const insert=db.prepare('INSERT INTO audit(at,action,status,detail) VALUES(?,?,?,?)');
    insert.run('2026-01-01T00:00:00.000Z','tool_describe','ok',JSON.stringify({tool:'fs_read',found:true}));
    insert.run('2026-01-01T00:00:08.000Z','tool_describe','error',JSON.stringify({tool:'invalid',found:false}));
    insert.run('2026-01-01T00:00:44.000Z','tool_invalid_params','error',JSON.stringify({tool:'fs_read',issues:['path:invalid_type']}));
    db.close();
    const run=spawnSync(process.execPath,[join(root,'scripts/audit-summary.mjs'),'--db',dbPath,'--since','2026-01-01T00:00:00.000Z'],{encoding:'utf8'});
    assert.equal(run.status,0,run.stderr);
    const out=JSON.parse(run.stdout);
    assert.equal(out.total,3);
    assert.equal(out.actions.tool_describe,2);
    assert.equal(out.tool_describe_by_tool.fs_read,1);
    assert.equal(out.tool_invalid_params_by_tool.fs_read,1);
    assert.deepEqual(out.idle_gaps_over_30s.map(x=>x.seconds),[36]);
    const narrower=spawnSync(process.execPath,[join(root,'scripts/audit-summary.mjs'),'--db',dbPath,'--since','2026-01-01T00:00:00.000Z','--until','2026-01-01T00:00:20.000Z'],{encoding:'utf8'});
    assert.equal(JSON.parse(narrower.stdout).total,2);
  } finally { rmSync(dir,{recursive:true,force:true}); }
});

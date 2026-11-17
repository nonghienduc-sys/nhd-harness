import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createHash, randomBytes } from 'node:crypto';
import ExcelJS from 'exceljs';
import { Store } from '../dist/db.js';
import { FileService } from '../dist/files.js';
import { TerminalService } from '../dist/terminal.js';
import { TunnelService } from '../dist/tunnel.js';
import { OfficeService } from '../dist/office.js';
import { SkillService, OFFICE_SKILL_COUNT } from '../dist/skills.js';
import { ScreenService } from '../dist/screen.js';
import { ProjectService } from '../dist/project.js';
import { DocumentService } from '../dist/document.js';
import { DesktopService } from '../dist/desktop.js';
import { IntakeService } from '../dist/intake.js';
import { PdfService } from '../dist/pdf.js';
import { DesktopIntakeWorkflow } from '../dist/desktop-intake.js';
import { createWorkstationMcp, getWorkstationToolInventory } from './helpers/mcp-legacy.mjs';
import JSZip from 'jszip';

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'workstation-mcp-'));
  const backupDir = join(dir, 'backups');
  await mkdir(backupDir);
  const config = { instanceId:'test',host:'127.0.0.1',port:39100,officePort:39999,screenPort:39998,roots:[dir],intakeRoots:[join(dir,'inbox')],dataDir:dir,backupDir,writeEnabled:true,terminalEnabled:true,skillsEnabled:true,screenEnabled:true,desktopEnabled:true,visualDesktopEnabled:true,intakeEnabled:true,ocrEnabled:true,disabledSkills:[],tunnelEnabled:false,tunnelMode:'quick',namedTunnelName:'',namedTunnelConfig:'',publicHostname:'',emergencyStop:false,pairingCode:'TEST',companionSecret:'test-secret',cloudflaredPath:'cloudflared.exe' };
  await mkdir(config.intakeRoots[0]);
  const store = new Store(join(dir, 'test.sqlite'));
  const files = new FileService(config, store);
  return { dir, config, store, files, terminal:new TerminalService(config, store, files), office:new OfficeService(config, store, files) };
}

test('filesystem preview and apply uses one-time token', async () => {
  const {dir, files} = await fixture();
  const target = join(dir, 'sample.txt');
  await writeFile(target, 'before', 'utf8');
  const preview = files.preview('write', {path:target, content:'after'});
  assert.equal(await readFile(target,'utf8'),'before');
  files.apply(preview.actionId, preview.confirmationToken);
  assert.equal(await readFile(target,'utf8'),'after');
  assert.throws(()=>files.apply(preview.actionId, preview.confirmationToken),/already used/);
});

test('filesystem blocks paths outside root and secret names', async () => {
  const {dir, files} = await fixture();
  assert.throws(()=>files.resolvePath(resolve(dir,'..','outside.txt')),/outside configured roots/);
  assert.throws(()=>files.resolvePath(join(dir,'.env')),/Sensitive or excluded/);
});

test('filesystem blocks a Windows junction that leaves the configured root', async (t) => {
  const {dir, files} = await fixture();
  const outside = await mkdtemp(join(tmpdir(), 'workstation-mcp-outside-'));
  const junction = join(dir, 'outside-junction');
  try { await symlink(outside, junction, 'junction'); }
  catch (error) { t.skip(`Junction creation unavailable: ${error.code}`); return; }
  assert.throws(() => files.resolvePath(join(junction, 'file.txt')), /Symbolic links and junction/);
});

test('terminal preview and confirmed execution', async () => {
  const {dir, terminal} = await fixture();
  const preview = terminal.preview("Write-Output 'terminal-ok'", dir, 10);
  await assert.rejects(() => terminal.execute(preview.actionId, '0'.repeat(64), preview.confirmationToken), /hash/i);
  const retry = terminal.preview("Write-Output 'terminal-ok'", dir, 10);
  const result = await terminal.execute(retry.actionId, retry.commandHash, retry.confirmationToken);
  assert.equal(result.code,0);
  assert.match(result.stdout,/terminal-ok/);
});

test('critical terminal commands require the preview confirmation phrase', async () => {
  const {dir, terminal} = await fixture();
  const preview = terminal.preview("Remove-Item 'D:\\danger-test' -Recurse -Force", dir, 10);
  assert.equal(preview.risk, 'critical');
  await assert.rejects(
    () => terminal.execute(preview.actionId, preview.commandHash, preview.confirmationToken, 'wrong'),
    /confirmation phrase/i,
  );
});

function fakeTunnelChild(pid) {
  const child = new EventEmitter();
  child.pid = pid;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => { queueMicrotask(() => child.emit('close', 0, null)); return true; };
  return child;
}

const delay = milliseconds => new Promise(resolvePromise => setTimeout(resolvePromise, milliseconds));

test('tunnel watchdog restarts a crashed process and manual stop suppresses restart', async () => {
  const {config, store} = await fixture();
  config.tunnelEnabled = true;
  config.tunnelMode = 'quick';
  const children = [];
  const tunnel = new TunnelService(config, store, {
    spawnProcess: () => { const child = fakeTunnelChild(7000 + children.length); children.push(child); return child; },
    restartDelaysMs: [10, 20, 30],
    stableResetMs: 1000,
  });
  tunnel.start();
  assert.equal(children.length, 1);
  children[0].stderr.emit('data', Buffer.from('temporary QUIC transport failure'));
  children[0].emit('close', -1, null);
  assert.equal(tunnel.status().restartScheduled, true);
  await delay(35);
  assert.equal(children.length, 2);
  assert.equal(tunnel.status().running, true);
  const beforeStop = children.length;
  tunnel.stop();
  await delay(35);
  assert.equal(children.length, beforeStop);
  assert.equal(tunnel.status().restartScheduled, false);
});

test('tunnel watchdog honors Emergency Stop and increases retry backoff', async () => {
  const {config, store} = await fixture();
  config.tunnelEnabled = true;
  config.tunnelMode = 'quick';
  const children = [];
  const tunnel = new TunnelService(config, store, {
    spawnProcess: () => { const child = fakeTunnelChild(8000 + children.length); children.push(child); return child; },
    restartDelaysMs: [10, 25, 50],
    stableResetMs: 1000,
  });
  tunnel.start();
  children[0].emit('close', -1, null);
  await delay(20);
  assert.equal(children.length, 2);
  children[1].emit('close', -1, null);
  const scheduled = store.recentAudit(10).filter(event => event.action === 'tunnel' && event.status === 'restart_scheduled');
  assert.equal(JSON.parse(scheduled[0].detail).delayMs, 25);
  config.emergencyStop = true;
  await delay(35);
  assert.equal(children.length, 2);
  assert.equal(tunnel.status().restartScheduled, false);
});

test('offline Excel edit changes after confirmation', async () => {
  const {dir, office} = await fixture();
  const path = join(dir,'book.xlsx');
  const workbook = new ExcelJS.Workbook();
  workbook.addWorksheet('Data').getCell('A1').value='before';
  await workbook.xlsx.writeFile(path);
  const preview = office.previewEdit(path,{type:'set_cell',sheet:'Data',cell:'A1',value:'after'});
  await office.applyEdit(preview.actionId,preview.confirmationToken);
  const checked = new ExcelJS.Workbook();
  await checked.xlsx.readFile(path);
  assert.equal(checked.getWorksheet('Data').getCell('A1').value,'after');
});

test('Office PDF export requires preview and preserves an overwritten output backup', async () => {
  const {dir, office} = await fixture();
  const input = join(dir, 'document.docx');
  const output = join(dir, 'document.pdf');
  await writeFile(input, 'fixture', 'utf8');
  await writeFile(output, 'old-pdf', 'utf8');
  office.live = async (_action, payload) => {
    await writeFile(payload.output, 'new-pdf', 'utf8');
    return {ok:true};
  };
  const preview = office.previewExport('word', input, output);
  assert.equal(await readFile(output, 'utf8'), 'old-pdf');
  const result = await office.applyExport(preview.actionId, preview.confirmationToken);
  assert.equal(await readFile(output, 'utf8'), 'new-pdf');
  assert.equal(await readFile(result.backup, 'utf8'), 'old-pdf');
});

test('Office Companion requests include companion authentication header', async () => {
  const {office} = await fixture();
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (url, init = {}) => {
    calls++;
    assert.equal(init.headers?.['x-workstation-companion-secret'], 'test-secret');
    if (String(url).endsWith('/status')) return new Response(JSON.stringify({word:false,excel:false,powerpoint:false,outlook:false}), {status:200,headers:{'content-type':'application/json'}});
    if (String(url).endsWith('/action')) return new Response(JSON.stringify({ok:true,open:false}), {status:200,headers:{'content-type':'application/json'}});
    throw new Error('Unexpected Office Companion URL: '+url);
  };
  try {
    const status = await office.status();
    assert.equal(status.companion, true);
    await office.live('word_document_status', {});
    assert.equal(calls, 2);
  } finally { globalThis.fetch = originalFetch; }
});

test('Word live edit requires an unchanged previewed selection and verifies the applied text', async () => {
  const {office} = await fixture();
  let text = 'before text';
  office.live = async (action, input) => {
    if (action === 'word_selection_read') return {open:true,path:'Document1',name:'Document1',selection:{start:5,end:16,text}};
    if (action === 'word_selection_replace') { text = input.text; return {ok:true,text}; }
    throw new Error('Unexpected live action: '+action);
  };
  const preview = await office.previewLiveEdit('word',{type:'replace_selection',text:'after text'});
  assert.equal(text,'before text');
  const applied = await office.applyLiveEdit(preview.actionId,preview.confirmationToken);
  assert.equal(applied.verified,true);
  assert.equal(text,'after text');
});

test('Word live edit rejects apply when the selection changed after preview', async () => {
  const {office} = await fixture();
  let text = 'baseline';
  office.live = async (action) => {
    if (action === 'word_selection_read') return {open:true,path:'Document1',name:'Document1',selection:{start:1,end:9,text}};
    throw new Error('Unexpected write');
  };
  const preview = await office.previewLiveEdit('word',{type:'replace_selection',text:'replacement'});
  text = 'changed!';
  await assert.rejects(() => office.applyLiveEdit(preview.actionId,preview.confirmationToken), /selection changed/i);
});

test('Skill Registry packages and validates all office skills', async () => {
  const {config} = await fixture();
  const skills = new SkillService(config);
  const validation = skills.validate();
  assert.equal(validation.total, OFFICE_SKILL_COUNT);
  assert.equal(validation.valid, OFFICE_SKILL_COUNT);
  assert.equal(validation.enabled, OFFICE_SKILL_COUNT - 1);
  assert.equal(skills.list().length, OFFICE_SKILL_COUNT - 1);
  assert.equal(skills.get('skill-chinh-sua-format-van-ban', false).enabled, false);
});

test('Skill activation returns security rules and blocks resource traversal', async () => {
  const {config} = await fixture();
  const skills = new SkillService(config);
  const activation = skills.activate('vietnam-admin-documents', 'Soạn công văn');
  assert.match(activation.skill.instructions, /Vietnamese Administrative Documents/i);
  assert.ok(activation.allowedTools.includes('office_read'));
  assert.match(activation.securityOverlay.join(' '), /never authorization/i);
  assert.throws(() => skills.readResource('vietnam-admin-documents', '..\\daily-document-workspace\\SKILL.md'), /traversal/i);
});

test('screen capture requires preview and a one-time confirmation token', async () => {
  const {config} = await fixture();
  const store = new Store(join(config.dataDir, 'screen.sqlite'));
  const screen = new ScreenService(config, store);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    assert.equal(init.headers['x-workstation-companion-secret'], 'test-secret');
    if (String(url).endsWith('/sources')) return new Response(JSON.stringify({sources:[{id:'window:1:0',name:'Document - Word',kind:'window',displayId:null}]}), {status:200,headers:{'content-type':'application/json'}});
    if (String(url).endsWith('/capture')) return new Response(JSON.stringify({source:{id:'window:1:0',name:'Document - Word',kind:'window',displayId:null},width:1,height:1,mimeType:'image/png',data:Buffer.from('png-fixture').toString('base64')}), {status:200,headers:{'content-type':'application/json'}});
    throw new Error(`Unexpected URL: ${url}`);
  };
  try {
    const preview = await screen.previewCapture('window:1:0', 1200, 800);
    await assert.rejects(() => screen.applyCapture(preview.actionId, 'wrong-token'), /Invalid confirmation token/);
    const capture = await screen.applyCapture(preview.actionId, preview.confirmationToken);
    assert.equal(capture.source.name, 'Document - Word');
    assert.equal(Buffer.from(capture.data, 'base64').toString(), 'png-fixture');
    await assert.rejects(() => screen.applyCapture(preview.actionId, preview.confirmationToken), /already used/);
  } finally { globalThis.fetch = originalFetch; }
});

test('automatic screen capture works while owner Screen Access is enabled', async () => {
  const {config} = await fixture();
  const store = new Store(join(config.dataDir, 'screen-auto.sqlite'));
  const screen = new ScreenService(config, store);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).endsWith('/sources')) return new Response(JSON.stringify({sources:[{id:'screen:0:0',name:'Entire screen',kind:'screen',displayId:'0'}]}), {status:200,headers:{'content-type':'application/json'}});
    if (String(url).endsWith('/capture')) return new Response(JSON.stringify({source:{id:'screen:0:0',name:'Entire screen',kind:'screen',displayId:'0'},width:2,height:2,mimeType:'image/png',data:Buffer.from('automatic-png').toString('base64')}), {status:200,headers:{'content-type':'application/json'}});
    throw new Error(`Unexpected URL: ${url}`);
  };
  try {
    const capture = await screen.capture(undefined, 1000, 700);
    assert.equal(capture.source.id, 'screen:0:0');
    config.screenEnabled = false;
    await assert.rejects(() => screen.capture(), /disabled by the owner/i);
  } finally { globalThis.fetch = originalFetch; }
});

async function makePdf(path, text = 'Hello PDF intake') {
  const content = `BT /F1 12 Tf 72 720 Td (${text.replace(/[()\\]/g, value => `\\${value}`)}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let output = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(output, 'latin1')); output += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(output, 'latin1');
  output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n `).join('\n')}\ntrailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  await writeFile(path, Buffer.from(output, 'latin1'));
}

test('document intake exposes only approved stable office files', async () => {
  const {dir, config, store} = await fixture();
  const intake = new IntakeService(config, store);
  const pdf = join(config.intakeRoots[0], 'received.pdf');
  await makePdf(pdf);
  await writeFile(join(config.intakeRoots[0], 'unfinished.pdf.crdownload'), 'partial');
  assert.equal(intake.listRecent({extension:'pdf'})[0].path, pdf);
  assert.throws(() => intake.resolvePath(join(dir, 'outside.pdf')), /outside approved intake folders/);
  const stable = await intake.waitForFile({extension:'pdf', since:new Date(Date.now()-5000).toISOString(), timeoutSeconds:3, settleMilliseconds:250});
  assert.equal(stable.hash.length, 64);
});

test('PDF service inspects reads searches and paginates native text', async () => {
  const {dir, config, store, files} = await fixture();
  const intake = new IntakeService(config, store);
  const pdfService = new PdfService(config, store, files, intake);
  const pdf = join(dir, 'sample.pdf');
  await makePdf(pdf, 'Capital contribution deadline twelve months');
  const inspection = await pdfService.inspect(pdf);
  assert.equal(inspection.pages, 1);
  assert.equal(inspection.scannedPages.length, 0);
  const content = await pdfService.read(pdf, 1, 1, 5000);
  assert.match(content.pages[0].text, /Capital contribution/);
  const search = await pdfService.search(pdf, 'deadline');
  assert.equal(search.hits[0].page, 1);
});

test('desktop service uses companion authentication and owner kill switch', async () => {
  const {config, store} = await fixture();
  const desktop = new DesktopService(config, store);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    assert.equal(init.headers['x-workstation-companion-secret'], 'test-secret');
    if (String(url).endsWith('/ui/windows')) return new Response(JSON.stringify({windows:[{windowId:'100',title:'Zalo',processId:1,automationId:'',className:'Window',controlType:'Window'}]}), {status:200,headers:{'content-type':'application/json'}});
    if (String(url).endsWith('/ui/inspect')) return new Response(JSON.stringify({windowId:'100',controls:[{selectorId:'ui-1',windowId:'100',name:'Tìm kiếm',automationId:'search',className:'Edit',controlType:'Edit',enabled:true,offscreen:false,password:false,depth:1,bounds:null}],total:1,truncated:false}), {status:200,headers:{'content-type':'application/json'}});
    if (String(url).endsWith('/ui/action')) return new Response(JSON.stringify({ok:true}), {status:200,headers:{'content-type':'application/json'}});
    throw new Error(`Unexpected URL: ${url}`);
  };
  try {
    assert.equal((await desktop.windows()).windows[0].title, 'Zalo');
    assert.equal((await desktop.inspect('100',{query:'tìm'})).controls[0].selectorId, 'ui-1');
    await assert.rejects(() => desktop.action({action:'set_text',selectorId:'ui-1',text:'search text'}), /task_run_id/);
    await assert.rejects(() => desktop.action({action:'click_point',windowId:'100',xRatio:1.01,yRatio:0.5}), /task_run_id/);
    await assert.rejects(() => desktop.action({action:'double_click_point',windowId:'100',xRatio:Number.NaN,yRatio:0.5}), /task_run_id/);
    config.visualDesktopEnabled = false;
    await assert.rejects(() => desktop.action({action:'click_point',windowId:'100',xRatio:0.5,yRatio:0.5}), /task_run_id/);
    config.desktopEnabled = false;
    await assert.rejects(() => desktop.windows(), /disabled by the owner/);
  } finally { globalThis.fetch = originalFetch; }
});

test('desktop automation script remains compatible with Windows PowerShell', {skip: process.platform !== 'win32'}, async () => {
  const payload = Buffer.from('{}', 'utf8').toString('base64');
  const output = await new Promise((resolvePromise, reject) => {
    const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', resolve('office', 'desktop_automation.ps1'), '-Action', 'windows', '-PayloadBase64', payload], {windowsHide:true,stdio:['ignore','pipe','pipe']});
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', chunk => stdout.push(Buffer.from(chunk)));
    child.stderr.on('data', chunk => stderr.push(Buffer.from(chunk)));
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolvePromise(Buffer.concat(stdout).toString('utf8').trim()) : reject(new Error(Buffer.concat(stderr).toString('utf8').trim() || `PowerShell exited with ${code}`)));
  });
  const result = JSON.parse(output);
  assert.ok(Array.isArray(result.windows));
});

test('high-level desktop intake workflow completes a named latest-PDF task', async () => {
  const {config, store} = await fixture();
  let inspection = 0;
  const desktop = {
    windows: async () => ({windows:[{windowId:'200',title:'Zalo',processId:2,automationId:'',className:'Window',controlType:'Window',bounds:{x:0,y:0,width:1000,height:700}}]}),
    action: async () => ({ok:true}),
    inspect: async () => {
      inspection++;
      if (inspection === 1) return {controls:[{selectorId:'search',windowId:'200',name:'Tìm kiếm',automationId:'search',className:'Edit',controlType:'Edit',enabled:true,offscreen:false,password:false,depth:1,bounds:null}]};
      if (inspection === 2) return {controls:[{selectorId:'conversation',windowId:'200',name:'Nguyễn Văn A',automationId:'',className:'Item',controlType:'ListItem',enabled:true,offscreen:false,password:false,depth:2,bounds:{x:0,y:100,width:200,height:40}}]};
      return {controls:[{selectorId:'attachment',windowId:'200',name:'Bao cao moi.pdf',automationId:'',className:'File',controlType:'Button',enabled:true,offscreen:false,password:false,depth:2,bounds:{x:300,y:500,width:200,height:40}}]};
    },
  };
  const intakeFile = {path:'D:\\Bao cao moi.pdf',name:'Bao cao moi.pdf',extension:'.pdf',size:100,modifiedAt:new Date().toISOString(),hash:'a'.repeat(64),mimeType:'application/pdf',root:'D:\\'};
  const intake = {waitForFile:async()=>intakeFile,listRecent:()=>[intakeFile],status:()=>({enabled:true})};
  const pdf = {inspect:async()=>({pages:2,textCharacters:500,scannedPages:[]}),read:async()=>({pages:[{page:1,text:'Nội dung báo cáo'}]})};
  const workflow = new DesktopIntakeWorkflow(config, store, desktop, intake, pdf);
  const output = await workflow.run({application:'Zalo',conversation:'Nguyễn Văn A',attachmentType:'pdf',selection:'latest',task:'read',maxChars:5000});
  assert.equal(output.status, 'completed');
  assert.equal(output.file.name, 'Bao cao moi.pdf');
  assert.equal(output.content.pages[0].text, 'Nội dung báo cáo');
});

test('MCP registry includes the interactive intake tool surface', async () => {
  const {config, store, files, terminal, office} = await fixture();
  const skills = new SkillService(config);
  const screen = new ScreenService(config, store);
  const projects = new ProjectService(config, store, files);
  const documents = new DocumentService(config, store, files, projects, office);
  const desktop = new DesktopService(config, store);
  const intake = new IntakeService(config, store);
  const pdf = new PdfService(config, store, files, intake);
  const workflow = new DesktopIntakeWorkflow(config, store, desktop, intake, pdf);
  config.browserEnabled = true;
  const browser = { status:async()=>({enabled:true,executable:'edge',running:false}), navigate:async()=>({}), inspect:async()=>({controls:[]}), click:async()=>({}), fill:async()=>({}), wait:async()=>({}), screenshot:async()=>({page:{},mimeType:'image/png',data:''}) };
  const server = createWorkstationMcp(config, store, files, terminal, office, skills, screen, projects, documents, desktop, intake, pdf, workflow, browser);
  const inventory = getWorkstationToolInventory(server, config);
  // v0.24.15: inventory = every callable name (old names + new facade names); hidden aliases are listed:false.
  assert.equal(inventory.length, 106);
  assert.ok(inventory.some(tool => tool.name === "harness_mode"));
  assert.ok(inventory.some(tool => tool.name === 'local_ai_router' && tool.listed === true));
  assert.ok(inventory.some(tool => tool.name === 'local_ai_status' && tool.listed === false));
  for (const name of ['desktop_windows','desktop_inspect','desktop_action','intake_files','pdf_document','desktop_document_intake','office_live_read','browser_status','browser_navigate','browser_inspect','browser_click','browser_fill','browser_wait','browser_screenshot','browser_wait_for','browser_click_verified','browser_fill_verified','workstation_plan','runtime_identity','local_ai_status','local_ai_route','local_ai_dispatch','local_ai_verify','tool_governor','project_rag_status','project_rag_query','project_rag_ingest','office_live_preview_edit','office_live_apply_edit','office_live_insert_at_cursor','office_live_append','context_payload_artifact','self_evolution_status','self_evolution_analyze','self_evolution_record_feedback','self_evolution_propose','self_evolution_evaluate']) assert.ok(inventory.some(tool => tool.name === name));
});

async function makeDocx(path) {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.folder('_rels').file('.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.folder('word').file('document.xml', `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml"><w:body>
    <w:p w14:paraId="A001"><w:pPr><w:keepNext/></w:pPr><w:r><w:rPr><w:b/></w:rPr><w:t>CHƯƠNG I. QUY ĐỊNH CHUNG</w:t></w:r></w:p>
    <w:p w14:paraId="A002"><w:pPr><w:keepNext/></w:pPr><w:r><w:rPr><w:b/></w:rPr><w:t>Điều 1. Vốn góp</w:t></w:r></w:p>
    <w:p w14:paraId="A003"><w:pPr><w:jc w:val="both"/></w:pPr><w:r><w:t>1. Thành viên góp vốn theo quy định tại Điều 2.</w:t></w:r></w:p>
    <w:p w14:paraId="A004"><w:pPr><w:keepNext/></w:pPr><w:r><w:rPr><w:b/></w:rPr><w:t>Điều 2. Thời hạn góp vốn</w:t></w:r></w:p>
    <w:p w14:paraId="A005"><w:pPr><w:jc w:val="both"/></w:pPr><w:r><w:t>1. Thời hạn là 12 tháng.</w:t></w:r></w:p>
    <w:sectPr/></w:body></w:document>`);
  await (await import('node:fs/promises')).writeFile(path, await zip.generateAsync({type:'nodebuffer'}));
}

async function makeStructuredDocx(path, lines) {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.folder('_rels').file('.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  const body = lines.map((text, index) => {
    const heading = /^(?:CHƯƠNG|Điều\s+\d+)/iu.test(text);
    const pPr = heading ? '<w:pPr><w:keepNext/></w:pPr>' : '<w:pPr><w:jc w:val="both"/></w:pPr>';
    const rPr = heading ? '<w:rPr><w:b/></w:rPr>' : '';
    return `<w:p w14:paraId="${(0x1000 + index).toString(16).toUpperCase()}">${pPr}<w:r>${rPr}<w:t>${text}</w:t></w:r></w:p>`;
  }).join('');
  zip.folder('word').file('document.xml', `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml"><w:body>${body}<w:sectPr/></w:body></w:document>`);
  await (await import('node:fs/promises')).writeFile(path, await zip.generateAsync({type:'nodebuffer'}));
}

async function setupProject() {
  const {dir, config, files} = await fixture();
  const projectRoot = join(dir, 'project'); await mkdir(projectRoot);
  const projects = new ProjectService(config, new Store(join(dir, 'project-global.sqlite')), files);
  const init = projects.previewInit(projectRoot, 'Project', 'document'); projects.applyInit(init.actionId, init.confirmationToken);
  const documents = new DocumentService(config, new Store(join(dir, 'document-global.sqlite')), files, projects);
  return {dir, config, files, projectRoot, projects, documents};
}

test('multi-document maps keep identical logical IDs isolated by document ID', async () => {
  const {projectRoot, projects, documents} = await setupProject();
  const lines = ['CHƯƠNG I. QUY ĐỊNH CHUNG', 'Điều 1. Nội dung', '1. Khoản một.', 'Điều 2. Nội dung khác', '1. Khoản hai.'];
  for (const id of ['charter', 'finance', 'operations']) {
    const path = join(projectRoot, `${id}.docx`); await makeStructuredDocx(path, lines); await documents.index(projectRoot, path, id);
    assert.equal(projects.getNode(projectRoot, id, 'article:1').documentId, id);
  }
  const finance = join(projectRoot, 'finance.docx');
  const preview = await documents.previewReplace(projectRoot, 'finance', 'article:1', [{type:'article', text:'Điều 1. Finance only'}, {type:'clause', text:'1. Edited finance clause.'}]);
  await documents.applyReplace(preview.actionId, preview.confirmationToken);
  const charterXml = await (await JSZip.loadAsync(await readFile(join(projectRoot, 'charter.docx')))).file('word/document.xml').async('string');
  const financeXml = await (await JSZip.loadAsync(await readFile(finance))).file('word/document.xml').async('string');
  assert.match(charterXml, /Điều 1\. Nội dung/); assert.match(financeXml, /Finance only/);
});

test('semantic DOCX ranges preserve first middle last clauses and neighboring articles', async () => {
  const {projectRoot, projects, documents} = await setupProject(); const path = join(projectRoot, 'charter.docx');
  await makeStructuredDocx(path, ['CHƯƠNG I. QUY ĐỊNH CHUNG', 'Điều 1. Vốn góp', '1. Khoản một.', '2. Khoản hai.', '3. Khoản ba.', '4. Khoản bốn.', 'Điều 2. Điều không đổi', '1. Khoản điều hai.', 'Điều 3. Kết thúc']);
  await documents.index(projectRoot, path, 'charter');
  for (const [node, text] of [['article:1:clause:1', '1. First changed.'], ['article:1:clause:2', '2. Middle changed.'], ['article:1:clause:4', '4. Last changed.']]) {
    const preview = await documents.previewReplace(projectRoot, 'charter', node, [{type:'clause', text}]); await documents.applyReplace(preview.actionId, preview.confirmationToken);
  }
  let xml = await (await JSZip.loadAsync(await readFile(path))).file('word/document.xml').async('string');
  assert.match(xml, /First changed/); assert.match(xml, /Middle changed/); assert.match(xml, /Khoản ba/); assert.match(xml, /Last changed/); assert.match(xml, /Điều 2\. Điều không đổi/);
  const article = await documents.previewReplace(projectRoot, 'charter', 'article:2', [{type:'article', text:'Điều 2. Đã sửa'}, {type:'clause', text:'1. Nội dung Điều 2 mới.'}]); await documents.applyReplace(article.actionId, article.confirmationToken);
  const end = await documents.previewReplace(projectRoot, 'charter', 'article:3', [{type:'article', text:'Điều 3. Đã sửa cuối văn bản'}]); await documents.applyReplace(end.actionId, end.confirmationToken);
  xml = await (await JSZip.loadAsync(await readFile(path))).file('word/document.xml').async('string'); assert.match(xml, /Điều 2\. Đã sửa/); assert.match(xml, /Điều 3\. Đã sửa cuối văn bản/);
  assert.equal(projects.getNode(projectRoot, 'charter', 'article:3').title, 'Điều 3. Đã sửa cuối văn bản');
});

test('context budget is strict with huge documents decisions graph and search candidates', async () => {
  const {projectRoot, projects, documents} = await setupProject(); const path = join(projectRoot, 'large.docx');
  const clauses = Array.from({length: 60}, (_, index) => `${index + 1}. Vốn góp và thời hạn thực hiện ${'chi tiết '.repeat(80)}`);
  await makeStructuredDocx(path, ['CHƯƠNG I. QUY ĐỊNH CHUNG', 'Điều 1. Vốn góp', ...clauses, 'Điều 2. Thời hạn góp vốn', ...clauses]); await documents.index(projectRoot, path, 'large');
  for (let index = 0; index < 50; index++) { const preview = projects.previewDecision(projectRoot, {id:`DEC-${index}`, title:`Capital ${index}`, value:'Vốn góp '.repeat(120), status:index % 2 ? 'proposed' : 'verified'}); projects.applyDecision(preview.actionId, preview.confirmationToken); }
  for (const budget of [2000, 8000, 24000]) { const pack = projects.context(projectRoot, 'large', 'article:1', 'Sửa vốn góp chi tiết và thời hạn', budget); assert.ok(pack.usedTokens <= budget, `${pack.usedTokens} must be <= ${budget}`); assert.equal(pack.remainingTokens, budget - pack.usedTokens); assert.ok(pack.workingSet.length > 0); }
});

test('semantic edit is atomic when map commit is intentionally failed', async () => {
  const {projectRoot, projects, documents} = await setupProject(); const path = join(projectRoot, 'atomic.docx'); await makeDocx(path); await documents.index(projectRoot, path, 'atomic');
  const before = await readFile(path); const oldNode = projects.getNode(projectRoot, 'atomic', 'article:1'); documents.failBeforeMapCommit = true;
  const preview = await documents.previewReplace(projectRoot, 'atomic', 'article:1', [{type:'article', text:'Điều 1. Failing edit'}]);
  await assert.rejects(() => documents.applyReplace(preview.actionId, preview.confirmationToken), /Injected failure/);
  documents.failBeforeMapCommit = false; assert.deepEqual(await readFile(path), before); assert.equal(projects.getNode(projectRoot, 'atomic', 'article:1').text, oldNode.text);
});

test('project state and decision lifecycle persist across a new service instance', async () => {
  const {dir, config, files, projectRoot, projects} = await setupProject();
  const proposed = projects.previewDecision(projectRoot, {id:'DEC-P', title:'Minimum capital', value:'10 million', status:'proposed'}); projects.applyDecision(proposed.actionId, proposed.confirmationToken);
  const confirm = projects.previewConfirmDecision(projectRoot, 'DEC-P'); projects.applyDecision(confirm.actionId, confirm.confirmationToken);
  const reopened = new ProjectService(config, new Store(join(dir, 'reopened.sqlite')), files); assert.equal(reopened.listDecisions(projectRoot)[0].status, 'confirmed'); assert.equal(reopened.status(projectRoot).name, 'Project');
});

test('document QA reports duplicate and missing structure plus invalid references', async () => {
  const {projectRoot, documents} = await setupProject(); const path = join(projectRoot, 'qa.docx');
  await makeStructuredDocx(path, ['Điều 1. Một', '1. Khoản một.', '1. Khoản trùng.', 'Theo Điều 99, Khoản 2.', 'Điều 3. Ba', '2. Khoản nhảy số.']); await documents.index(projectRoot, path, 'qa');
  const qa = documents.consistency(projectRoot, 'qa'); const reasons = qa.findings.map((item) => item.reason).join('\n'); assert.match(reasons, /Duplicate clause/); assert.match(reasons, /Missing Article/); assert.match(reasons, /Referenced Article 99/);
});

test('project memory, document map, bounded context and semantic DOCX edit preserve body formatting', async () => {
  const {dir, config, files} = await fixture();
  const projectRoot = join(dir, 'HTX'); await mkdir(projectRoot);
  const projects = new ProjectService(config, new Store(join(dir, 'project-global.sqlite')), files);
  const init = projects.previewInit(projectRoot, 'HTX', 'document');
  projects.applyInit(init.actionId, init.confirmationToken);
  const proposed = projects.previewDecision(projectRoot, {title:'Minimum capital', value:'10 million', status:'proposed'});
  projects.applyDecision(proposed.actionId, proposed.confirmationToken);
  assert.equal(projects.listDecisions(projectRoot)[0].status, 'proposed');
  const confirm = projects.previewConfirmDecision(projectRoot, projects.listDecisions(projectRoot)[0].id);
  projects.applyDecision(confirm.actionId, confirm.confirmationToken);
  assert.equal(projects.listDecisions(projectRoot)[0].status, 'confirmed');
  const path = join(projectRoot, 'charter.docx'); await makeDocx(path);
  const documents = new DocumentService(config, new Store(join(dir, 'document-global.sqlite')), files, projects);
  const indexed = await documents.index(projectRoot, path, 'charter');
  assert.ok(indexed.nodeCount >= 4);
  const pack = projects.context(projectRoot, 'charter', 'article:1', 'Sửa Điều 1 về vốn góp', 2000);
  assert.equal(pack.target, 'article:1');
  assert.ok(pack.workingSet.length < indexed.nodeCount);
  const preview = await documents.previewReplace(projectRoot, 'charter', 'article:1', [
    {type:'article', text:'Điều 1. Vốn góp'},
    {type:'clause', text:'1. Thành viên góp vốn theo quy định tại Điều 2 và được ghi nhận đầy đủ.'},
    {type:'clause', text:'2. Việc góp vốn được theo dõi riêng theo sổ thành viên.'},
  ]);
  await documents.applyReplace(preview.actionId, preview.confirmationToken);
  const reindexed = await documents.index(projectRoot, path, 'charter');
  assert.equal(projects.getNode(projectRoot, 'charter', 'article:2').anchor.paraId, 'A004');
  const out = await JSZip.loadAsync(await readFile(path)); const docXml = await out.file('word/document.xml').async('string');
  assert.match(docXml, /Điều 2\. Thời hạn góp vốn/);
  assert.match(docXml, /<w:jc w:val="both"\/>[\s\S]*?Thành viên góp vốn/);
  assert.ok(reindexed.nodeCount >= 5);
});



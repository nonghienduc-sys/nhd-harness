import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const registryDir = join(root, 'src', 'mcp-registries');
const domains = ['execution-tools.ts','files-tools.ts','context-tools.ts','office-tools.ts','browser-tools.ts','media-tools.ts'];

test('MCP tool ownership is split into six domain registries', () => {
  for (const file of domains) assert.equal(existsSync(join(registryDir, file)), true, `${file} must exist`);
  const mcp = readFileSync(join(root, 'src', 'mcp.ts'), 'utf8');
  assert.equal((mcp.match(/server\.registerTool\(/g) ?? []).length, 0, 'mcp.ts must compose registries instead of owning tool registrations');
  for (const fn of ['registerExecutionPlatformTools','registerFilesTools','registerExecutionTerminalTools','registerContextTools','registerOfficeTools','registerBrowserTools','registerMediaTools','registerProjectDocumentTools']) assert.match(mcp, new RegExp(`${fn}\\(registryContext\\)`));
});

test('all domain registrations continue through server.registerTool so Governor interception remains cross-cutting', () => {
  let direct = 0;
  for (const file of domains) {
    const text = readFileSync(join(registryDir, file), 'utf8');
    direct += (text.match(/server\.registerTool\(/g) ?? []).length;
  }
  assert.ok(direct >= 70, `expected the full tool surface in domain registries, got ${direct} literal registrations`);
  const mcp = readFileSync(join(root, 'src', 'mcp.ts'), 'utf8');
  assert.match(mcp, /\(server as any\)\.registerTool =/);
  assert.match(mcp, /governor\.intercept\(/);
});

test('registry modules retain expected domain anchors', () => {
  const expected = {
    'execution-tools.ts':['execution_lanes_status','tool_governor','runtime_identity','workstation_plan','terminal_preview'],
    'files-tools.ts':['skills_list','fs_read','fs_apply_','project_open','document_index'],
    'context-tools.ts':['task_run','task_plan','context_bootstrap','context_image_memory'],
    'office-tools.ts':['office_status','office_live_read','office_live_transaction','outlook_search'],
    'browser-tools.ts':['coc_coc_status','browser_navigate','browser_batch'],
    'media-tools.ts':['screen_capture','desktop_inspect','intake_files','pdf_document','video_understand'],
  };
  for (const [file,names] of Object.entries(expected)) {
    const text=readFileSync(join(registryDir,file),'utf8');
    for (const name of names) assert.ok(text.includes(name), `${file} missing ${name}`);
  }
});

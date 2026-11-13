import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CocCocBridgeService } from '../dist/coc-coc-bridge.js';

function pulse(service, id, url, active = false) {
  return service.pulse({
    tabId: id, windowId: 100, url, title: url.includes('youtube') ? 'YouTube' : 'STUDY4',
    active, focused: active, visible: active, bridgeVersion: '0.4.1'
  });
}

test('all-browser tab inventory is distinct from recently connected DOM tabs', async () => {
  const bridge = new CocCocBridgeService({ audit() {} });
  pulse(bridge, 2, 'https://www.youtube.com/watch?v=test', true);
  assert.equal(bridge.listTabs().length, 1);
  const inventoryPromise = bridge.tabAction({ action: 'list' });
  const delivered = pulse(bridge, 2, 'https://www.youtube.com/watch?v=test', true);
  assert.equal(delivered.commands.length, 1);
  assert.equal(delivered.commands[0].type, 'browser_command');
  assert.equal(delivered.commands[0].payload.action, 'list_tabs');
  bridge.resolveResult({
    id: delivered.commands[0].id,
    ok: true,
    result: { tabs: [
      { tabId: 1, title: 'ChatGPT', url: 'https://chatgpt.com/' },
      { tabId: 2, title: 'YouTube', url: 'https://www.youtube.com/' },
      { tabId: 46, title: 'STUDY4', url: 'https://study4.com/courses/28/complete-toeic/learn/activities/7560/' }
    ]}
  });
  const inventory = await inventoryPromise;
  assert.equal(inventory.tabs.length, 3, 'background browser inventory sees all real tabs');
  assert.equal(bridge.listTabs().length, 1, 'DOM connections remain distinct from browser inventory');
  assert.equal(inventory.tabs.find(t => t.tabId === 46).title, 'STUDY4');
  // Once the hidden tab DOM Bridge is available, read it by the actual tab ID
  // without first switching the visible tab.
  pulse(bridge, 46, 'https://study4.com/courses/28/complete-toeic/learn/activities/7560/', false);
  const read = bridge.snapshot(46, 1000);
  const command = pulse(bridge, 46, 'https://study4.com/courses/28/complete-toeic/learn/activities/7560/', false);
  assert.equal(command.commands[0].type, 'snapshot');
  bridge.resolveResult({ id:command.commands[0].id, ok:true, result:{
    page:{visibilityState:'hidden',url:'https://study4.com/'}, text:'STUDY4 lesson available'
  }});
  const result = await read;
  assert.equal(result.text, 'STUDY4 lesson available');
  assert.equal(result.page.visibilityState, 'hidden');
});

test('tool guidance forbids interpreting connected-only tab lists as all open tabs', () => {
  const src = readFileSync(new URL('../src/mcp-registries/browser-tools.ts', import.meta.url), 'utf8');
  const instructions = readFileSync(new URL('../src/server-instructions.ts', import.meta.url), 'utf8');
  assert.match(src, /NEVER infer that a tab is closed/);
  assert.match(src, /action=list enumerates ALL real open Cốc Cốc tabs/);
  assert.match(src, /Select the matching tab_id and call coc_coc_page or coc_coc_snapshot directly/);
  assert.match(instructions, /CỐC CỐC TAB DISCOVERY/);
  assert.match(instructions, /30 seconds and cannot prove/);
});

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const srcDir = path.join(__dirname, '..');

test('large DOM scans yield back to the event loop and offload text normalization', async () => {
  let tick = 0, yielded = 0, startup;
  const responses = [], commands = [], offloads = [];
  let queryAllStar = 0, visits = 0;
  const synthetic = { tagName: 'DIV', shadowRoot: null };
  const document = {
    nodeType: 9,
    documentElement: { dataset: {}, scrollHeight: 1000 },
    body: { innerText: 'A'.repeat(36000) + '\n\n\nB' },
    title: 'Synthetic large page',
    readyState: 'complete',
    visibilityState: 'visible',
    hasFocus() { return true; },
    addEventListener() {},
    createTreeWalker() {
      let current = 0;
      return {
        nextNode() {
          if (current++ >= 12000) return null;
          visits += 1;
          return synthetic;
        }
      };
    },
    querySelectorAll(selector) {
      if (selector === '*') { queryAllStar++; throw Error('global querySelectorAll forbidden'); }
      return [];
    }
  };
  const env = {
    document,
    location: { href: 'https://example.test/', hostname: 'example.test', port: '' },
    innerHeight: 700, innerWidth: 1100, scrollX: 0, scrollY: 0,
    performance: { now() { tick += 1.0; return tick; } },
    setInterval() {},
    setTimeout(callback, ms) {
      if (ms === 150) startup = callback;
      else if (ms === 0) { yielded++; setImmediate(callback); }
      return 1;
    },
    getComputedStyle() { return { display: 'block', visibility: 'visible', opacity: 1 }; },
    window: { addEventListener() {} },
    chrome: {
      runtime: {
        async sendMessage(message) {
          if (message.type === 'NHD_COC_COC_DOM_PULSE') return { commands: commands.splice(0) };
          if (message.type === 'NHD_COC_COC_DOM_RESULT') {
            responses.push(message.payload); return { ok: true };
          }
          if (message.type === 'NHD_COC_COC_TEXT_NORMALIZE') {
            offloads.push(message.payload);
            return { ok: true, text: message.payload.text.replace(/\n{3,}/g, '\n\n').trim() };
          }
          throw Error('unexpected message: ' + message.type);
        }
      }
    }
  };
  vm.runInNewContext(fs.readFileSync(path.join(srcDir, 'dom-bridge.js'), 'utf8'), env);
  assert.ok(startup);
  commands.push({ id: 'snap-1', type: 'snapshot', payload: { maxChars: 50000 } });
  startup();
  for (let i = 0; i < 300 && responses.length === 0; i++) {
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.equal(responses.length, 1, 'snapshot should eventually respond');
  assert.equal(responses[0].ok, true, JSON.stringify(responses[0]));
  assert.equal(responses[0].result.text.includes('A'.repeat(50)), true);
  assert.equal(responses[0].result.text.includes('\n\nB'), true);
  assert.equal(visits, 12000, 'TreeWalker traverses the DOM without bulk NodeList');
  assert.equal(queryAllStar, 0, 'never queries all DOM nodes synchronously');
  assert.ok(yielded > 2, 'must repeatedly yield main thread for large DOM');
  assert.equal(offloads.length, 1, 'large text normalization moves to background');
  assert.equal(offloads[0].maxChars, 50000);
});

test('background worker normalizes only bounded plain text and returns without network calls', async () => {
  const listeners = [];
  let networkCalls = 0;
  const env = {
    URL,
    fetch() { networkCalls++; throw Error('no network requests permitted for text normalization'); },
    chrome: {
      runtime: { onMessage: { addListener(fn) { listeners.push(fn); } }, onInstalled: { addListener() {} }, onStartup: { addListener() {} } },
      storage: { local: { async get() { return {}; } }, session: { async get() { return {}; }, async set() {} } },
      tabs: {
        async query() { return []; },
        onRemoved: { addListener() {} }
      },
      action: { setBadgeText() {}, setBadgeBackgroundColor() {} }
    }
  };
  vm.runInNewContext(fs.readFileSync(path.join(srcDir, 'background.js'), 'utf8'), env);
  assert.equal(listeners.length, 1);
  let returned;
  const handled = listeners[0]({
    type: 'NHD_COC_COC_TEXT_NORMALIZE',
    payload: { text: ' Hello\n\n\nworld!  ', maxChars: 1000 }
  }, { tab: { id: 1 } }, x => { returned = x; });
  assert.equal(handled, false, 'background responds synchronously');
  assert.equal(returned.ok, true);
  assert.equal(returned.text, 'Hello\n\nworld!');
  assert.equal(networkCalls, 0);
});

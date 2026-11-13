'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');

test('snapshot reuses one root walk and preserves same-origin iframes and open shadow roots', async () => {
  const scans = { document: 0, shadow: 0, frame: 0 };
  const responses = [];
  let commands = [];
  let startup = null;
  let layoutChecks = 0;

  function element(tagName, name, href = '') {
    return {
      tagName,
      textContent: name,
      innerText: name,
      href,
      isConnected: true,
      getAttribute(key) { return key === 'aria-label' ? name : ''; },
      hasAttribute() { return false; },
      getBoundingClientRect() { return { x: 0, y: 0, width: 150, height: 25 }; }
    };
  }
  const headingMain = element('H1', 'Main title');
  const headingShadow = element('H2', 'Shadow title');
  const headingFrame = element('H3', 'Frame title');
  const linkMain = element('A', 'Main link', 'https://example.test/main');
  const linkShadow = element('A', 'Shadow link', 'https://example.test/shadow');
  const linkFrame = element('A', 'Frame link', 'https://example.test/frame');
  const magicButton = element('BUTTON', 'Magic action');
  const otherButton = element('BUTTON', 'Other action');
  const iframe = { tagName: 'IFRAME', get contentDocument() { return frameDocument; } };
  const shadow = {
    querySelectorAll(selector) {
      if (selector === '*') { scans.shadow++; return []; }
      if (selector === 'h1,h2,h3,h4,h5,h6') return [headingShadow];
      if (selector === 'a[href]') return [linkShadow];
      return [];
    }
  };
  const host = { tagName: 'DIV', shadowRoot: shadow };
  const frameDocument = {
    body: { innerText: 'Frame body' },
    querySelectorAll(selector) {
      if (selector === '*') { scans.frame++; return []; }
      if (selector === 'h1,h2,h3,h4,h5,h6') return [headingFrame];
      if (selector === 'a[href]') return [linkFrame];
      return [];
    }
  };
  const document = {
    documentElement: { dataset: {}, scrollHeight: 1000 },
    body: { innerText: 'Main body' },
    title: 'Example',
    readyState: 'complete',
    visibilityState: 'visible',
    querySelectorAll(selector) {
      if (selector === '*') { scans.document++; return [host, iframe]; }
      if (selector === 'h1,h2,h3,h4,h5,h6') return [headingMain];
      if (selector === 'a[href]') return [linkMain];
      if (selector.includes('a,button,input,textarea')) return [otherButton, magicButton];
      return [];
    },
    hasFocus() { return true; },
    addEventListener() {}
  };
  const env = {
    document,
    location: { hostname: 'example.test', href: 'https://example.test/', port: '' },
    innerHeight: 650, innerWidth: 1200, scrollX: 0, scrollY: 0,
    crypto: webcrypto,
    getComputedStyle() { layoutChecks++; return { display: 'block', visibility: 'visible', opacity: 1 }; },
    setTimeout(callback, ms) { if (ms === 150) startup = callback; return 1; },
    setInterval() { return 2; },
    window: { addEventListener() {} },
    chrome: {
      runtime: {
        async sendMessage(message) {
          if (message.type === 'NHD_COC_COC_DOM_PULSE') return { commands: commands.splice(0) };
          if (message.type === 'NHD_COC_COC_DOM_RESULT') {
            responses.push(message.payload);
            return { ok: true };
          }
          return { ok: false };
        }
      }
    }
  };
  const source = fs.readFileSync(path.join(__dirname, '..', 'dom-bridge.js'), 'utf8');
  vm.runInNewContext(source, env, { filename: 'dom-bridge.js' });
  assert.ok(startup, 'bridge should initialize');

  async function dispatch(command) {
    commands.push(command);
    startup();
    for (let i = 0; i < 15 && !responses.some(x => x.id === command.id); i++) {
      await new Promise(resolve => setImmediate(resolve));
    }
    const response = responses.find(x => x.id === command.id);
    assert.ok(response, 'command must return: ' + command.id);
    assert.equal(response.ok, true, JSON.stringify(response));
    return response.result;
  }

  const snapshot = await dispatch({ id: 'snapshot-1', type: 'snapshot', payload: { maxChars: 2000 } });
  assert.equal(snapshot.documents, 2);
  assert.ok(snapshot.text.includes('Main body'));
  assert.ok(snapshot.text.includes('Frame body'));
  assert.equal(snapshot.headings.length, 3);
  assert.equal(snapshot.links.length, 3);
  assert.equal(scans.document, 1, 'main document scanned once, not three times');
  assert.equal(scans.shadow, 1, 'shadow root scanned once');
  assert.equal(scans.frame, 1, 'iframe scanned once');

  layoutChecks = 0;
  const inspected = await dispatch({ id: 'inspect-2', type: 'inspect', payload: { query: 'Magic', limit: 10 } });
  assert.equal(inspected.controls.length, 1);
  assert.equal(inspected.controls[0].text, 'Magic action');
  assert.equal(layoutChecks, 1, 'only matching control requires a style/visibility check');
  assert.equal(scans.document, 2, 'second requested command scans once');
});

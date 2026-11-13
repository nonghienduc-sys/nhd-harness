'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const root = path.join(__dirname, '..');

test('DOM bridge reinjects after extension reload even when document marker remains', () => {
  const doc = { documentElement: { dataset: {} }, addEventListener() {} };
  const source = fs.readFileSync(path.join(root, 'dom-bridge.js'), 'utf8');
  function environment() {
    const timers = [];
    const callbacks = [];
    return {
      timers, callbacks, document: doc,
      location: { hostname: 'study4.com', port: '', pathname: '/', href: 'https://study4.com/' },
      window: { addEventListener(name, callback) { callbacks.push([name, callback]); } },
      setTimeout(callback, interval) { timers.push(['timeout', interval]); return 1; },
      setInterval(callback, interval) { timers.push(['interval', interval]); return 2; }
    };
  }
  const first = environment();
  vm.runInNewContext(source, first);
  assert.equal(first.timers.filter(t => t[0] === 'interval' && t[1] === 600).length, 1);
  assert.equal(doc.documentElement.dataset.nhdCocCocDomBridgeVersion, '0.4.1');
  vm.runInNewContext(source, first);
  assert.equal(first.timers.filter(t => t[0] === 'interval' && t[1] === 600).length, 1, 'same world must not duplicate timers');

  const refreshedWorld = environment(); // same DOM, new extension isolated world
  vm.runInNewContext(source, refreshedWorld);
  assert.equal(refreshedWorld.timers.filter(t => t[0] === 'interval' && t[1] === 600).length, 1, 'new world must bootstrap despite old DOM marker');
  assert.ok(refreshedWorld.callbacks.some(([name]) => name === 'focus'));
});

test('Chat Health sensor reinjects into ChatGPT page despite stale DOM marker', () => {
  const doc = {
    documentElement: { dataset: {} },
    querySelectorAll() { return []; },
    getElementsByTagName() { return []; },
    visibilityState: 'visible', hasFocus() { return true; }, addEventListener() {}
  };
  const source = fs.readFileSync(path.join(root, 'content.js'), 'utf8');
  function environment() {
    const intervals = [];
    return {
      document: doc,
      location: { pathname: '/c/test', href: 'https://chatgpt.com/c/test' },
      window: { addEventListener() {} },
      performance: { now: () => 10000, memory: { usedJSHeapSize: 1024 } },
      Node: { ELEMENT_NODE: 1 },
      MutationObserver: class { observe() {} },
      PerformanceObserver: class { observe() {} },
      requestAnimationFrame() {},
      setTimeout() { return 1; },
      setInterval(_fn, ms) { intervals.push(ms); return intervals.length; },
      clearTimeout() {},
      chrome: { runtime: { async sendMessage() { return { ok: true }; } } },
      intervals
    };
  }
  const original = environment();
  vm.runInNewContext(source, original);
  assert.ok(original.intervals.includes(30000), 'sensor installed');
  assert.equal(doc.documentElement.dataset.nhdChatHealthSensorVersion, '0.2.7');
  const before = original.intervals.length;
  vm.runInNewContext(source, original);
  assert.equal(original.intervals.length, before, 'no duplicate listeners in same world');
  const reloaded = environment();
  vm.runInNewContext(source, reloaded);
  assert.ok(reloaded.intervals.includes(30000), 'new world should install even if original dataset is unchanged');
});

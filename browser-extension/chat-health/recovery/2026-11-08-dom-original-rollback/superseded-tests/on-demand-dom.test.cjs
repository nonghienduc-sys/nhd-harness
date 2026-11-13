'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

test('NHD telemetry does not repeatedly scan DOM; conversation changes trigger a debounced scan', async () => {
  const intervals = [];
  const timeouts = [];
  const observers = [];
  let allElementQueries = 0;
  let nodeCounts = 0;
  let sends = 0;
  const doc = {
    documentElement: { dataset: {} },
    querySelectorAll() { allElementQueries++; return []; },
    getElementsByTagName() { nodeCounts++; return []; },
    visibilityState: 'visible',
    hasFocus() { return true; },
    addEventListener() {}
  };
  const env = {
    document: doc,
    location: { pathname: '/c/test' },
    window: { addEventListener() {} },
    performance: { now: () => 10000, memory: { usedJSHeapSize: 1024 } },
    Node: { ELEMENT_NODE: 1 },
    MutationObserver: class {
      constructor(callback) { this.callback = callback; observers.push(this); }
      observe() {}
    },
    PerformanceObserver: class { observe() {} },
    requestAnimationFrame() {},
    setInterval(callback, delay) { intervals.push({ callback, delay }); return intervals.length; },
    setTimeout(callback, delay) { timeouts.push({ callback, delay }); return timeouts.length; },
    clearTimeout() {},
    chrome: { runtime: { async sendMessage() { sends++; return { ok: true }; } } }
  };
  const source = fs.readFileSync(path.join(__dirname, '..', 'content.js'), 'utf8');
  vm.runInNewContext(source, env, { filename: 'content.js' });
  assert.equal(intervals.some(item => item.delay === 2000), false, 'must not reattach DOM observers every 2 seconds');
  assert.equal(intervals.some(item => item.delay === 30000), true, 'lightweight telemetry timer preserved');
  assert.equal(observers.length > 0, true, 'event-driven observer installed');

  const initial = timeouts.find(item => item.delay === 1000);
  assert.ok(initial, 'initial chat recovery should still work');
  initial.callback();
  await Promise.resolve(); await Promise.resolve();
  const beforeQueries = allElementQueries;
  const beforeCounts = nodeCounts;

  intervals.find(item => item.delay === 30000).callback();
  await Promise.resolve(); await Promise.resolve();
  assert.equal(allElementQueries, beforeQueries, 'telemetry must reuse cache, no deep query');
  assert.equal(nodeCounts, beforeCounts, 'telemetry must not count all DOM nodes');

  observers[0].callback([{ target: { nodeType: 1, closest() { return true; } }, addedNodes: [] }]);
  const debounced = timeouts.filter(item => item.delay === 1200);
  assert.equal(debounced.length, 1, 'event scan should be delayed and deduplicated');
  debounced[0].callback();
  await Promise.resolve(); await Promise.resolve();
  assert.ok(allElementQueries > beforeQueries, 'actual content change must trigger new DOM scan');
  assert.ok(nodeCounts > beforeCounts, 'actual content change must refresh DOM statistics');
  assert.ok(sends >= 1);
});

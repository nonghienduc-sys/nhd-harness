import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChatHealthService } from '../dist/chat-health.js';

const healthy = (tabId, conversationId, extra = {}) => ({ tabId, windowId: 1, conversationId, pagePath: conversationId, pageTitle: `Chat ${tabId}`, url: `https://chatgpt.com${conversationId}`, inpMs: 90, fps: 60, heapMb: 220, domNodes: 9000, longTasksPerMin: 0, sessionMinutes: 1, ...extra });
const heavy = (tabId, conversationId, extra = {}) => ({ tabId, windowId: 1, conversationId, pagePath: conversationId, pageTitle: `Chat ${tabId}`, url: `https://chatgpt.com${conversationId}`, inpMs: 700, fps: 20, heapMb: 700, domNodes: 32000, longTasksPerMin: 20, sessionMinutes: 100, ...extra });

test('multi-tab chat health starts empty with sane defaults', () => {
  const service = new ChatHealthService();
  const status = service.status();
  assert.equal(status.available, false);
  assert.equal(status.reason, 'No ChatGPT tab telemetry has been received yet.');
  assert.equal(status.overview.totalTabs, 0);
  assert.deepEqual(status.settings, { autoCheckpointEnabled: true, handoffThreshold: 65, requiredStreak: 3, cooldownMinutes: 10, historyDays: 7, activeSeconds: 30, staleMinutes: 5, tokenBudget: 128000 });
  service.close();
});

test('two tabs maintain independent score, baseline and history', () => {
  const service = new ChatHealthService();
  let a, b;
  for (let i = 0; i < 6; i++) {
    a = service.report(healthy(11, '/c/a', { turns: 10 + i }));
    b = service.report(healthy(12, '/c/b', { turns: 20 + i }));
  }
  for (let i = 0; i < 3; i++) b = service.report(heavy(12, '/c/b', { turns: 50 + i }));
  assert.equal(a.tabKey, '11:/c/a');
  assert.equal(b.tabKey, '12:/c/b');
  assert.ok(a.score >= 80);
  assert.ok(b.score < 65);
  assert.equal(b.automation.streak, 3);
  assert.equal(b.automation.due, true);
  const tabs = service.listTabs();
  assert.equal(tabs.overview.totalTabs, 2);
  assert.equal(tabs.overview.worstTabKey, b.tabKey);
  assert.equal(service.history(a.tabKey, 30).samples.length, 6);
  assert.equal(service.history(b.tabKey, 30).samples.length, 9);
  service.close();
});

test('same conversation opened in two browser tabs stays isolated by tabId', () => {
  const service = new ChatHealthService();
  let left, right;
  for (let i = 0; i < 6; i++) {
    left = service.report(healthy(21, '/c/shared'));
    right = service.report(healthy(22, '/c/shared'));
  }
  right = service.report(heavy(22, '/c/shared'));
  assert.notEqual(left.tabKey, right.tabKey);
  assert.equal(service.history(left.tabKey, 20).samples.length, 6);
  assert.equal(service.history(right.tabKey, 20).samples.length, 7);
  service.close();
});

test('handoff state for tab B never changes tab A', () => {
  const service = new ChatHealthService();
  let a, b;
  for (let i = 0; i < 6; i++) {
    a = service.report(healthy(31, '/c/a'));
    b = service.report(healthy(32, '/c/b'));
  }
  for (let i = 0; i < 3; i++) b = service.report(heavy(32, '/c/b'));
  const marked = service.markAutoCheckpoint(b, 77);
  assert.equal(marked.automation.handoffReady, true);
  assert.equal(marked.automation.checkpointSequence, 77);
  assert.equal(service.getTab(a.tabKey).automation.handoffReady, false);
  const ack = service.acknowledgeHandoff(b.tabKey);
  assert.equal(ack.acknowledged, true);
  assert.equal(service.getTab(b.tabKey).automation.handoffReady, false);
  assert.equal(service.getTab(a.tabKey).automation.handoffReady, false);
  service.close();
});

test('per-tab history and tab registry persist across service restart', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nhd-multitab-health-'));
  try {
    const first = new ChatHealthService({ dataDir: dir });
    for (let i = 0; i < 6; i++) {
      first.report(healthy(41, '/c/persist-a', { sessionMinutes: i }));
      first.report(healthy(42, '/c/persist-b', { sessionMinutes: i }));
    }
    first.close();
    const second = new ChatHealthService({ dataDir: dir });
    const tabs = second.listTabs();
    assert.equal(tabs.overview.totalTabs, 2);
    assert.equal(second.getTab('41:/c/persist-a').baselineReady, true);
    assert.equal(second.getTab('42:/c/persist-b').baselineReady, true);
    assert.equal(second.history('41:/c/persist-a', 20).samples.length, 6);
    assert.equal(second.history('42:/c/persist-b', 20).samples.length, 6);
    second.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('presence changes from active to idle to stale without affecting score', () => {
  let clock = Date.parse('2026-09-14T00:00:00Z');
  const service = new ChatHealthService({ now: () => clock });
  for (let i = 0; i < 6; i++) service.report(healthy(51, '/c/presence'));
  const key = '51:/c/presence';
  assert.equal(service.getTab(key).presence, 'active');
  clock += 31_000;
  assert.equal(service.getTab(key).presence, 'idle');
  clock += 5 * 60_000;
  assert.equal(service.getTab(key).presence, 'stale');
  service.close();
});

test('archive removes one tab from active overview while preserving its history', () => {
  const service = new ChatHealthService();
  for (let i = 0; i < 6; i++) {
    service.report(healthy(61, '/c/keep'));
    service.report(healthy(62, '/c/archive'));
  }
  const result = service.archiveTab('62:/c/archive');
  assert.equal(result.archived, true);
  assert.equal(service.listTabs().overview.totalTabs, 1);
  assert.equal(service.listTabs(true).tabs.find(t => t.tabKey === '62:/c/archive').presence, 'archived');
  assert.equal(service.history('62:/c/archive', 20).samples.length, 6);
  service.close();
});


test('estimated token telemetry is stored per tab and token budget is configurable', () => {
  const service = new ChatHealthService();
  const view = service.report(healthy(71, '/c/tokens', {
    estimatedTokens: 12000,
    estimatedUserTokens: 4000,
    estimatedAssistantTokens: 8000,
    textChars: 48000,
    tokenEstimateMethod: 'local-visible-text-v1'
  }));
  assert.equal(view.estimatedTokens, 12000);
  assert.equal(view.estimatedUserTokens, 4000);
  assert.equal(view.estimatedAssistantTokens, 8000);
  assert.equal(view.tokenEstimateMethod, 'local-visible-text-v1');
  assert.equal(service.history(view.tabKey, 20).samples.at(-1).estimatedTokens, 12000);
  assert.equal(service.listTabs().overview.highestEstimatedTokens, 12000);
  const settings = service.updateSettings({ tokenBudget: 200000 });
  assert.equal(settings.tokenBudget, 200000);
  service.close();
});

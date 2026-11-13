import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserOrchestrator } from '../dist/browser-orchestrator.js';

const capabilities = async () => ({
  files:{read:true,write:true},
  office:{offlineRead:true,offlineWrite:true,liveRead:true,liveWrite:true,applications:{word:true,excel:true,powerpoint:true,outlook:true},liveWriteApplications:{word:true,excel:false,powerpoint:false,outlook:false}},
  browser:{enabled:true,dom:true,screenshot:true},
  desktop:{enabled:true,uia:true,visual:true},
  terminal:{enabled:true}, intake:{enabled:true}, pdf:{enabled:true},
});

function fakeBrowser({waitFails=false,fillWaitFails=false}={}) {
  let clickCount = 0;
  let fillCount = 0;
  let inspectCount = 0;
  let waitCount = 0;
  const browser = {
    status: async () => ({activePage:{title:'Before',url:'https://example.com/'}}),
    click: async selectorId => { clickCount++; return {ok:true,page:{title:'After click',url:'https://example.com/next'},control:{selectorId}}; },
    fill: async () => { fillCount++; return {ok:true}; },
    waitForCondition: async condition => {
      waitCount++;
      if ((condition.kind === 'value' && fillWaitFails) || (condition.kind !== 'value' && waitFails)) throw new Error('post-condition timeout');
      return {matched:true,waitedMs:10,condition,page:{title:'Verified',url:'https://example.com/next'},evidence:{}};
    },
    inspect: async () => { inspectCount++; return {page:{title:'Recovered',url:'https://example.com/next'},controls:[{selectorId:'fresh'}],total:1,truncated:false}; },
  };
  return {browser,counts:()=>({clickCount,fillCount,inspectCount,waitCount})};
}

test('verified browser click returns a verified receipt', async () => {
  const {browser,counts} = fakeBrowser();
  const orchestrator = new BrowserOrchestrator(browser, capabilities);
  const result = await orchestrator.clickVerified('safe-1', {kind:'title',equals:'Verified'}, 2000);
  assert.equal(result.ok, true);
  assert.equal(result.ambiguous, false);
  assert.equal(result.receipt.status, 'verified');
  assert.equal(result.receipt.route, 'browser.navigate-safe');
  assert.equal(result.receipt.verification.ok, true);
  assert.deepEqual(counts(), {clickCount:1,fillCount:0,inspectCount:1,waitCount:1});
});

test('ambiguous browser click is never repeated and performs only DOM re-inspection recovery', async () => {
  const {browser,counts} = fakeBrowser({waitFails:true});
  const orchestrator = new BrowserOrchestrator(browser, capabilities);
  const result = await orchestrator.clickVerified('safe-1', {kind:'title',equals:'Never'}, 500);
  assert.equal(result.ok, false);
  assert.equal(result.ambiguous, true);
  assert.equal(result.receipt.status, 'failed');
  assert.equal(result.receipt.recovery.action, 'reinspect-dom');
  assert.equal(result.receipt.recovery.mayRepeatExecution, false);
  assert.equal(result.recoveryObservation.controlCount, 1);
  assert.deepEqual(counts(), {clickCount:1,fillCount:0,inspectCount:1,waitCount:1});
});

test('verified browser fill checks exact value and does not store filled text in receipt action', async () => {
  const {browser,counts} = fakeBrowser();
  const orchestrator = new BrowserOrchestrator(browser, capabilities);
  const result = await orchestrator.fillVerified('input-1', 'sensitive-ish text', 1000);
  assert.equal(result.ok, true);
  assert.equal(result.receipt.status, 'verified');
  assert.equal(result.receipt.action.characters, 18);
  assert.equal('text' in result.receipt.action, false);
  assert.deepEqual(counts(), {clickCount:0,fillCount:1,inspectCount:1,waitCount:1});
});

test('ambiguous browser fill is never repeated', async () => {
  const {browser,counts} = fakeBrowser({fillWaitFails:true});
  const orchestrator = new BrowserOrchestrator(browser, capabilities);
  const result = await orchestrator.fillVerified('input-1', 'abc', 500);
  assert.equal(result.ok, false);
  assert.equal(result.receipt.recovery.mayRepeatExecution, false);
  assert.deepEqual(counts(), {clickCount:0,fillCount:1,inspectCount:1,waitCount:1});
});


test('verified browser click rejects a value post-condition before executing', async () => {
  const {browser,counts} = fakeBrowser();
  const orchestrator = new BrowserOrchestrator(browser, capabilities);
  await assert.rejects(() => orchestrator.clickVerified('safe-1', {kind:'value',selectorId:'x',equals:'y'}, 500), /does not accept a selector-value/);
  assert.deepEqual(counts(), {clickCount:0,fillCount:0,inspectCount:0,waitCount:0});
});

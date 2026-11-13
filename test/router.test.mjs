import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkstationRouter, RouterError } from '../dist/router.js';

const full = () => ({
  files:{read:true,write:true},
  office:{offlineRead:true,offlineWrite:true,liveRead:true,liveWrite:true,applications:{word:true,excel:true,powerpoint:true,outlook:true}},
  browser:{enabled:true,dom:true,screenshot:true},
  desktop:{enabled:true,uia:true,visual:true},
  terminal:{enabled:true},
  intake:{enabled:true},
  pdf:{enabled:true},
});

const router = new WorkstationRouter();

const cases = [
  [{domain:'files',operation:'read',target:'D:/a.txt'}, 'files.read', false, true],
  [{domain:'files',operation:'write',target:'D:/a.txt'}, 'files.write-confirmed', true, false],
  [{domain:'office',operation:'read',application:'word',live:false}, 'office.offline.read', false, true],
  [{domain:'office',operation:'edit',application:'word',live:false}, 'office.offline.write-confirmed', true, false],
  [{domain:'office',operation:'read',application:'word',live:true}, 'office.live.read', false, true],
  [{domain:'office',operation:'edit',application:'word',live:true}, 'office.live.write-confirmed', false, false],
  [{domain:'browser',operation:'inspect',target:'https://example.com'}, 'browser.read', false, true],
  [{domain:'browser',operation:'navigate',target:'https://example.com'}, 'browser.navigate-safe', false, false],
  [{domain:'desktop',operation:'inspect'}, 'desktop.read', false, true],
  [{domain:'desktop',operation:'navigate'}, 'desktop.navigate-safe', false, false],
  [{domain:'terminal',operation:'execute'}, 'terminal.preview-confirmed', false, false],
  [{domain:'intake',operation:'read'}, 'intake.read', false, true],
  [{domain:'pdf',operation:'read',target:'D:/a.pdf'}, 'pdf.read', false, true],
];

for (const [intent, route, confirmation, readOnly] of cases) {
  test(`router selects ${route}`, () => {
    const plan = router.plan(intent, full());
    assert.equal(plan.route, route);
    assert.equal(plan.requiresConfirmation, confirmation);
    assert.equal(plan.readOnly, readOnly);
    assert.ok(plan.reason.length > 10);
    assert.ok(plan.observations.length > 0);
    assert.ok(plan.verification.required.length > 0);
  });
}

test('auto routing prefers native PDF service for .pdf targets', () => {
  assert.equal(router.plan({operation:'read',target:'D:/report.pdf'}, full()).route, 'pdf.read');
});

test('auto routing prefers structured Office service for Office files', () => {
  assert.equal(router.plan({operation:'edit',target:'D:/report.docx'}, full()).route, 'office.offline.write-confirmed');
  assert.equal(router.plan({operation:'read',target:'D:/book.xlsx'}, full()).route, 'office.offline.read');
});

test('auto routing prefers Browser DOM for HTTP targets', () => {
  assert.equal(router.plan({operation:'inspect',target:'https://example.com'}, full()).route, 'browser.read');
});

test('browser falls back to Windows UI Automation when DOM is unavailable', () => {
  const capabilities = full();
  capabilities.browser.dom = false;
  const plan = router.plan({domain:'browser',operation:'navigate',target:'https://example.com'}, capabilities);
  assert.equal(plan.route, 'desktop.navigate-safe');
  assert.equal(plan.verification.kind, 'uia');
});

test('browser uses visual fallback only when explicitly allowed', () => {
  const capabilities = full();
  capabilities.browser.dom = false;
  capabilities.desktop.uia = false;
  const plan = router.plan({domain:'browser',operation:'navigate',target:'https://example.com',allowVisualFallback:true}, capabilities);
  assert.equal(plan.route, 'desktop.visual-verified');
  assert.equal(plan.recovery.maxAutomaticRetries, 0);
  assert.equal(plan.recovery.neverRepeatAfterAmbiguousExecution, true);
});

test('browser refuses visual fallback when owner/task did not allow it', () => {
  const capabilities = full();
  capabilities.browser.dom = false;
  capabilities.desktop.uia = false;
  assert.throws(() => router.plan({domain:'browser',operation:'navigate',target:'https://example.com'}, capabilities), error => error instanceof RouterError && error.code === 'NO_SAFE_ROUTE');
});

test('Office Live Write never automatically retries an ambiguous write', () => {
  const plan = router.plan({domain:'office',operation:'edit',application:'word',live:true}, full());
  assert.equal(plan.verification.onAmbiguous, 'fail');
  assert.equal(plan.recovery.maxAutomaticRetries, 1);
  assert.equal(plan.recovery.neverRepeatAfterAmbiguousExecution, true);
  assert.ok(plan.verification.required.some(item => /fingerprint/i.test(item)));
});

test('Terminal execution uses dynamic risk-based confirmation and never repeats the command automatically', () => {
  const plan = router.plan({domain:'terminal',operation:'execute'}, full());
  assert.equal(plan.requiresConfirmation, false);
  assert.equal(plan.verification.kind, 'terminal-exit');
  assert.equal(plan.recovery.maxAutomaticRetries, 1);
  assert.equal(plan.recovery.neverRepeatAfterAmbiguousExecution, true);
});

for (const externalSideEffect of ['send','upload','login','credentials','payment','transfer','purchase','call']) {
  test(`router blocks external side effect ${externalSideEffect}`, () => {
    assert.throws(
      () => router.plan({domain:'browser',operation:'navigate',target:'https://example.com',externalSideEffect}, full()),
      error => error instanceof RouterError && error.code === 'BLOCKED_SIDE_EFFECT'
    );
  });
}

test('router rejects unavailable Office live write instead of falling back to desktop', () => {
  const capabilities = full();
  capabilities.office.liveWrite = false;
  assert.throws(
    () => router.plan({domain:'office',operation:'edit',application:'word',live:true,allowVisualFallback:true}, capabilities),
    error => error instanceof RouterError && error.code === 'NO_SAFE_ROUTE'
  );
});

test('router rejects explicitly unavailable Office application', () => {
  const capabilities = full();
  capabilities.office.applications.word = false;
  assert.throws(
    () => router.plan({domain:'office',operation:'read',application:'word',live:true}, capabilities),
    error => error instanceof RouterError && error.code === 'UNSUPPORTED_OFFICE_APP'
  );
});


test('browser routing marks dedicated Chromium for automation that does not need the personal session', () => {
  const capabilities = full();
  capabilities.browser = {enabled:true,dom:true,screenshot:true,dedicatedChromium:true,cocCocConnected:true,cocCocTabs:2,isolatedBrowser:true};
  const plan = router.plan({domain:'browser',operation:'inspect',target:'https://example.com',browserWorkload:'automation'}, capabilities);
  assert.equal(plan.route, 'browser.read');
  assert.equal(plan.browserTarget, 'dedicated-chromium');
});

test('browser routing selects Cốc Cốc when the real logged-in user session is required', () => {
  const capabilities = full();
  capabilities.browser = {enabled:true,dom:true,screenshot:true,dedicatedChromium:true,cocCocConnected:true,cocCocTabs:3,isolatedBrowser:true};
  const plan = router.plan({domain:'browser',operation:'inspect',requiresUserSession:true,description:'read the page in my existing logged-in session'}, capabilities);
  assert.equal(plan.browserTarget, 'coc-coc');
  assert.match(plan.reason, /Cốc Cốc|existing/i);
});

test('browser routing fails closed instead of copying a user session into clean Chromium', () => {
  const capabilities = full();
  capabilities.browser = {enabled:true,dom:true,screenshot:true,dedicatedChromium:true,cocCocConnected:false,cocCocTabs:0,isolatedBrowser:true};
  assert.throws(
    () => router.plan({domain:'browser',operation:'inspect',requiresUserSession:true}, capabilities),
    error => error instanceof RouterError && error.code === 'NO_SAFE_ROUTE' && /real logged-in session|Cốc Cốc/i.test(error.message)
  );
});

test('browser routing uses Isolated Browser for scraping when dedicated Chromium is unavailable', () => {
  const capabilities = full();
  capabilities.browser = {enabled:true,dom:true,screenshot:true,dedicatedChromium:false,cocCocConnected:true,cocCocTabs:1,isolatedBrowser:true};
  const plan = router.plan({domain:'browser',operation:'inspect',browserWorkload:'scraping'}, capabilities);
  assert.equal(plan.browserTarget, 'isolated-browser');
});

test('explicit automation workload does not fall back to the personal Cốc Cốc profile', () => {
  const capabilities = full();
  capabilities.browser = {enabled:true,dom:true,screenshot:true,dedicatedChromium:false,cocCocConnected:true,cocCocTabs:1,isolatedBrowser:false};
  assert.throws(
    () => router.plan({domain:'browser',operation:'inspect',browserWorkload:'testing'}, capabilities),
    error => error instanceof RouterError && error.code === 'NO_SAFE_ROUTE' && /personal Cốc Cốc/i.test(error.message)
  );
});

test('preferIsolatedBrowser selects the isolated browser when it is online', () => {
  const capabilities = full();
  capabilities.browser = {enabled:true,dom:true,screenshot:true,dedicatedChromium:true,cocCocConnected:true,cocCocTabs:1,isolatedBrowser:true};
  const plan = router.plan({domain:'browser',operation:'inspect',preferIsolatedBrowser:true}, capabilities);
  assert.equal(plan.browserTarget, 'isolated-browser');
});

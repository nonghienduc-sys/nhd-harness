import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkstationRouter, RouterError, capabilitiesFromRuntime } from '../dist/router.js';

const runtime = (overrides = {}) => ({
  writeEnabled:true,
  terminalEnabled:true,
  screenEnabled:true,
  desktopEnabled:true,
  browserEnabled:true,
  visualDesktopEnabled:true,
  intakeEnabled:true,
  emergencyStop:false,
  office:{companion:true,word:true,excel:true,powerpoint:true,outlook:true},
  browser:{executable:'C:/Browser/browser.exe'},
  desktop:{companion:true},
  intake:{availableRoots:2},
  pdf:{nativeTextExtraction:true},
  ...overrides,
});

const router = new WorkstationRouter();

test('runtime capability snapshot exposes Office Live V2 writes for active Word/Excel/PowerPoint but keeps Outlook read-only', () => {
  const cap = capabilitiesFromRuntime(runtime());
  assert.equal(cap.office.liveWrite, true);
  assert.equal(cap.office.liveWriteApplications.word, true);
  assert.equal(cap.office.liveWriteApplications.excel, true);
  assert.equal(cap.office.liveWriteApplications.powerpoint, true);
  assert.equal(cap.office.liveWriteApplications.outlook, false);
  for (const application of ['word','excel','powerpoint']) {
    const plan = router.plan({domain:'office',operation:'edit',application,live:true}, cap);
    assert.equal(plan.route, 'office.live.write-confirmed');
    assert.equal(plan.requiresConfirmation, false);
    assert.match(plan.observations.join(' '), /fingerprint/i);
  }
  assert.throws(() => router.plan({domain:'office',operation:'edit',application:'outlook',live:true}, cap), error => error instanceof RouterError && error.code === 'NO_SAFE_ROUTE');
});

test('Office Live V2 write capability follows which Office applications are actually open', () => {
  const cap = capabilitiesFromRuntime(runtime({office:{companion:true,word:true,excel:false,powerpoint:false,outlook:false}}));
  assert.equal(cap.office.liveWriteApplications.word, true);
  assert.equal(cap.office.liveWriteApplications.excel, false);
  assert.equal(cap.office.liveWriteApplications.powerpoint, false);
  assert.equal(router.plan({domain:'office',operation:'edit',application:'word',live:true}, cap).route, 'office.live.write-confirmed');
  assert.throws(() => router.plan({domain:'office',operation:'edit',application:'excel',live:true}, cap), error => error instanceof RouterError && error.code === 'UNSUPPORTED_OFFICE_APP');
});

test('Emergency Stop disables every active execution/navigation capability but keeps structured reads', () => {
  const cap = capabilitiesFromRuntime(runtime({emergencyStop:true}));
  assert.equal(cap.files.read, true);
  assert.equal(cap.files.write, false);
  assert.equal(cap.office.offlineRead, true);
  assert.equal(cap.office.offlineWrite, false);
  assert.equal(cap.office.liveRead, false);
  assert.equal(cap.office.liveWrite, false);
  assert.equal(cap.browser.enabled, false);
  assert.equal(cap.desktop.enabled, false);
  assert.equal(cap.terminal.enabled, false);
  assert.equal(cap.intake.enabled, false);
  assert.equal(cap.pdf.enabled, false);
});

test('owner write lock disables structured and Office writes without disabling reads', () => {
  const cap = capabilitiesFromRuntime(runtime({writeEnabled:false}));
  assert.equal(cap.files.write, false);
  assert.equal(cap.office.offlineWrite, false);
  assert.equal(cap.office.liveWrite, false);
  assert.equal(cap.files.read, true);
  assert.equal(cap.office.offlineRead, true);
});

test('missing Browser executable causes router to prefer Desktop UIA', () => {
  const cap = capabilitiesFromRuntime(runtime({browser:{executable:null}}));
  assert.equal(cap.browser.enabled, false);
  const plan = router.plan({domain:'browser',operation:'navigate',target:'https://example.com'}, cap);
  assert.equal(plan.route, 'desktop.navigate-safe');
});

test('Desktop Companion absence removes UIA and visual fallback', () => {
  const cap = capabilitiesFromRuntime(runtime({desktop:{companion:false},browser:{executable:null}}));
  assert.equal(cap.desktop.enabled, false);
  assert.throws(() => router.plan({domain:'browser',operation:'navigate',target:'https://example.com',allowVisualFallback:true}, cap), error => error instanceof RouterError && error.code === 'NO_SAFE_ROUTE');
});

test('Intake and PDF capabilities reflect actual approved source readiness', () => {
  const noInbox = capabilitiesFromRuntime(runtime({intake:{availableRoots:0}}));
  assert.equal(noInbox.intake.enabled, false);
  const noPdf = capabilitiesFromRuntime(runtime({pdf:{nativeTextExtraction:false}}));
  assert.equal(noPdf.pdf.enabled, false);
});

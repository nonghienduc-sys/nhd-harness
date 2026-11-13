import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkstationRouter } from '../dist/router.js';
import { WorkstationVerifier, RecoveryController, RecoveryStateMachine, ReceiptBuilder } from '../dist/orchestration.js';

const capabilities = () => ({
  files:{read:true,write:true},
  office:{offlineRead:true,offlineWrite:true,liveRead:true,liveWrite:true,applications:{word:true,excel:true,powerpoint:true,outlook:true}},
  browser:{enabled:true,dom:true,screenshot:true},
  desktop:{enabled:true,uia:true,visual:true},
  terminal:{enabled:true},
  intake:{enabled:true},
  pdf:{enabled:true},
});

const router = new WorkstationRouter();
const verifier = new WorkstationVerifier();
const recovery = new RecoveryController();

function passingEvidence(plan) {
  return {checks:Object.fromEntries(plan.verification.required.map(check => [check,true])),details:{source:'test'}};
}

test('verifier returns verified only when every required check passes', () => {
  const plan = router.plan({domain:'office',operation:'edit',application:'word',live:true}, capabilities());
  const result = verifier.verify(plan.verification, passingEvidence(plan));
  assert.equal(result.status, 'verified');
  assert.equal(result.ok, true);
  assert.deepEqual(result.missing, []);
  assert.equal(result.passed.length, plan.verification.required.length);
});

test('verifier marks missing post-condition as ambiguous rather than verified', () => {
  const plan = router.plan({domain:'browser',operation:'navigate',target:'https://example.com'}, capabilities());
  const evidence = passingEvidence(plan);
  const missing = plan.verification.required.at(-1);
  evidence.checks[missing] = false;
  const result = verifier.verify(plan.verification, evidence);
  assert.equal(result.status, 'ambiguous');
  assert.equal(result.ok, false);
  assert.deepEqual(result.missing, [missing]);
});

test('explicit verification error becomes failed', () => {
  const plan = router.plan({domain:'files',operation:'read',target:'D:/a.txt'}, capabilities());
  const result = verifier.verify(plan.verification, {checks:{},error:'read failed'});
  assert.equal(result.status, 'failed');
  assert.equal(result.error, 'read failed');
});

test('Office live ambiguous write may refresh state once but may never repeat execution', () => {
  const plan = router.plan({domain:'office',operation:'edit',application:'word',live:true}, capabilities());
  const verification = verifier.verify(plan.verification, {checks:{},ambiguous:true});
  const decision = recovery.decide(plan.recovery, verification, 0);
  assert.equal(decision.action, 'refresh-live-state');
  assert.equal(decision.automatic, true);
  assert.equal(decision.mayRepeatExecution, false);
  const exhausted = recovery.decide(plan.recovery, verification, 1);
  assert.equal(exhausted.action, 'fail');
});

test('Terminal ambiguous execution may prune stale state once but may not rerun command', () => {
  const plan = router.plan({domain:'terminal',operation:'execute'}, capabilities());
  const verification = verifier.verify(plan.verification, {checks:{},ambiguous:true});
  const decision = recovery.decide(plan.recovery, verification, 0);
  assert.equal(decision.action, 'prune-stale');
  assert.equal(decision.mayRepeatExecution, false);
  assert.equal(decision.automatic, true);
});

test('safe browser read can re-inspect DOM with bounded automatic recovery', () => {
  const plan = router.plan({domain:'browser',operation:'inspect',target:'https://example.com'}, capabilities());
  const verification = verifier.verify(plan.verification, {checks:{},ambiguous:true});
  const decision = recovery.decide(plan.recovery, verification, 0);
  assert.equal(decision.action, 'reinspect-dom');
  assert.equal(decision.automatic, true);
  assert.equal(decision.mayRepeatExecution, true);
});

test('state machine follows planned -> observed -> executing -> verifying -> verified', () => {
  const plan = router.plan({domain:'files',operation:'write',target:'D:/a.txt'}, capabilities());
  const machine = new RecoveryStateMachine(plan);
  machine.observed();
  machine.executing();
  machine.verifying();
  machine.verified();
  assert.equal(machine.state, 'verified');
  assert.deepEqual(machine.history.map(item => item.state), ['planned','observed','executing','verifying','verified']);
});

test('state machine blocks invalid direct execution before observation', () => {
  const machine = new RecoveryStateMachine(router.plan({domain:'files',operation:'read',target:'D:/a.txt'}, capabilities()));
  assert.throws(() => machine.executing(), /Invalid execution transition/);
});

test('state machine supports safe re-observation recovery without repeating the action', () => {
  const plan = router.plan({domain:'office',operation:'edit',application:'word',live:true}, capabilities());
  const machine = new RecoveryStateMachine(plan);
  machine.observed();
  machine.executing();
  machine.verifying();
  const verification = verifier.verify(plan.verification, {checks:{},ambiguous:true});
  const decision = recovery.decide(plan.recovery, verification, machine.recoveryAttempts);
  machine.recovering(decision);
  machine.observed('selection reread');
  machine.verifying('verify refreshed state without re-applying');
  assert.equal(machine.state, 'verifying');
  assert.equal(machine.recoveryAttempts, 1);
  assert.equal(machine.history.filter(item => item.state === 'executing').length, 1);
});

test('receipt builder records structured before/action/after/verification/recovery evidence', () => {
  const plan = router.plan({domain:'browser',operation:'navigate',target:'https://example.com'}, capabilities());
  const verification = verifier.verify(plan.verification, passingEvidence(plan));
  const receipt = new ReceiptBuilder(plan)
    .before({url:'about:blank'})
    .action({type:'navigate',url:'https://example.com'})
    .after({url:'https://example.com',title:'Example'})
    .verification(verification)
    .recovery(null)
    .audit('audit-1')
    .finish('verified');
  assert.equal(receipt.route, 'browser.navigate-safe');
  assert.equal(receipt.status, 'verified');
  assert.equal(receipt.auditId, 'audit-1');
  assert.equal(receipt.observedBefore.url, 'about:blank');
  assert.equal(receipt.observedAfter.title, 'Example');
  assert.equal(receipt.verification.ok, true);
  assert.ok(receipt.receiptId.length > 10);
  assert.ok(receipt.completedAt);
});

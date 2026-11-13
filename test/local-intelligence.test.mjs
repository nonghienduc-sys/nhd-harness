import test from 'node:test';
import assert from 'node:assert/strict';
import { LocalIntelligenceService } from '../dist/local-intelligence.js';

test('deterministic open commands use rules and never execute', () => {
  const service = new LocalIntelligenceService();
  for (const text of ['Mở Word', 'Mở giúp tôi Word', 'focus vào Excel cho tôi']) {
    const out = service.route({ text });
    assert.equal(out.tier, 'rules');
    assert.equal(out.target, 'nhd-rule-engine');
    assert.equal(out.mayExecute, false);
  }
});

test('project/file retrieval uses semantic path and current research uses cloud', () => {
  const service = new LocalIntelligenceService();
  assert.equal(service.route({ text: 'Tìm file báo cáo Quốc Anh' }).tier, 'semantic');
  assert.equal(service.route({ text: 'Tìm tin tức AI hôm nay' }).tier, 'cloud');
});

test('tiny classifier handles classification only while text generation escalates to ChatGPT cloud', () => {
  const service = new LocalIntelligenceService();
  const classify = service.route({ text: 'Phân loại intent của yêu cầu này' });
  assert.equal(classify.tier, 'tiny');
  assert.equal(classify.intent, 'classify');
  for (const text of ['Tóm tắt đoạn văn này', 'Viết lại đoạn này chuyên nghiệp hơn', 'Dịch đoạn này sang tiếng Anh', 'Trích xuất tên và mã hồ sơ ra JSON']) {
    const out = service.route({ text });
    assert.equal(out.tier, 'cloud');
    assert.equal(out.target, 'chatgpt-cloud');
  }
});

test('context-dependent commands use durable context gate', () => {
  const service = new LocalIntelligenceService();
  for (const text of ['làm đi', 'tiếp tục']) {
    const out = service.route({ text });
    assert.equal(out.target, 'nhd-context-gate');
    assert.equal(out.tier, 'semantic');
  }
});

test('multi-step workstation workflows stay on direct MCP path', () => {
  const service = new LocalIntelligenceService();
  const out = service.route({ text: 'Tìm báo cáo rồi fill số liệu vào bảng và kiểm tra lại' });
  assert.equal(out.tier, 'direct');
  assert.equal(out.target, 'nhd-direct-tool');
  assert.equal(out.policyGateRequired, true);
});

test('tiny character router remains advisory fallback only', () => {
  const service = new LocalIntelligenceService();
  const out = service.route({ text: 'hãy cho biết nhóm phù hợp của yêu cầu bình thường này' });
  assert.ok(out.reasons.includes('tiny_character_trigram_fallback'));
  assert.equal(out.mayExecute, false);
  assert.ok(['rules','semantic','tiny','direct','cloud'].includes(out.tier));
});

test('status explicitly reports worker-free tiny-router architecture', () => {
  const status = new LocalIntelligenceService().status();
  assert.equal(status.mode, 'deterministic-tiny-router');
  assert.equal(status.architecture, 'NHD Direct Fast Lane + Tiny Router + Cloud Escalation');
  assert.equal(status.modelInvocationEnabled, false);
  assert.equal(status.automaticModelRouting, false);
  assert.equal(status.localModelRuntime, 'disabled');
  assert.equal(status.tinyRouter.enabled, true);
  assert.equal(status.tinyRouter.kind, 'character-trigram-naive-bayes');
  assert.ok(status.tinyRouter.trainingExamples >= 100);
  assert.equal(status.tinyRouter.modelInvocation, false);
  assert.equal('localTextWorker' in status, false);
  assert.equal('providers' in status, false);
  assert.equal(status.safety.externalModelEndpointsUsed, false);
});

test('dispatcher has no local-model lane', () => {
  const service = new LocalIntelligenceService();
  for (const text of ['Mở giúp tôi Word', 'Tìm file báo cáo Quốc Anh', 'Mở Word rồi sửa đoạn tôi bôi đen']) {
    const out = service.dispatch({ text });
    assert.equal(out.lane, 'direct_tool');
    assert.equal(out.localModelRequired, false);
  }
  assert.equal(service.dispatch({ text: 'tiếp tục' }).lane, 'context_gate');
  for (const text of ['Tóm tắt đoạn văn này', 'Nghiên cứu paper AI mới nhất trên web']) {
    const out = service.dispatch({ text });
    assert.equal(out.lane, 'cloud');
    assert.equal(out.localModelRequired, false);
  }
});

test('verification preserves no-replay and NHD policy authority', () => {
  const service = new LocalIntelligenceService();
  const ambiguous = service.verify({ tier: 'direct', confidence: 0.95, ambiguous: true });
  assert.equal(ambiguous.verdict, 'reobserve');
  assert.equal(ambiguous.replayAmbiguousActions, false);
  const sideEffect = service.verify({ tier: 'rules', confidence: 0.99, externalSideEffect: true });
  assert.equal(sideEffect.verdict, 'require_policy_gate');
  assert.equal(sideEffect.taskMetadataIsAuthorization, false);
  const weak = service.verify({ tier: 'tiny', confidence: 0.4, postConditionVerified: true, evidenceCount: 1 });
  assert.equal(weak.verdict, 'escalate_cloud');
});

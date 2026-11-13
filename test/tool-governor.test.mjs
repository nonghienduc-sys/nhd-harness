import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ToolGovernorService } from '../dist/tool-governor.js';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'nhd-governor-'));
  const root = 'D:\\NHD Projects\\TOEIC Reading - Đức';
  const fakeMemory = {
    stats: () => ({ activeProjectRoot: root }),
    listFacts: () => [
      { key: 'workspace.next_action', value: 'Chỉ giao 3 câu mỗi lượt.', category: 'working_state', confidence: 'confirmed', updatedAt: '2026-10-09T00:00:00Z' },
      { key: 'working.current_document.path', value: 'Document1', category: 'working_state', confidence: 'verified', updatedAt: '2026-10-09T00:00:01Z' },
    ],
    projects: {
      status: (input) => ({ root: input || root }),
      listDecisions: () => [
        { id: 'DEC-1', title: 'Format tài liệu học TOEIC', value: '13pt; chữa đáp án và lập luận; mỗi lượt 3 câu.', status: 'confirmed', updatedAt: '2026-10-09T00:00:00Z' },
      ],
    },
    taskRuns: { list: () => [] },
  };
  const inventory = [
    { name: 'office_live_read', group: 'Office', description: 'Read live Word.', enabled: true, status: 'enabled', permission: 'read', destructive: false },
    { name: 'office_live_preview_edit', group: 'Office', description: 'Preview Word edit.', enabled: true, status: 'enabled', permission: 'write', destructive: false },
    { name: 'office_live_apply_edit', group: 'Office', description: 'Apply Word edit.', enabled: true, status: 'enabled', permission: 'write', destructive: false },
    { name: 'skills_search', group: 'Skills', description: 'Search skills.', enabled: true, status: 'enabled', permission: 'skills', destructive: false },
  ];
  const governor = new ToolGovernorService({ dataDir: dir, workspaceMemory: fakeMemory, inventoryProvider: () => inventory });
  return { dir, root, governor };
}

test('capability map never hides tools and plan uses bounded project memory', () => {
  const { dir, root, governor } = fixture();
  try {
    const map = governor.capabilities();
    assert.equal(map.hiddenCapabilities, false);
    assert.equal(map.totalTools, 4);
    assert.equal(map.groups.find(g => g.group === 'Office').tools.length, 3);

    const plan = governor.plan({ text: 'Tôi đã làm xong 3 câu TOEIC, chữa cho tôi trong Word.', root });
    assert.equal(plan.taskClass, 'toeic_word_grading');
    assert.equal(plan.hiddenCapabilities, false);
    assert.equal(plan.globalCapabilityAwareness, true);
    assert.ok(plan.recommendedTools.includes('office_live_read'));
    assert.ok(plan.avoidUnlessNeeded.includes('skills_search'));
    assert.ok(plan.avoidUnlessNeeded.includes('terminal_session_preview'));
    assert.equal(plan.memoryResolver.usedBroadChatDump, false);
    assert.ok(plan.memoryPack.projectDecisions.some(item => item.id === 'DEC-1'));
  } finally { governor.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('explicit preferences are scoped and replace stale current value', () => {
  const { dir, root, governor } = fixture();
  try {
    let stored = governor.rememberPreference({ scope: 'project', root, key: 'toeic.questions_per_batch', value: '6', source: 'test' });
    assert.equal(stored.previousValue, null);
    stored = governor.rememberPreference({ scope: 'project', root, key: 'toeic.questions_per_batch', value: '3', source: 'user_changed_preference' });
    assert.equal(stored.previousValue, '6');
    const plan = governor.plan({ text: 'Chữa bài TOEIC vừa làm.', root });
    assert.equal(plan.memoryPack.projectPreferences.find(item => item.key === 'toeic.questions_per_batch').value, '3');
  } finally { governor.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('safe metadata calls are cached while real work remains uncached', async () => {
  const { dir, governor } = fixture();
  try {
    let searchRuns = 0;
    const first = await governor.intercept('skills_search', { query: 'word' }, { readOnlyHint: true }, async () => ({ value: ++searchRuns }));
    const second = await governor.intercept('skills_search', { query: 'word' }, { readOnlyHint: true }, async () => ({ value: ++searchRuns }));
    assert.deepEqual(first, second);
    assert.equal(searchRuns, 1);

    let wordReads = 0;
    await governor.intercept('office_live_read', { application: 'word' }, { readOnlyHint: true }, async () => ({ value: ++wordReads }));
    await governor.intercept('office_live_read', { application: 'word' }, { readOnlyHint: true }, async () => ({ value: ++wordReads }));
    assert.equal(wordReads, 2);
    assert.equal(governor.status().metrics.cacheHits, 1);
  } finally { governor.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('successful checkpoint learns a project task recipe from actual tool calls', async () => {
  const { dir, root, governor } = fixture();
  try {
    governor.plan({ text: 'Tôi làm xong 3 câu TOEIC, chữa trực tiếp trong Word.', root });
    await governor.intercept('office_live_read', { application: 'word' }, { readOnlyHint: true }, async () => ({ ok: true }));
    await governor.intercept('office_live_preview_edit', { application: 'word' }, {}, async () => ({ ok: true }));
    await governor.intercept('office_live_apply_edit', { action_id: 'a', confirmation_token: 'b' }, {}, async () => ({ ok: true }));
    await governor.intercept('context_checkpoint', { root, summary: 'done' }, {}, async () => ({ structuredContent: { stored: true } }));

    const recipe = governor.recipe(root, 'toeic_word_grading').recipe;
    assert.ok(recipe);
    assert.deepEqual(recipe.workflow, ['office_live_read', 'office_live_preview_edit', 'office_live_apply_edit']);
    assert.equal(recipe.successCount, 1);

    const next = governor.plan({ text: 'Chữa 3 câu TOEIC tiếp theo.', root });
    assert.ok(next.memoryResolver.priorRecipe);
    assert.equal(next.memoryResolver.priorRecipe.successCount, 1);
    assert.equal(next.recommendedTools[0], 'office_live_read');
  } finally { governor.close(); rmSync(dir, { recursive: true, force: true }); }
});


test('intent policy locks an explicitly requested method instead of redesigning it', () => {
  const { dir, root, governor } = fixture();
  try {
    const wordLive = governor.plan({ text: 'Dùng Word Live sửa đúng phần tôi đang bôi đen, không đổi sang cách khác.', root });
    assert.equal(wordLive.intentPolicy.mode, 'execute');
    assert.equal(wordLive.intentPolicy.methodLocked, true);
    assert.ok(wordLive.intentPolicy.explicitConstraints.includes('explicit_tool_or_method'));
    assert.ok(wordLive.intentPolicy.explicitConstraints.includes('explicit_preserve_or_negative_constraint'));
    const mouseScript = governor.plan({ text: 'Viết script điều khiển chuột để tải 20 file Excel rồi copy paste vào bảng tổng.', root });
    assert.equal(mouseScript.intentPolicy.mode, 'execute');
    assert.equal(mouseScript.intentPolicy.methodLocked, true);
  } finally { governor.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('intent policy reframes an open workflow goal only when implementation is not locked', () => {
  const { dir, root, governor } = fixture();
  try {
    const openGoal = governor.plan({ text: 'Mỗi tuần tôi phải tải 20 file Excel rồi tổng hợp thủ công, rất mất thời gian. Hãy tự động hóa quy trình này.', root });
    assert.equal(openGoal.intentPolicy.mode, 'reframe');
    assert.equal(openGoal.intentPolicy.methodLocked, false);
    assert.equal(openGoal.intentPolicy.goalOpen, true);
    assert.equal(openGoal.intentPolicy.verificationRequired, true);
    const direct = governor.plan({ text: 'Mở file báo cáo và đọc trang 3.', root });
    assert.equal(direct.intentPolicy.mode, 'execute');
    assert.equal(direct.intentPolicy.goalOpen, false);
  } finally { governor.close(); rmSync(dir, { recursive: true, force: true }); }
});

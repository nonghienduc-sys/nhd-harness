import test from 'node:test';
import assert from 'node:assert/strict';
import { pickOfficeWindow, captureOfficeVisualReview } from '../dist/office-live-visual.js';

const sources = [
  { id: 'screen:0:0', name: 'Entire screen', kind: 'screen', displayId: '0' },
  { id: 'window:chat:0', name: 'ChatGPT - Browser', kind: 'window', displayId: null },
  { id: 'window:word:0', name: 'Bai_van_nghi_luan_AI_thay_the_con_nguoi - Compatibility Mode - Word', kind: 'window', displayId: null },
  { id: 'window:excel:0', name: 'Budget.xlsx - Excel', kind: 'window', displayId: null },
];

test('Office Visual QA matches the visible Word window by active document name', () => {
  const picked = pickOfficeWindow(sources, 'word', {
    name: 'Bai_van_nghi_luan_AI_thay_the_con_nguoi.docx',
    path: 'D:/Chung Khoan/Bai_van_nghi_luan_AI_thay_the_con_nguoi.docx',
  });
  assert.equal(picked?.id, 'window:word:0');
});

test('Office Visual QA matches Excel without confusing it with another Office window', () => {
  const picked = pickOfficeWindow(sources, 'excel', { name: 'Budget.xlsx', path: 'D:/Budget.xlsx' });
  assert.equal(picked?.id, 'window:excel:0');
});

test('Office Visual QA returns screenshot evidence and keeps completion awaiting AI review', async () => {
  const fakeScreen = {
    list: async () => ({ sources }),
    capture: async (id) => ({ source: sources.find((x) => x.id === id), width: 1200, height: 900, mimeType: 'image/png', data: 'ZmFrZQ==' }),
  };
  const out = await captureOfficeVisualReview(fakeScreen, 'word', { name: 'Bai_van_nghi_luan_AI_thay_the_con_nguoi.docx' });
  assert.equal(out.review.required, true);
  assert.equal(out.review.available, true);
  assert.equal(out.review.status, 'awaiting_ai_review');
  assert.equal(out.review.completionGate, 'review_screenshot_before_finalizing');
  assert.equal(out.capture?.source.id, 'window:word:0');
});

test('Office Visual QA fails closed for completion claims when no visible Office window can be reviewed', async () => {
  const fakeScreen = {
    list: async () => ({ sources: [{ id: 'window:chat:0', name: 'ChatGPT - Browser', kind: 'window', displayId: null }] }),
    capture: async () => { throw new Error('should not capture'); },
  };
  const out = await captureOfficeVisualReview(fakeScreen, 'powerpoint', { name: 'Deck.pptx' });
  assert.equal(out.review.available, false);
  assert.equal(out.review.status, 'unavailable');
  assert.equal(out.review.completionGate, 'visual_review_unavailable_do_not_claim_visually_correct');
});


test('Office Visual QA rejects a same-app window when its document title does not match the active file', async () => {
  const wrongWordOnly = [
    { id: 'window:word-old:0', name: 'Document1 - AutoRecovered - Compatibility Mode - Word', kind: 'window', displayId: null },
  ];
  const picked = pickOfficeWindow(wrongWordOnly, 'word', { name: 'Document2', path: 'Document2' });
  assert.equal(picked, null);
  let captured = false;
  const fakeScreen = {
    list: async () => ({ sources: wrongWordOnly }),
    capture: async () => { captured = true; throw new Error('must not capture wrong document'); },
  };
  const out = await captureOfficeVisualReview(fakeScreen, 'word', { name: 'Document2', path: 'Document2' });
  assert.equal(captured, false);
  assert.equal(out.review.available, false);
  assert.equal(out.review.completionGate, 'visual_review_unavailable_do_not_claim_visually_correct');
});

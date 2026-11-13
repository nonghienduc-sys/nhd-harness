import test from 'node:test';
import assert from 'node:assert/strict';
import { applyDailyUpdates, dailyPlanFactKey, normalizeDailyPlan, summarizeDailyPlan } from '../dist/daily-progress.js';

test('daily plan summary tracks partial and complete progress', () => {
  const plan = normalizeDailyPlan({ date:'2026-10-10', title:'TOEIC', items:[
    { id:'a', label:'Block A', target:15, current:15, unit:'câu' },
    { id:'b', label:'Block B', target:15, current:0, unit:'câu' },
    { id:'v', label:'Vocab', target:25, current:5, unit:'mục' },
  ]});
  const summary = summarizeDailyPlan(plan);
  assert.equal(summary.complete, false);
  assert.equal(summary.completedItems, 1);
  assert.equal(summary.totalItems, 3);
  assert.equal(summary.percent, 36);
});

test('updates support increment and complete without over-crediting', () => {
  const plan = normalizeDailyPlan({ date:'2026-10-10', title:'TOEIC', items:[
    { id:'a', label:'Block A', target:15, current:0, unit:'câu' },
    { id:'b', label:'Block B', target:15, current:0, unit:'câu' },
  ]});
  const updated = applyDailyUpdates(plan, [{id:'a',complete:true},{id:'b',current:20}]);
  const summary = summarizeDailyPlan(updated);
  assert.equal(summary.percent, 100);
  assert.equal(summary.complete, true);
  assert.equal(updated.items[1].current, 20);
});

test('daily plan fact key is stable and duplicate ids are rejected', () => {
  assert.equal(dailyPlanFactKey('2026-10-10'), 'daily_plan.2026-10-10');
  assert.throws(() => normalizeDailyPlan({date:'2026-10-10',title:'x',items:[{id:'a',label:'A',target:1},{id:'a',label:'B',target:1}]}), /Duplicate/);
});

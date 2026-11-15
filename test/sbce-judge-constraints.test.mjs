import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SbceStore } from '../dist/sbce-store.js';
import { validateWorkOrder } from '../dist/sbce-core.js';
import { runSbceShadow } from '../dist/sbce-runner.js';

const dir = () => mkdtempSync(join(tmpdir(), 'sbce-judge-constraints-'));

const order = (kind) => validateWorkOrder({
  title: 'Example job',
  kind,
  goal: 'Produce a correct small draft with verified criteria',
  deliverables: ['artifact'],
  acceptance: [{ type: 'rubric', text: 'Be accurate and concise' }],
  constraints: ['Keep the word ZEBRA-42']
}, 'shadow');

const models = [
  { id: 'writer', model: 'fake-writer', provider: 'hhtech', protocol: 'openai', family: 'family-a', tier: 'T1', roles: ['writer', 'coder'], enabled: true, vndPerM: 500, dataLabels: ['internal', 'public/code'] },
  { id: 'judge', model: 'fake-judge', provider: 'hhtech', protocol: 'openai', family: 'family-b', tier: 'T1', roles: ['judge'], enabled: true, vndPerM: 500, dataLabels: ['internal', 'public/code'] }
];

let capturedJudgeInput = null;

const provider = {
  generate: async (arg) => {
    const { model } = arg;
    if (model.id === 'judge') {
      capturedJudgeInput = JSON.stringify(arg);
      return {
        text: JSON.stringify({ pass: true, reason: 'Meets rubric' }),
        usage: { input: 200, output: 90, cached: 0 },
        model: model.model,
        protocol: 'openai'
      };
    }
    return {
      text: 'This is a long, well-structured and carefully edited draft text that remains sandbox-only.',
      usage: { input: 200, output: 90, cached: 0 },
      model: model.model,
      protocol: 'openai'
    };
  }
};

test('SBCE L1 judge prompt includes the work order constraints', async () => {
  const base = dir();
  const store = new SbceStore(join(base, 'db.sqlite'));
  try {
    const job = store.submit(order('doc_write'), 'owner-task');
    const r = await runSbceShadow({ store, jobId: job.id, models, generator: provider, artifactRoot: join(base, 'artifacts'), mode: 'shadow' });
    assert.equal(r.status, 'ready_for_review');
    assert.ok(capturedJudgeInput, 'judge input was not captured');
    assert.equal(capturedJudgeInput.includes('CONSTRAINTS'), true);
    assert.equal(capturedJudgeInput.includes('ZEBRA-42'), true);
  } finally {
    store.close();
    rmSync(base, { recursive: true, force: true });
  }
});

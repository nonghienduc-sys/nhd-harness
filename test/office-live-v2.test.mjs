import test from 'node:test';
import assert from 'node:assert/strict';
import { OfficeService, encodeWordDirectCompatibilityEnvelope } from '../dist/office.js';
import { Store } from '../dist/db.js';

function makeService() {
  const store = new Store(':memory:');
  const config = {
    emergencyStop: false,
    writeEnabled: true,
    officePort: 0,
    companionSecret: 'test',
    backupDir: 'D:/tmp',
  };
  const service = new OfficeService(config, store, {});
  return { service, store };
}

test('Office Live V2 previews and applies a verified Word format operation', async () => {
  const { service } = makeService();
  let phase = 'before';
  service.inspectLive = async () => ({
    open: true,
    path: 'D:/doc.docx',
    name: 'doc.docx',
    fingerprint: phase === 'before' ? 'fp-before' : 'fp-after',
    target: { text: 'Paragraph' },
  });
  service.live = async (action) => {
    assert.equal(action, 'word_apply');
    phase = 'after';
    return { verified: true, receipt: { scope: 'paragraph' } };
  };

  const preview = await service.previewLiveEdit('word', {
    type: 'word_format',
    scope: 'paragraph',
    format: { fontName: 'Times New Roman', fontSize: 13, alignment: 'justify' },
  });
  const result = await service.applyLiveEdit(preview.actionId, preview.confirmationToken);
  assert.equal(result.applied, true);
  assert.equal(result.verified, true);
  assert.equal(result.application, 'word');
  assert.equal(result.operation, 'word_format');
  assert.equal(result.machineVerified, true);
  assert.equal(result.visualReviewRequired, true);
  assert.equal(result.completionState, 'awaiting_visual_review');
});

test('Office Live V2 fails closed when the live target changes after preview', async () => {
  const { service } = makeService();
  let fingerprint = 'fp-one';
  service.inspectLive = async () => ({ open: true, path: 'D:/doc.docx', name: 'doc.docx', fingerprint });
  service.live = async () => ({ verified: true });

  const preview = await service.previewLiveEdit('word', {
    type: 'word_page_setup',
    scope: 'document',
    page: { paperSize: 'A4', leftMarginCm: 3.0, rightMarginCm: 2.0 },
  });
  fingerprint = 'fp-two';
  await assert.rejects(() => service.applyLiveEdit(preview.actionId, preview.confirmationToken), /changed after preview/i);
});

test('Office Live V2 validates application-operation compatibility', async () => {
  const { service } = makeService();
  service.inspectLive = async () => ({ open: true, path: 'D:/book.xlsx', name: 'book.xlsx', fingerprint: 'fp' });
  await assert.rejects(() => service.previewLiveEdit('excel', {
    type: 'word_format',
    scope: 'document',
    format: { fontSize: 13 },
  }), /not valid for Excel/i);
});

test('Office Live V2 accepts bounded Excel matrix edits', async () => {
  const { service } = makeService();
  let phase = 'before';
  service.inspectLive = async () => ({ open: true, path: 'D:/book.xlsx', name: 'book.xlsx', fingerprint: phase === 'before' ? 'x1' : 'x2' });
  service.live = async (action) => {
    assert.equal(action, 'excel_apply');
    phase = 'after';
    return { verified: true, receipt: { address: 'A1:B2' } };
  };
  const preview = await service.previewLiveEdit('excel', {
    type: 'excel_set_range',
    address: 'A1:B2',
    values: [[1, 2], [3, 4]],
  });
  const result = await service.applyLiveEdit(preview.actionId, preview.confirmationToken);
  assert.equal(result.verified, true);
  assert.equal(result.visualReviewRequired, false);
  assert.equal(result.completionState, 'verified');
});


test('Office Live V2 supports fingerprinted rich append and cursor insertion operations', async () => {
  const { service } = makeService();
  const targets = [];
  let phase = 'before';
  service.inspectLive = async (_application, options = {}) => {
    targets.push(options.target ?? {});
    return { open: true, path: 'D:/doc.docx', name: 'doc.docx', fingerprint: phase === 'before' ? 'insert-before' : 'insert-after' };
  };
  service.live = async (action, input) => {
    assert.equal(action, 'word_apply');
    assert.ok(['word_append','word_insert_at_cursor'].includes(input.operation.type));
    phase = 'after';
    return { verified: true, receipt: { start: 100, end: 120, characters: 20 } };
  };

  const append = await service.previewLiveEdit('word', {
    type: 'word_append',
    blocks: [
      { text: '\nHeading\n', format: { fontName: 'Calibri', fontSize: 13, bold: true, fontColorHex: '#1F4E79' } },
      { text: 'Body', format: { fontName: 'Calibri', fontSize: 13, bold: false } },
    ],
    cursorOffset: 3,
  });
  assert.deepEqual(targets[0], { scope: 'document_end' });
  const appendResult = await service.applyLiveEdit(append.actionId, append.confirmationToken);
  assert.equal(appendResult.operation, 'word_append');
  assert.equal(appendResult.verified, true);

  phase = 'before';
  targets.length = 0;
  const cursor = await service.previewLiveEdit('word', { type: 'word_insert_at_cursor', blocks: [{ text: 'XYZ' }] });
  assert.deepEqual(targets[0], { scope: 'cursor' });
  const cursorResult = await service.applyLiveEdit(cursor.actionId, cursor.confirmationToken);
  assert.equal(cursorResult.operation, 'word_insert_at_cursor');
  assert.equal(cursorResult.verified, true);
});

test('Office Live V2 rejects oversized direct Word insert payloads', async () => {
  const { service } = makeService();
  await assert.rejects(() => service.previewLiveEdit('word', { type: 'word_append', blocks: [{ text: 'x'.repeat(20001) }] }), /20,000 characters/i);
});


test('stale-schema compatibility envelope routes cached replace_selection schema to rich Word append', async () => {
  const { service } = makeService();
  const targets = [];
  let phase = 'before';
  let selectionReadCalled = false;
  service.inspectLive = async (_application, options = {}) => {
    targets.push(options.target ?? {});
    return { open: true, path: 'D:/doc.docx', name: 'doc.docx', fingerprint: phase === 'before' ? 'compat-before' : 'compat-after' };
  };
  service.live = async (action, input) => {
    if (action === 'word_selection_read') { selectionReadCalled = true; throw new Error('compat route must not use legacy selection read'); }
    assert.equal(action, 'word_apply');
    assert.equal(input.operation.type, 'word_append');
    assert.equal(input.operation.blocks[0].format.fontColorHex, '#006060');
    phase = 'after';
    return { verified: true, receipt: { start: 50, end: 62, characters: 12, blocks: [{ formatVerified: true }] } };
  };
  const envelope = encodeWordDirectCompatibilityEnvelope({
    mode: 'append',
    blocks: [{ text: 'Tiếng Việt\n', format: { fontName: 'Calibri', fontSize: 13, bold: true, fontColorHex: '#006060' } }],
    cursorOffset: 10,
  });
  assert.ok(envelope.startsWith('NHD_WORD_DIRECT_V1:'));
  const preview = await service.previewLiveEdit('word', { type: 'replace_selection', text: envelope });
  assert.equal(preview.compatibilityFastLane, true);
  assert.equal(preview.operation.type, 'word_append');
  assert.deepEqual(targets[0], { scope: 'document_end' });
  const result = await service.applyLiveEdit(preview.actionId, preview.confirmationToken);
  assert.equal(result.operation, 'word_append');
  assert.equal(result.verified, true);
  assert.equal(selectionReadCalled, false);
});

test('ordinary replace_selection keeps the legacy non-empty-selection contract', async () => {
  const { service } = makeService();
  service.live = async (action) => {
    assert.equal(action, 'word_selection_read');
    return { open: true, path: 'D:/doc.docx', name: 'doc.docx', selection: { start: 1, end: 4, text: 'old' } };
  };
  const preview = await service.previewLiveEdit('word', { type: 'replace_selection', text: 'new' });
  assert.equal(preview.operation.type, 'replace_selection');
  assert.equal(preview.compatibilityFastLane, undefined);
  assert.equal(preview.baseline.text, 'old');
});

test('malformed compatibility envelope fails closed without touching Word', async () => {
  const { service } = makeService();
  let touched = false;
  service.live = async () => { touched = true; return {}; };
  await assert.rejects(() => service.previewLiveEdit('word', { type: 'replace_selection', text: 'NHD_WORD_DIRECT_V1:not-valid-base64-json' }), /compatibility envelope/i);
  assert.equal(touched, false);
});

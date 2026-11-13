import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../dist/db.js';
import { FileService } from '../dist/files.js';
import { assertNoIntroducedRedaction, countRedactionMarkers, redactWithFlag } from '../dist/security.js';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'nhd-redaction-guard-')); const backupDir = join(dir, 'backups'); mkdirSync(backupDir);
  const config = { instanceId: 'redaction-test', host: '127.0.0.1', port: 39993, officePort: 39994, screenPort: 39995, roots: [dir], intakeRoots: [dir], dataDir: dir, backupDir, writeEnabled: true, terminalEnabled: true, skillsEnabled: true, screenEnabled: false, desktopEnabled: false, visualDesktopEnabled: false, intakeEnabled: true, ocrEnabled: true, disabledSkills: [], tunnelEnabled: false, tunnelMode: 'quick', namedTunnelName: '', namedTunnelConfig: '', publicHostname: '', emergencyStop: false, pairingCode: 'TEST', companionSecret: 'TEST_SECRET', cloudflaredPath: 'cloudflared.exe' };
  const store = new Store(join(dir, 'test.sqlite'));
  return { dir, files: new FileService(config, store) };
}

test('redactWithFlag reports masking and counts markers', () => {
  const masked = redactWithFlag('const a = 1;\ncompanionSecret: value123,\n');
  assert.equal(masked.redacted, true);
  assert.equal(masked.redactedCount, 1);
  assert.match(masked.text, /companionSecret: \[REDACTED\]/);
  assert.deepEqual(redactWithFlag('plain code'), { text: 'plain code', redacted: false, redactedCount: 0 });
  assert.equal(countRedactionMarkers('[REDACTED] x [REDACTED]'), 2);
});

test('assertNoIntroducedRedaction blocks new markers but allows markers already in the original', () => {
  assert.throws(() => assertNoIntroducedRedaction('x: [REDACTED]', 'x: real', 'unit'), /REDACTION_MARKER_WRITE_BLOCKED/);
  assert.doesNotThrow(() => assertNoIntroducedRedaction('doc mentions [REDACTED] marker', 'doc mentions [REDACTED] marker', 'unit'));
  assert.doesNotThrow(() => assertNoIntroducedRedaction('no marker', null, 'unit'));
});

test('fs read exposes redacted flag and fs preview write rejects a redacted round-trip', () => {
  const { dir, files } = fixture();
  const target = join(dir, 'main.cjs');
  const original = 'const companionSecret = process.env.X;\nconst opts = { companionSecret: realValue };\n';
  writeFileSync(target, original, 'utf8');
  const read = files.readWithMeta(target);
  assert.equal(read.redacted, true);
  assert.ok(read.redactedCount >= 1);
  assert.equal(files.read(target), read.text);
  assert.throws(() => files.preview('write', { path: target, content: read.text + '\n// edit' }), /REDACTION_MARKER_WRITE_BLOCKED/);
  assert.equal(readFileSync(target, 'utf8'), original);
  const ok = files.preview('write', { path: target, content: original + '// edit\n' });
  assert.ok(ok.actionId);
  const docTarget = join(dir, 'notes.md');
  writeFileSync(docTarget, 'Logs show [REDACTED] placeholders.\n', 'utf8');
  assert.ok(files.preview('write', { path: docTarget, content: 'Logs show [REDACTED] placeholders.\nMore.\n' }).actionId);
});

test('Office and document write paths carry the redaction guard', () => {
  const office = readFileSync(new URL('../src/office.ts', import.meta.url), 'utf8');
  const document = readFileSync(new URL('../src/document.ts', import.meta.url), 'utf8');
  const tools = readFileSync(new URL('../src/mcp-registries/files-tools.ts', import.meta.url), 'utf8');
  assert.match(office, /assertNoIntroducedRedaction\(String\(operation\.replace/);
  assert.match(office, /if \(!legacySelectionReplace\) assertLiveOperationRedactionSafe\(effectiveOperation\)/);
  assert.match(office, /assertLiveOperationRedactionSafe\(effectiveOperation, text\)/);
  assert.match(document, /assertNoIntroducedRedaction\(blocks\.map/);
  assert.match(tools, /files\.readWithMeta\(path/);
  assert.match(tools, /redacted: true/);
});

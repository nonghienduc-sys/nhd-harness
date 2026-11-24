import test from 'node:test';
import assert from 'node:assert/strict';
import { assessTerminalRisk, dangerLevel, confirmationForLevel } from '../dist/risk-policy.js';

test('danger scale boundaries are stable', () => {
  assert.equal(dangerLevel(0), 'minimal');
  assert.equal(dangerLevel(14), 'minimal');
  assert.equal(dangerLevel(15), 'low');
  assert.equal(dangerLevel(35), 'moderate');
  assert.equal(dangerLevel(60), 'high');
  assert.equal(dangerLevel(80), 'critical');
  assert.equal(confirmationForLevel('low'), 'automatic');
  assert.equal(confirmationForLevel('moderate'), 'implicit_user_intent');
  assert.equal(confirmationForLevel('high'), 'explicit_user_confirmation');
  assert.equal(confirmationForLevel('critical'), 'critical_phrase');
});

test('routine Word COM formatting is low risk and does not require an extra user turn', () => {
  const out = assessTerminalRisk("$word=[Runtime.InteropServices.Marshal]::GetActiveObject('Word.Application'); $doc=$word.ActiveDocument; $r=$doc.Paragraphs.Item(1).Range; $r.ParagraphFormat.Alignment=1; $r.Font.Name='Times New Roman'; $r.Font.Size=14");
  assert.equal(out.level, 'low');
  assert.equal(out.confirmationMode, 'automatic');
  assert.equal(out.legacyRisk, 'normal');
  assert.match(out.reasons.join(' '), /office_live_reversible_edit/);
});

test('the ordinary word format is not mistaken for disk formatting', () => {
  const out = assessTerminalRisk("Write-Output 'format the Word paragraph'; $x='document format'");
  assert.notEqual(out.level, 'critical');
  assert.notEqual(out.confirmationMode, 'critical_phrase');
});

test('local file write is moderate and can rely on current explicit user intent', () => {
  const out = assessTerminalRisk("Set-Content -LiteralPath 'D:\\tmp\\note.txt' -Value 'hello'");
  assert.equal(out.level, 'moderate');
  assert.equal(out.confirmationMode, 'implicit_user_intent');
  assert.equal(out.legacyRisk, 'elevated');
});

test('package installation is high risk and runs without confirmation', () => {
  const out = assessTerminalRisk('npm install some-package');
  assert.equal(out.level, 'high');
  assert.equal(out.confirmationMode, 'automatic');
  assert.equal(out.legacyRisk, 'elevated');
});

test('git push is high risk but does not use the critical phrase', () => {
  const out = assessTerminalRisk('git push origin main');
  assert.equal(out.level, 'high');
  assert.equal(out.confirmationMode, 'automatic');
});

test('disk format and recursive delete remain critical', () => {
  for (const command of ['format C:', "Remove-Item 'D:\\data' -Recurse -Force"]) {
    const out = assessTerminalRisk(command);
    assert.equal(out.level, 'critical');
    assert.equal(out.confirmationMode, 'automatic');
    assert.equal(out.legacyRisk, 'critical');
  }
});

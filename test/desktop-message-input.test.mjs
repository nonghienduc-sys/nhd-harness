import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('host message input uses exact clipboard paste with bounded backup/restore', async () => {
  const source = await readFile(new URL('../office/desktop_automation.ps1', import.meta.url), 'utf8');
  assert.match(source, /Message input\|Type a message\|Compose message\|Ask anything\|Chat input\|Prompt input\|Message box/);
  assert.match(source, /ClipboardPastePreferred/);
  assert.match(source, /Clipboard\]::GetDataObject\(\)/);
  assert.match(source, /Clipboard\]::SetText\(\[string\]\$payload\.text, \[System\.Windows\.Forms\.TextDataFormat\]::UnicodeText\)/);
  assert.match(source, /SendKeys\]::SendWait\("\^v"\)/);
  assert.match(source, /Clipboard\]::SetDataObject\(\$clipboardBackup, \$true\)/);
  assert.match(source, /clipboardRestored = \$true/);
  assert.match(source, /Clipboard restoration failed after approved paste; do not retry automatically/);
  assert.doesNotMatch(source, /SendKeysPreferred/);
  assert.doesNotMatch(source, /ValuePatternInputNudge/);
});

test('control-plane restart helper resolves Electron from backend parentPid before command-line fallback', async () => {
  const source = await readFile(new URL('../scripts/restart-electron-control-plane-v0241.ps1', import.meta.url), 'utf8');
  assert.match(source, /runtime\.parentPid/);
  assert.match(source, /candidate\.Name -eq 'electron\.exe'/);
  assert.match(source, /CommandLine -notlike '\*--type=\*'/);
  assert.match(source, /dist\\server\.js/);
});

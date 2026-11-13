import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const script=readFileSync(new URL('../scripts/publish-lite-github.ps1',import.meta.url),'utf8');
test('direct GitHub publishing uploads only hashed installer and checksum as a draft',()=>{
  assert.match(script,/NHD-Harness-Lite-Setup\.exe/);
  assert.match(script,/SHA256SUMS\.txt/);
  assert.match(script,/Get-FileHash/);
  assert.match(script,/release-readiness\.json/);
  assert.match(script,/gh release create/);
  assert.match(script,/--draft/);
  assert.match(script,/visibility/);
  assert.match(script,/Get-AuthenticodeSignature/);
  assert.doesNotMatch(script,/gh repo create|--clobber|--latest/);
});

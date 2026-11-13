import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const read = file => readFileSync(new URL('../dashboard/'+file,import.meta.url),'utf8');
test('setup wizard requires user consent and no secrets are requested in form',()=>{
  const html=read('setup.html'),js=read('setup.js');
  assert.match(html,/type="checkbox" id="confirmed"/);
  assert.match(js,/confirmed:true/);
  assert.match(html,/https:\/\/developers\.openai\.com/);
  assert.doesNotMatch(html,/type="password"/);
});

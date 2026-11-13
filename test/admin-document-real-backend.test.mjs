import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {makeAdminLayoutFixture} from '../scripts/admin-document-layout-fixture.mjs';
import {changeDocx,sha,textOf,xmlFrom} from '../scripts/admin-docx-backend.mjs';
import {inspectAdminDocxBuffer} from './helpers/admin-docx-inspector.mjs';
const root=resolve(fileURLToPath(new URL('..',import.meta.url)));
const fixture=JSON.parse(readFileSync(resolve(root,'test/fixtures/admin-document-cases.v1.json'),'utf8')).cases.find(c=>c.id==='cong_van');
test('actual backend formats malformed source without altering text, repairs margins and font',async()=>{
 const original=await makeAdminLayoutFixture(fixture);
 const broken=await changeDocx(original,false);
 const before=await inspectAdminDocxBuffer(broken,fixture);
 assert.equal(before.ok,false);
 assert.ok(before.errors.some(x=>x.includes('margin')));
 assert.ok(before.errors.some(x=>x.includes('font')));
 const repaired=await changeDocx(broken,true);
 const after=await inspectAdminDocxBuffer(repaired,fixture);
 assert.equal(after.ok,true,JSON.stringify(after.errors));
 assert.notEqual(sha(broken),sha(repaired));
 assert.equal(textOf(await xmlFrom(broken)),textOf(await xmlFrom(repaired)));
});
test('national identity is in two-column header table, no underscore fake motto line',async()=>{
 const b=await makeAdminLayoutFixture(fixture);
 const xml=await xmlFrom(b);
 assert.match(xml,/<w:tbl>/);
 assert.match(xml,/<w:tblGrid>/);
 assert.match(xml, /CỘNG HÒA XÃ HỘI CHỦ NGHĨA VIỆT NAM/);
 assert.match(xml, /<w:pBdr>/);
 assert.doesNotMatch(xml, /__________________/);
});
test('compiled artifact routing chooses canonical and excludes legacy primary',()=>{
 const s=readFileSync(resolve(root,'dist/artifact-intelligence.js'),'utf8');
 assert.match(s,/primarySkill = "viet-admin-format-checker"/);
 assert.doesNotMatch(s,/primarySkill = "skill-chinh-sua-format-van-ban"/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const src=readFileSync(new URL('../skills/local-semantic-search/scripts/semantic_store.py',import.meta.url),'utf8');
test('hybrid retrieval store includes FTS5 and RRF without removing vector compatibility',()=>{
 assert.match(src,/fts5\(/i);
 assert.match(src,/bm25\(/i);
 assert.match(src,/reciprocal-rank-fusion|rrf_score/i);
 assert.match(src,/def search\(/);
 assert.match(src,/def hybrid\(/);
 assert.match(src,/locator/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  editBlocksToPatch,
  parseEditBlocks,
} from '../dist/sbce-edit-blocks.js';

const files = {
  'src/a.ts': 'l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\nl9\nl10\n',
};
const readFile = p => files[p] ?? null;

test('replaces a matching block in an existing file', () => {
  const result = editBlocksToPatch(
    `FILE: src/a.ts
<<<<<<< SEARCH
l5
=======
X
>>>>>>> REPLACE`,
    readFile,
  );

  assert.equal(result.ok, true);
  assert.match(result.patch, /diff --git a\/src\/a\.ts b\/src\/a\.ts/);
  assert.match(result.patch, /@@ -2,7 \+2,7 @@/);
  assert.match(result.patch, /^-l5$/m);
  assert.match(result.patch, /^\+X$/m);
});

test('creates a new file from an empty search block', () => {
  const result = editBlocksToPatch(
    `FILE: src/b.ts
<<<<<<< SEARCH
=======
hello
>>>>>>> REPLACE`,
    readFile,
  );

  assert.equal(result.ok, true);
  assert.match(result.patch, /new file mode 100644/);
  assert.match(result.patch, /^--- \/dev\/null$/m);
  assert.match(result.patch, /@@ -0,0 \+1,1 @@/);
});

test('reports a search string that is not found', () => {
  const result = editBlocksToPatch(
    `FILE: src/a.ts
<<<<<<< SEARCH
missing
=======
X
>>>>>>> REPLACE`,
    readFile,
  );

  assert.equal(result.ok, false);
  assert.match(result.errors[0], /^SBCE_EDIT_SEARCH_NOT_FOUND/);
});

test('rejects paths outside the workspace', () => {
  const result = editBlocksToPatch(
    `FILE: ../x.ts
<<<<<<< SEARCH
l5
=======
X
>>>>>>> REPLACE`,
    readFile,
  );

  assert.equal(result.ok, false);
  assert.ok(result.errors.some(error => error.startsWith('SBCE_EDIT_PATH_INVALID')));
});

test('rejects a malformed edit block', () => {
  assert.throws(
    () =>
      parseEditBlocks(`FILE: src/a.ts
<<<<<<< SEARCH
l5
=======
X`),
    /SBCE_EDIT_BLOCK_SYNTAX/,
  );
});
test('two distant edits with blank lines between blocks give correct hunk headers', () => {
  const big = { 'src/c.ts': Array.from({ length: 30 }, (_, i) => `c${i + 1}`).join('\n') + '\n' };
  const result = editBlocksToPatch(
    `\nFILE: src/c.ts\n<<<<<<< SEARCH\nc5\n=======\nX1\nX2\n>>>>>>> REPLACE\n\nFILE: src/c.ts\n<<<<<<< SEARCH\nc25\n=======\nY\n>>>>>>> REPLACE\n`,
    p => big[p] ?? null,
  );
  assert.equal(result.ok, true);
  assert.match(result.patch, /@@ -2,7 \+2,8 @@/);
  assert.match(result.patch, /@@ -22,7 \+23,7 @@/);
});
test('tolerates prose, bold FILE markers, fences and marker whitespace', () => {
  const files = { 'src/d.ts': 'a\nb\nc\n' };
  const result = editBlocksToPatch(
    "Here is the change:\n\n**FILE: `src/d.ts`**\n```ts\n<<<<<<< SEARCH  \nb\n=======\nB\n>>>>>>> REPLACE\n```\nDone.",
    p => files[p] ?? null,
  );
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.match(result.patch, /-b\n\+B/);
});
test('matches SEARCH lines copied with line-number prefixes or trailing spaces', () => {
  const files = { 'src/e.ts': 'x\ny  \nz\n' };
  const prefixed = editBlocksToPatch('FILE: src/e.ts\n<<<<<<< SEARCH\n00002| y  \n=======\nY\n>>>>>>> REPLACE', p => files[p] ?? null);
  assert.equal(prefixed.ok, true, JSON.stringify(prefixed));
  const trailing = editBlocksToPatch('FILE: src/e.ts\n<<<<<<< SEARCH\ny\n=======\nY\n>>>>>>> REPLACE', p => files[p] ?? null);
  assert.equal(trailing.ok, true, JSON.stringify(trailing));
  assert.match(trailing.patch, /-y  \n\+Y/);
});
test('syntax errors say which line and why', () => {
  const r = editBlocksToPatch('FILE: src/a.ts\nnot a marker\n', () => 'a\n');
  assert.equal(r.ok, false);
  assert.match(r.errors[0], /SBCE_EDIT_BLOCK_SYNTAX: line 2: expected '<<<<<<< SEARCH'/);
  assert.match(editBlocksToPatch('just prose', () => null).errors[0], /no 'FILE: <path>' block/);
});

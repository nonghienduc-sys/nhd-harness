import test from 'node:test';
import assert from 'node:assert/strict';
import { isReleaseProtectedPath, isSystemProtectedPath } from '../dist/files.js';

const root = 'D:\\ChatGPT-Workstation-MCP';

test('release dirs, deploy-backups and release-state are protected', () => {
  assert.equal(isReleaseProtectedPath(root + '\\releases', root), true);
  assert.equal(isReleaseProtectedPath(root + '\\releases\\v0.24.8-a7ca0cc9359a\\dist\\server.js', root), true);
  assert.equal(isReleaseProtectedPath(root + '\\RELEASES\\x.txt', root), true);
  assert.equal(isReleaseProtectedPath(root + '\\deploy-backups\\r.json', root), true);
  assert.equal(isReleaseProtectedPath(root + '\\runtime\\release-state.json', root), true);
});

test('ordinary source and runtime paths stay writable', () => {
  assert.equal(isReleaseProtectedPath(root + '\\src\\files.ts', root), false);
  assert.equal(isReleaseProtectedPath(root + '\\releases-notes.md', root), false);
  assert.equal(isReleaseProtectedPath(root + '\\runtime\\deployment-manifest.json', root), false);
  assert.equal(isReleaseProtectedPath('D:\\NHD Projects\\a.docx', root), false);
});

test('harness data dir and Windows dir are read-only for fs tools', () => {
  const data = 'C:\\ProgramData\\ChatGPTWorkstationBridge';
  const sys = 'C:\\Windows';
  assert.equal(isSystemProtectedPath(data + '\\config.json', data, sys), true);
  assert.equal(isSystemProtectedPath(data + '\\workstation.sqlite', data, sys), true);
  assert.equal(isSystemProtectedPath('c:\\windows\\System32\\drivers\\etc\\hosts', data, sys), true);
  assert.equal(isSystemProtectedPath('C:\\Users\\ADMIN\\Documents\\a.docx', data, sys), false);
  assert.equal(isSystemProtectedPath('C:\\ProgramData\\Other\\x.txt', data, sys), false);
  assert.equal(isSystemProtectedPath('D:\\NHD Projects\\x.md', data, sys), false);
});

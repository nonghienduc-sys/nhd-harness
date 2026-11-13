import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  RELEASE_MODEL,
  bootstrapReleaseState,
  materializeWorkspaceRelease,
  markCandidateVerified,
  promoteCandidate,
  readReleaseState,
  rollbackRelease,
  stageWorkspaceRelease,
  sourceHash,
} from '../scripts/atomic-release.mjs';
import { RuntimeIdentityService } from '../dist/runtime-identity.js';

function makeWorkspace(version = '1.0.0', serverText = 'console.log("one")') {
  const root = mkdtempSync(join(tmpdir(), 'nhd-atomic-release-'));
  mkdirSync(join(root, 'dist'), { recursive: true });
  mkdirSync(join(root, 'src'), { recursive: true });
  mkdirSync(join(root, 'runtime'), { recursive: true });
  writeFileSync(join(root, 'dist', 'server.js'), serverText, 'utf8');
  writeFileSync(join(root, 'dist', 'server.js.map'), '{}', 'utf8');
  writeFileSync(join(root, 'src', 'server.ts'), 'export const x = 1;\n', 'utf8');
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'fixture', version }, null, 2), 'utf8');
  writeFileSync(join(root, 'tsconfig.json'), '{}', 'utf8');
  writeFileSync(join(root, 'runtime', 'deployment-manifest.json'), JSON.stringify({ schemaVersion: 2, sourceVersion: version, sourceRoot: root }, null, 2), 'utf8');
  return root;
}

function changeWorkspace(root, version, serverText) {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  pkg.version = version;
  writeFileSync(join(root, 'package.json'), JSON.stringify(pkg, null, 2), 'utf8');
  writeFileSync(join(root, 'dist', 'server.js'), serverText, 'utf8');
  writeFileSync(join(root, 'src', 'server.ts'), `export const x = ${JSON.stringify(version)};\n`, 'utf8');
}

test('atomic release manager stages immutable candidate, gates promotion, promotes atomically and rolls back by pointer swap', () => {
  const root = makeWorkspace();
  try {
    const baseline = materializeWorkspaceRelease(root, { verifiedAt: '2026-10-15T00:00:00.000Z', verificationReceipt: join(root, 'baseline.json') });
    const boot = bootstrapReleaseState(root, baseline.id);
    assert.equal(boot.model, RELEASE_MODEL);
    assert.equal(boot.generation, 1);
    assert.equal(boot.current.id, baseline.id);
    assert.equal(boot.previous, null);
    assert.equal(boot.candidate, null);

    const again = materializeWorkspaceRelease(root);
    assert.equal(again.id, baseline.id, 'identical payload must reuse the immutable release instead of overwriting it');

    changeWorkspace(root, '1.1.0', 'console.log("two")');
    const staged = stageWorkspaceRelease(root, { version: '1.1.0' });
    assert.equal(staged.current.id, baseline.id);
    assert.equal(staged.candidate.version, '1.1.0');
    assert.equal(staged.candidate.verifiedAt, null);
    assert.throws(() => promoteCandidate(root, staged.candidate.id), /not passed/i);

    const receipt = join(root, 'candidate-smoke.json');
    writeFileSync(receipt, '{"ok":true}', 'utf8');
    const verified = markCandidateVerified(root, staged.candidate.id, receipt);
    assert.ok(verified.candidate.verifiedAt);
    assert.equal(resolve(verified.candidate.smokeReceipt), resolve(receipt));

    const promoted = promoteCandidate(root, staged.candidate.id);
    assert.equal(promoted.generation, 2);
    assert.equal(promoted.current.version, '1.1.0');
    assert.equal(promoted.previous.version, '1.0.0');
    assert.equal(promoted.candidate, null);

    const rolled = rollbackRelease(root);
    assert.equal(rolled.generation, 3);
    assert.equal(rolled.current.version, '1.0.0');
    assert.equal(rolled.previous.version, '1.1.0');
    assert.equal(rolled.candidate, null);
    assert.equal(readdirSync(join(root, 'runtime')).some(name => name.includes('.tmp-')), false, 'atomic pointer update must not leave temporary files');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('runtime identity reports atomic current/previous/candidate roles when release state is explicitly injected', () => {
  const root = makeWorkspace();
  const old = {
    state: process.env.NHD_RELEASE_STATE_PATH,
    id: process.env.NHD_RELEASE_ID,
    path: process.env.NHD_RELEASE_PATH,
    sourceRoot: process.env.NHD_SOURCE_ROOT,
    sourceVersion: process.env.NHD_SOURCE_VERSION,
  };
  try {
    const base = materializeWorkspaceRelease(root, { verifiedAt: '2026-10-15T00:00:00.000Z', verificationReceipt: join(root, 'base.json') });
    bootstrapReleaseState(root, base.id);
    changeWorkspace(root, '1.1.0', 'console.log("candidate")');
    let state = stageWorkspaceRelease(root, { version: '1.1.0' });
    const receipt = join(root, 'smoke.json'); writeFileSync(receipt, '{"ok":true}', 'utf8');
    state = markCandidateVerified(root, state.candidate.id, receipt);
    state = promoteCandidate(root, state.candidate.id);

    process.env.NHD_RELEASE_STATE_PATH = join(root, 'runtime', 'release-state.json');
    process.env.NHD_RELEASE_ID = state.current.id;
    process.env.NHD_RELEASE_PATH = state.current.path;
    process.env.NHD_SOURCE_ROOT = root;
    process.env.NHD_SOURCE_VERSION = '1.1.0';
    const identity = new RuntimeIdentityService(state.current.path).identity();
    assert.equal(identity.release.model, RELEASE_MODEL);
    assert.equal(identity.release.active.role, 'current');
    assert.equal(identity.release.currentMatchesActive, true);
    assert.equal(identity.release.current.id, state.current.id);
    assert.equal(identity.release.previous.id, base.id);
    assert.equal(identity.candidateVersion, null);
    assert.equal(identity.rollbackVersion, '1.0.0');
    assert.equal(resolve(identity.rollbackPath), resolve(base.path));
    assert.equal(identity.consistency.currentReleaseMatchesActive, true);
  } finally {
    const restore = (key, value) => value == null ? delete process.env[key] : process.env[key] = value;
    restore('NHD_RELEASE_STATE_PATH', old.state); restore('NHD_RELEASE_ID', old.id); restore('NHD_RELEASE_PATH', old.path); restore('NHD_SOURCE_ROOT', old.sourceRoot); restore('NHD_SOURCE_VERSION', old.sourceVersion);
    rmSync(root, { recursive: true, force: true });
  }
});

test('Electron is an atomic-release control plane and keeps backend cwd on the stable source root', () => {
  const main = readFileSync(new URL('../electron/main.cjs', import.meta.url), 'utf8');
  assert.match(main, /release-state\.json/);
  assert.match(main, /atomic-json-pointer-v1/);
  assert.match(main, /resolveActiveRelease/);
  assert.match(main, /pathInside\(releasesRoot, currentPath\)/);
  assert.match(main, /const scriptPath = path\.join\(activeRelease\.path, "dist", script\)/);
  assert.match(main, /cwd: root/);
  assert.match(main, /NHD_RELEASE_STATE_PATH/);
  assert.match(main, /NHD_RELEASE_ID/);
  assert.match(main, /NHD_RELEASE_PATH/);
  assert.match(main, /NHD_SOURCE_ROOT: root/);
});

test('real release-state parser rejects a current path outside releases root', () => {
  const root = makeWorkspace();
  try {
    mkdirSync(join(root, 'runtime'), { recursive: true });
    writeFileSync(join(root, 'runtime', 'release-state.json'), JSON.stringify({
      schemaVersion: 1, model: RELEASE_MODEL, generation: 1,
      current: { id: 'evil', version: '1.0.0', path: resolve(root) }, previous: null, candidate: null,
    }), 'utf8');
    assert.throws(() => readReleaseState(root), /outside the immutable releases root/i);
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test('source hash tracks runtime Office/Python worker scripts used by release code', () => {
  const root=makeWorkspace();
  try{
    mkdirSync(join(root,'office'),{recursive:true});
    writeFileSync(join(root,'office','pdf_worker.py'),'print(1)\n','utf8');
    const one=sourceHash(root);
    writeFileSync(join(root,'office','pdf_worker.py'),'print(2)\n','utf8');
    const two=sourceHash(root);
    assert.notEqual(one,two);
  }finally{rmSync(root,{recursive:true,force:true});}
});

import { createHash, randomBytes } from 'node:crypto';
import { closeSync, copyFileSync, cpSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const RELEASE_MODEL = 'atomic-json-pointer-v1';
export const RELEASE_SCHEMA_VERSION = 1;

const scriptDir = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_ROOT = resolve(scriptDir, '..');

function nowIso() { return new Date().toISOString(); }
function json(path) { return JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, '')); }
function packageVersion(root) { return String(json(join(root, 'package.json')).version || '').trim(); }
function ensureDir(path) { mkdirSync(path, { recursive: true }); }

export function isWithin(parent, child) {
  const rel = relative(resolve(parent), resolve(child));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function listFiles(root, predicate = () => true) {
  if (!existsSync(root)) return [];
  const out = [];
  const walk = dir => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      const stat = statSync(path);
      if (stat.isDirectory()) walk(path);
      else if (stat.isFile() && predicate(path)) out.push(path);
    }
  };
  walk(root);
  return out.sort((a, b) => a.localeCompare(b));
}

function treeHash(root, files) {
  const hash = createHash('sha256');
  for (const file of files) {
    hash.update(relative(root, file).replace(/\\/g, '/'));
    hash.update('\0');
    hash.update(readFileSync(file));
    hash.update('\0');
  }
  return hash.digest('hex');
}

export function deploymentHash(root) {
  const files = [
    ...listFiles(join(root, 'dist'), p => /\.(?:js|json)$/i.test(p)),
    join(root, 'package.json'),
  ].filter(existsSync);
  if (!files.length) throw new Error(`Release payload has no hashable files: ${root}`);
  return treeHash(root, files);
}

export function sourceHash(root) {
  const files = [
    ...listFiles(join(root, 'src'), p => /\.ts$/i.test(p)),
    ...listFiles(join(root, 'office'), p => /\.(?:py|ps1)$/i.test(p)),
    join(root, 'package.json'),
    join(root, 'tsconfig.json'),
  ].filter(existsSync);
  if (!files.length) return null;
  return treeHash(root, files);
}

export function releaseStatePath(root = DEFAULT_ROOT) { return join(resolve(root), 'runtime', 'release-state.json'); }
export function releasesRoot(root = DEFAULT_ROOT) { return join(resolve(root), 'releases'); }

export function atomicWriteJson(path, value) {
  ensureDir(dirname(path));
  const temp = `${path}.tmp-${process.pid}-${Date.now()}-${randomBytes(4).toString('hex')}`;
  const text = `${JSON.stringify(value, null, 2)}\n`;
  const fd = openSync(temp, 'wx');
  try {
    writeFileSync(fd, text, { encoding: 'utf8' });
    fsyncSync(fd);
  } finally { closeSync(fd); }
  try { renameSync(temp, path); }
  catch (error) { try { rmSync(temp, { force: true }); } catch {} throw error; }
}

function validateDescriptor(root, descriptor, label = 'release') {
  if (!descriptor || typeof descriptor !== 'object') throw new Error(`${label} descriptor is missing.`);
  const releases = releasesRoot(root);
  const path = resolve(String(descriptor.path || ''));
  if (!path || !isWithin(releases, path) || path === resolve(releases)) throw new Error(`${label} path is outside the immutable releases root.`);
  if (!existsSync(join(path, 'dist', 'server.js'))) throw new Error(`${label} server.js is missing.`);
  const version = String(descriptor.version || '').trim();
  const id = String(descriptor.id || '').trim();
  if (!version || !id) throw new Error(`${label} id/version is missing.`);
  const pkg = packageVersion(path);
  if (pkg !== version) throw new Error(`${label} package version mismatch: ${pkg} != ${version}.`);
  return { ...descriptor, id, version, path, immutable: true };
}

export function readReleaseState(root = DEFAULT_ROOT, { required = true } = {}) {
  const statePath = releaseStatePath(root);
  if (!existsSync(statePath)) {
    if (!required) return null;
    throw new Error(`Release state does not exist: ${statePath}`);
  }
  const state = json(statePath);
  if (state.schemaVersion !== RELEASE_SCHEMA_VERSION || state.model !== RELEASE_MODEL) throw new Error('Unsupported release-state schema/model.');
  const current = validateDescriptor(root, state.current, 'current');
  const previous = state.previous ? validateDescriptor(root, state.previous, 'previous') : null;
  const candidate = state.candidate ? validateDescriptor(root, state.candidate, 'candidate') : null;
  return { ...state, generation: Number(state.generation || 1), current, previous, candidate };
}

function writeState(root, state) {
  const normalized = {
    schemaVersion: RELEASE_SCHEMA_VERSION,
    model: RELEASE_MODEL,
    generation: Math.max(1, Number(state.generation || 1)),
    current: state.current,
    previous: state.previous ?? null,
    candidate: state.candidate ?? null,
    updatedAt: nowIso(),
  };
  atomicWriteJson(releaseStatePath(root), normalized);
  return readReleaseState(root);
}

export function descriptorFromRelease(root, releasePath) {
  const abs = resolve(releasePath);
  if (!isWithin(releasesRoot(root), abs) || abs === resolve(releasesRoot(root))) throw new Error('Release path must be inside releases/.');
  const metaPath = join(abs, 'release.json');
  const meta = existsSync(metaPath) ? json(metaPath) : {};
  const version = String(meta.version || packageVersion(abs));
  const hash = deploymentHash(abs);
  const id = String(meta.id || `v${version}-${hash.slice(0, 12)}`);
  if (meta.deploymentHash && String(meta.deploymentHash) !== hash) throw new Error(`Immutable release hash mismatch for ${id}.`);
  return validateDescriptor(root, {
    id,
    version,
    path: abs,
    deploymentHash: hash,
    sourceHash: meta.sourceHash || null,
    builtAt: meta.createdAt || meta.builtAt || null,
    verifiedAt: meta.verifiedAt || null,
    smokeReceipt: meta.verificationReceipt || meta.smokeReceipt || null,
    immutable: true,
  });
}

export function materializeWorkspaceRelease(root = DEFAULT_ROOT, options = {}) {
  root = resolve(root);
  const version = String(options.version || packageVersion(root));
  if (packageVersion(root) !== version) throw new Error(`Workspace package version is not ${version}.`);
  if (!existsSync(join(root, 'dist', 'server.js'))) throw new Error('Workspace dist/server.js is missing. Run the build first.');
  ensureDir(releasesRoot(root));
  const temp = join(releasesRoot(root), `.materialize-${version}-${process.pid}-${Date.now()}-${randomBytes(3).toString('hex')}`);
  ensureDir(temp);
  try {
    cpSync(join(root, 'dist'), join(temp, 'dist'), { recursive: true, force: false, errorOnExist: true });
    copyFileSync(join(root, 'package.json'), join(temp, 'package.json'));
    const runtimeManifest = join(root, 'runtime', 'deployment-manifest.json');
    if (existsSync(runtimeManifest)) {
      ensureDir(join(temp, 'runtime'));
      copyFileSync(runtimeManifest, join(temp, 'runtime', 'deployment-manifest.json'));
    }
    const hash = deploymentHash(temp);
    const srcHash = options.sourceHash || sourceHash(root);
    const id = `v${version}-${hash.slice(0, 12)}`;
    const finalPath = join(releasesRoot(root), id);
    const metadata = {
      schemaVersion: 1,
      id,
      version,
      immutable: true,
      sourceRoot: root,
      deploymentHash: hash,
      sourceHash: srcHash,
      createdAt: nowIso(),
      verifiedAt: options.verifiedAt || null,
      verificationReceipt: options.verificationReceipt || null,
    };
    writeFileSync(join(temp, 'release.json'), `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');
    if (existsSync(finalPath)) {
      const existing = descriptorFromRelease(root, finalPath);
      if (existing.deploymentHash !== hash || existing.version !== version) throw new Error(`Immutable release id collision: ${id}`);
      rmSync(temp, { recursive: true, force: true });
      return existing;
    }
    renameSync(temp, finalPath);
    return descriptorFromRelease(root, finalPath);
  } catch (error) {
    try { rmSync(temp, { recursive: true, force: true }); } catch {}
    throw error;
  }
}

export function bootstrapReleaseState(root = DEFAULT_ROOT, releasePathOrId, options = {}) {
  root = resolve(root);
  if (readReleaseState(root, { required: false }) && !options.force) throw new Error('Release state already exists.');
  const releasePath = releasePathOrId && (String(releasePathOrId).includes('\\') || String(releasePathOrId).includes('/'))
    ? resolve(String(releasePathOrId))
    : join(releasesRoot(root), String(releasePathOrId || ''));
  const current = descriptorFromRelease(root, releasePath);
  return writeState(root, { generation: 1, current, previous: null, candidate: null });
}

export function stageWorkspaceRelease(root = DEFAULT_ROOT, options = {}) {
  root = resolve(root);
  const state = readReleaseState(root);
  const candidate = materializeWorkspaceRelease(root, { version: options.version, sourceHash: options.sourceHash });
  if (candidate.id === state.current.id) throw new Error('Candidate is identical to current release.');
  return writeState(root, { ...state, candidate: { ...candidate, verifiedAt: null, smokeReceipt: null } });
}

export function markCandidateVerified(root = DEFAULT_ROOT, releaseId, receipt) {
  root = resolve(root);
  const state = readReleaseState(root);
  if (!state.candidate || state.candidate.id !== releaseId) throw new Error(`Candidate ${releaseId} is not staged.`);
  if (!receipt) throw new Error('A smoke/verification receipt is required.');
  const candidate = { ...state.candidate, verifiedAt: nowIso(), smokeReceipt: resolve(String(receipt)) };
  return writeState(root, { ...state, candidate });
}

export function promoteCandidate(root = DEFAULT_ROOT, releaseId) {
  root = resolve(root);
  const state = readReleaseState(root);
  if (!state.candidate || state.candidate.id !== releaseId) throw new Error(`Candidate ${releaseId} is not staged.`);
  if (!state.candidate.verifiedAt || !state.candidate.smokeReceipt) throw new Error('Candidate has not passed the smoke/verification gate.');
  return writeState(root, {
    generation: state.generation + 1,
    current: { ...state.candidate, promotedAt: nowIso() },
    previous: state.current,
    candidate: null,
  });
}

export function rollbackRelease(root = DEFAULT_ROOT) {
  root = resolve(root);
  const state = readReleaseState(root);
  if (!state.previous) throw new Error('No previous immutable release is available for rollback.');
  return writeState(root, {
    generation: state.generation + 1,
    current: { ...state.previous, promotedAt: nowIso() },
    previous: state.current,
    candidate: null,
  });
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const value = argv[i];
    if (!value.startsWith('--')) { args._.push(value); continue; }
    const key = value.slice(2);
    const next = argv[i + 1];
    if (next != null && !next.startsWith('--')) { args[key] = next; i++; }
    else args[key] = true;
  }
  return args;
}

function print(value) { process.stdout.write(`${JSON.stringify(value, null, 2)}\n`); }

async function cli() {
  const args = parseArgs(process.argv.slice(2));
  const action = String(args._[0] || 'status');
  const root = resolve(String(args.root || DEFAULT_ROOT));
  if (action === 'status') return print(readReleaseState(root, { required: false }) ?? { schemaVersion: RELEASE_SCHEMA_VERSION, model: RELEASE_MODEL, initialized: false, statePath: releaseStatePath(root) });
  if (action === 'bootstrap') return print(bootstrapReleaseState(root, String(args.release || ''), { force: Boolean(args.force) }));
  if (action === 'materialize') return print(materializeWorkspaceRelease(root, { version: args.version, verifiedAt: args['verified-at'], verificationReceipt: args.receipt }));
  if (action === 'stage') return print(stageWorkspaceRelease(root, { version: args.version }));
  if (action === 'verify') return print(markCandidateVerified(root, String(args['release-id'] || ''), String(args.receipt || '')));
  if (action === 'promote') return print(promoteCandidate(root, String(args['release-id'] || '')));
  if (action === 'rollback') return print(rollbackRelease(root));
  throw new Error(`Unknown action: ${action}`);
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  cli().catch(error => { console.error(error?.stack || error?.message || String(error)); process.exitCode = 1; });
}

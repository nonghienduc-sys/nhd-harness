import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { VERSION } from "./version.js";

type DeploymentManifest = {
  sourceVersion?: string;
  sourceRoot?: string;
  candidateVersion?: string;
  rollbackVersion?: string;
  rollbackPath?: string;
  deploymentHash?: string;
  sourceHash?: string;
  deployedAt?: string;
};

type ReleaseDescriptor = {
  id?: string;
  version?: string;
  path?: string;
  deploymentHash?: string;
  sourceHash?: string | null;
  builtAt?: string | null;
  promotedAt?: string | null;
  verifiedAt?: string | null;
  smokeReceipt?: string | null;
  immutable?: boolean;
};

type ReleaseState = {
  schemaVersion?: number;
  model?: string;
  generation?: number;
  current?: ReleaseDescriptor | null;
  previous?: ReleaseDescriptor | null;
  candidate?: ReleaseDescriptor | null;
  updatedAt?: string;
};

type PackageJson = { version?: string };

function safeJson(path: string): Record<string, unknown> | null {
  try {
    const text = readFileSync(path, "utf8").replace(/^\uFEFF/, "");
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function listFiles(root: string, extension?: RegExp): string[] {
  if (!existsSync(root)) return [];
  const result: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = resolve(dir, name);
      let stat;
      try { stat = statSync(path); } catch { continue; }
      if (stat.isDirectory()) walk(path);
      else if (stat.isFile() && (!extension || extension.test(name))) result.push(path);
    }
  };
  walk(root);
  return result.sort((a, b) => a.localeCompare(b));
}

function treeHash(root: string, files: string[]): string | null {
  if (!files.length) return null;
  const hash = createHash("sha256");
  for (const path of files) {
    hash.update(relative(root, path).replace(/\\/g, "/"));
    hash.update("\u0000");
    try { hash.update(readFileSync(path)); } catch { return null; }
    hash.update("\u0000");
  }
  return hash.digest("hex");
}

function gitCommit(root: string): string | null {
  const gitDir = resolve(root, ".git");
  if (!existsSync(gitDir)) return null;
  try {
    const head = readFileSync(resolve(gitDir, "HEAD"), "utf8").trim();
    if (!head.startsWith("ref:")) return /^[0-9a-f]{40}$/i.test(head) ? head : null;
    const ref = head.slice(4).trim();
    const refPath = resolve(gitDir, ...ref.split("/"));
    if (existsSync(refPath)) {
      const value = readFileSync(refPath, "utf8").trim();
      return /^[0-9a-f]{40}$/i.test(value) ? value : null;
    }
    const packed = resolve(gitDir, "packed-refs");
    if (!existsSync(packed)) return null;
    for (const line of readFileSync(packed, "utf8").split(/\r?\n/)) {
      const [hash, name] = line.trim().split(/\s+/, 2);
      if (name === ref && /^[0-9a-f]{40}$/i.test(hash)) return hash;
    }
  } catch {}
  return null;
}

function releaseDescriptor(value: unknown): ReleaseDescriptor | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const id = String(row.id ?? "").trim();
  const version = String(row.version ?? "").trim();
  const path = String(row.path ?? "").trim();
  if (!id || !version || !path) return null;
  return {
    id,
    version,
    path: resolve(path),
    deploymentHash: row.deploymentHash == null ? undefined : String(row.deploymentHash),
    sourceHash: row.sourceHash == null ? null : String(row.sourceHash),
    builtAt: row.builtAt == null ? null : String(row.builtAt),
    promotedAt: row.promotedAt == null ? null : String(row.promotedAt),
    verifiedAt: row.verifiedAt == null ? null : String(row.verifiedAt),
    smokeReceipt: row.smokeReceipt == null ? null : String(row.smokeReceipt),
    immutable: row.immutable !== false,
  };
}

export class RuntimeIdentityService {
  private readonly runtimeRoot: string;
  private readonly sourceRoot: string;
  private readonly manifest: DeploymentManifest;
  private readonly runtimePackageVersion: string;
  private readonly sourceVersionValue: string;
  private sourceHashValue: string | null | undefined;
  private deploymentHashValue: string | null | undefined;
  private readonly gitCommitValue: string | null;
  private readonly runtimePathValue: string;
  private readonly releaseStatePathValue: string | null;
  private readonly activeReleaseIdValue: string | null;
  private readonly activeReleasePathValue: string | null;

  constructor(rootInput?: string) {
    const moduleDir = dirname(fileURLToPath(import.meta.url));
    this.runtimeRoot = resolve(rootInput ?? resolve(moduleDir, ".."));
    const packageJson = safeJson(resolve(this.runtimeRoot, "package.json")) as PackageJson | null;
    this.runtimePackageVersion = String(packageJson?.version ?? VERSION);
    this.manifest = (safeJson(resolve(this.runtimeRoot, "runtime", "deployment-manifest.json")) ?? {}) as DeploymentManifest;
    this.sourceRoot = resolve(process.env.NHD_SOURCE_ROOT?.trim() || this.manifest.sourceRoot || this.runtimeRoot);
    const sourcePackage = safeJson(resolve(this.sourceRoot, "package.json")) as PackageJson | null;
    this.sourceVersionValue = process.env.NHD_SOURCE_VERSION?.trim()
      || this.manifest.sourceVersion
      || String(sourcePackage?.version ?? this.runtimePackageVersion);
    this.runtimePathValue = resolve(process.argv[1] || fileURLToPath(import.meta.url));
    // Keep startup cheap: expensive tree hashing is lazy and cached on the first identity request.
    this.sourceHashValue = process.env.NHD_SOURCE_HASH?.trim() || this.manifest.sourceHash || undefined;
    this.deploymentHashValue = process.env.NHD_DEPLOYMENT_HASH?.trim() || this.manifest.deploymentHash || undefined;
    this.gitCommitValue = process.env.NHD_GIT_COMMIT?.trim() || gitCommit(this.sourceRoot);
    const configuredReleaseStatePath = process.env.NHD_RELEASE_STATE_PATH?.trim();
    const defaultReleaseStatePath = resolve(this.sourceRoot, "runtime", "release-state.json");
    this.releaseStatePathValue = configuredReleaseStatePath
      ? resolve(configuredReleaseStatePath)
      : (existsSync(defaultReleaseStatePath) ? defaultReleaseStatePath : null);
    this.activeReleaseIdValue = process.env.NHD_RELEASE_ID?.trim() || null;
    this.activeReleasePathValue = process.env.NHD_RELEASE_PATH?.trim() ? resolve(process.env.NHD_RELEASE_PATH.trim()) : null;
  }

  private sourceHash(): string | null {
    if (this.sourceHashValue === undefined) {
      const files = [
        ...listFiles(resolve(this.sourceRoot, "src"), /\.ts$/i),
        resolve(this.sourceRoot, "package.json"),
        resolve(this.sourceRoot, "tsconfig.json"),
      ].filter((path) => existsSync(path));
      this.sourceHashValue = treeHash(this.sourceRoot, files);
    }
    return this.sourceHashValue;
  }

  private deploymentHash(): string | null {
    if (this.deploymentHashValue === undefined) {
      const files = [
        ...listFiles(resolve(this.runtimeRoot, "dist"), /\.(?:js|json)$/i),
        resolve(this.runtimeRoot, "package.json"),
      ].filter((path) => existsSync(path));
      this.deploymentHashValue = treeHash(this.runtimeRoot, files);
    }
    return this.deploymentHashValue;
  }

  private releaseState(): ReleaseState | null {
    if (!this.releaseStatePathValue) return null;
    const raw = safeJson(this.releaseStatePathValue);
    if (!raw || raw.model !== "atomic-json-pointer-v1" || Number(raw.schemaVersion) !== 1) return null;
    return {
      schemaVersion: 1,
      model: "atomic-json-pointer-v1",
      generation: Math.max(1, Number(raw.generation ?? 1)),
      current: releaseDescriptor(raw.current),
      previous: releaseDescriptor(raw.previous),
      candidate: releaseDescriptor(raw.candidate),
      updatedAt: raw.updatedAt == null ? undefined : String(raw.updatedAt),
    };
  }

  identity() {
    const productionVersion = VERSION;
    const sourceVersion = this.sourceVersionValue;
    const releaseState = this.releaseState();
    const currentRelease = releaseState?.current ?? null;
    const previousRelease = releaseState?.previous ?? null;
    const stagedCandidate = releaseState?.candidate ?? null;
    const activeReleaseId = this.activeReleaseIdValue;
    const activeReleasePath = this.activeReleasePathValue ?? this.runtimeRoot;
    const activeRole = releaseState
      ? (activeReleaseId && currentRelease?.id === activeReleaseId ? "current"
        : activeReleaseId && stagedCandidate?.id === activeReleaseId ? "candidate"
        : activeReleaseId && previousRelease?.id === activeReleaseId ? "previous"
        : "untracked")
      : "legacy";
    const candidateVersion = releaseState
      ? stagedCandidate?.version ?? null
      : (process.env.NHD_CANDIDATE_VERSION?.trim() || this.manifest.candidateVersion || (this.runtimePackageVersion !== productionVersion ? this.runtimePackageVersion : null));
    const rollbackVersion = releaseState
      ? previousRelease?.version ?? (process.env.NHD_ROLLBACK_VERSION?.trim() || this.manifest.rollbackVersion || null)
      : (process.env.NHD_ROLLBACK_VERSION?.trim() || this.manifest.rollbackVersion || null);
    const rollbackPath = releaseState
      ? previousRelease?.path ?? (process.env.NHD_ROLLBACK_PATH?.trim() || this.manifest.rollbackPath || null)
      : (process.env.NHD_ROLLBACK_PATH?.trim() || this.manifest.rollbackPath || null);
    const sourceHash = this.sourceHash();
    const deploymentHash = this.deploymentHash();
    return {
      schemaVersion: releaseState ? 2 : 1,
      productionVersion,
      sourceVersion,
      candidateVersion,
      runtimePackageVersion: this.runtimePackageVersion,
      runtimePath: this.runtimePathValue,
      runtimeRoot: this.runtimeRoot,
      sourceRoot: this.sourceRoot,
      gitCommit: this.gitCommitValue,
      sourceHash,
      deploymentHash,
      rollbackVersion,
      rollbackPath,
      deployedAt: currentRelease?.promotedAt ?? this.manifest.deployedAt ?? null,
      release: releaseState ? {
        model: releaseState.model,
        statePath: this.releaseStatePathValue,
        generation: releaseState.generation,
        updatedAt: releaseState.updatedAt ?? null,
        active: {
          id: activeReleaseId,
          path: activeReleasePath,
          role: activeRole,
          immutable: activeRole !== "untracked",
        },
        current: currentRelease,
        previous: previousRelease,
        candidate: stagedCandidate,
        currentMatchesActive: Boolean(activeReleaseId && currentRelease?.id === activeReleaseId),
      } : {
        model: "legacy-mutable-dist",
        statePath: null,
        generation: null,
        active: { id: null, path: this.runtimeRoot, role: "legacy", immutable: false },
        current: null,
        previous: null,
        candidate: null,
        currentMatchesActive: null,
      },
      consistency: {
        sourceMatchesProduction: sourceVersion === productionVersion,
        runtimePackageMatchesProduction: this.runtimePackageVersion === productionVersion,
        candidateMatchesProduction: candidateVersion == null ? null : candidateVersion === productionVersion,
        currentReleaseMatchesProduction: currentRelease == null ? null : currentRelease.version === productionVersion,
        currentReleaseMatchesActive: releaseState == null ? null : Boolean(activeReleaseId && currentRelease?.id === activeReleaseId),
        deploymentHashAvailable: Boolean(deploymentHash),
        sourceHashAvailable: Boolean(sourceHash),
      },
      authority: {
        productionVersion: "live VERSION / release package.json / WORKSTATION_MCP_VERSION",
        sourceVersion: "NHD_SOURCE_VERSION or deployment manifest sourceVersion, otherwise sourceRoot/package.json",
        candidateVersion: releaseState ? "atomic release-state candidate" : "environment or runtime/deployment-manifest.json",
        sourceRoot: "NHD_SOURCE_ROOT or deployment manifest sourceRoot, otherwise runtime root",
        runtimeRelease: releaseState ? "NHD_RELEASE_STATE_PATH + NHD_RELEASE_ID/NHD_RELEASE_PATH" : "legacy mutable runtime root",
        hashes: "environment/manifest override, otherwise lazy cached deterministic source/deployment tree hash",
        rollbackVersion: releaseState ? "atomic release-state previous release" : "environment or runtime/deployment-manifest.json",
      },
    };
  }
}

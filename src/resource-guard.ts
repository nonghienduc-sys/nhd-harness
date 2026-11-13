import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import { existsSync, lstatSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, resolve, sep } from "node:path";

export type ExecutionLaneName = "background" | "isolated";
export type ResourceGuardMode = "read" | "write" | "exclusive";

/**
 * Explicit set of durable task states allowed to acquire, hold, renew, or upgrade
 * execution resource locks and lane reservations.
 * Tasks in planned, paused, completed, failed, cancelled, or expired states are rejected.
 */
export const ACTIVE_LOCK_TASK_STATES: ReadonlySet<string> = new Set([
  "running",
  "waiting_confirmation",
]);

export const EPHEMERAL_OWNER_PREFIX = "ephemeral:";

export function isEphemeralOwnerId(value: unknown): boolean {
  return typeof value === "string" && value.trim().startsWith(EPHEMERAL_OWNER_PREFIX);
}

export function createEphemeralOwnerId(scope: "pending" | "op" = "op", token?: string): string {
  const cleanToken = token?.trim() || randomBytes(12).toString("hex");
  return `${EPHEMERAL_OWNER_PREFIX}${scope}:${cleanToken}`;
}

export type TaskExecutionContext = {
  taskRunId?: string;
  ephemeralOwnerId?: string;
  lane?: ExecutionLaneName;
};

const taskContextStorage = new AsyncLocalStorage<TaskExecutionContext>();

let configuredRootsRegistry: string[] = [];

export function setConfiguredRoots(roots: readonly string[]): void {
  configuredRootsRegistry = roots
    .map((item) => String(item ?? "").trim())
    .filter(Boolean)
    .map((item) => resolve(item).replace(/[\\/]+$/, ""));
}

export function getConfiguredRoots(): readonly string[] {
  return configuredRootsRegistry;
}

export function runWithTaskContext<T>(context: TaskExecutionContext, fn: () => T): T {
  const prev = taskContextStorage.getStore();
  const merged: TaskExecutionContext = {
    taskRunId: context.taskRunId ?? prev?.taskRunId,
    ephemeralOwnerId: context.ephemeralOwnerId ?? prev?.ephemeralOwnerId,
    lane: context.lane ?? prev?.lane,
  };
  return taskContextStorage.run(merged, fn);
}

export function getCurrentTaskContext(): TaskExecutionContext | undefined {
  return taskContextStorage.getStore();
}

export function resolveTaskRunId(
  explicitTaskRunId?: unknown,
  payload?: Record<string, unknown> | null,
): string | undefined {
  if (typeof explicitTaskRunId === "string" && explicitTaskRunId.trim().length > 0) {
    return explicitTaskRunId.trim();
  }
  if (payload && typeof payload === "object") {
    if (typeof payload.taskRunId === "string" && payload.taskRunId.trim().length > 0) {
      return payload.taskRunId.trim();
    }
    if (typeof payload.task_run_id === "string" && payload.task_run_id.trim().length > 0) {
      return payload.task_run_id.trim();
    }
  }
  const ctx = taskContextStorage.getStore();
  if (ctx?.taskRunId && ctx.taskRunId.trim().length > 0) {
    return ctx.taskRunId.trim();
  }
  return undefined;
}

export function resolveEphemeralOwnerId(
  explicitEphemeralOwnerId?: unknown,
  payload?: Record<string, unknown> | null,
): string | undefined {
  if (typeof explicitEphemeralOwnerId === "string" && isEphemeralOwnerId(explicitEphemeralOwnerId)) {
    return explicitEphemeralOwnerId.trim();
  }
  if (payload && typeof payload === "object") {
    if (typeof payload.ephemeralOwnerId === "string" && isEphemeralOwnerId(payload.ephemeralOwnerId)) {
      return payload.ephemeralOwnerId.trim();
    }
  }
  const ctx = taskContextStorage.getStore();
  if (ctx?.ephemeralOwnerId && isEphemeralOwnerId(ctx.ephemeralOwnerId)) {
    return ctx.ephemeralOwnerId.trim();
  }
  return undefined;
}

function stripExtendedPathPrefix(winPath: string): string {
  return winPath.replace(/^\\\\\?\\/, "");
}

function toLowerForwardSlashKey(winPath: string): string {
  const clean = stripExtendedPathPrefix(winPath);
  if (!/^[A-Za-z]:[\\/]/.test(clean)) {
    throw new Error(`Resolved path is not a valid Windows drive path: ${winPath}`);
  }
  const drive = clean[0]!.toLowerCase();
  const rest = clean
    .slice(2)
    .replace(/\\/g, "/")
    .replace(/\/+/g, "/")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
  return rest ? `${drive}:/${rest.toLowerCase()}` : `${drive}:/`;
}

function normalizeRootForComparison(rootInput: string): string {
  const lexical = resolve(rootInput).replace(/[\\/]+$/, "");
  try {
    if (existsSync(lexical)) {
      return stripExtendedPathPrefix(realpathSync.native(lexical)).replace(/[\\/]+$/, "");
    }
  } catch {
    // Fall back to lexical root if realpath is unavailable.
  }
  return lexical;
}

export function isPathWithinRoots(targetWinPath: string, roots: readonly string[]): boolean {
  const cleanTarget = stripExtendedPathPrefix(resolve(targetWinPath)).replace(/[\\/]+$/, "").toLowerCase();
  for (const rawRoot of roots) {
    const lexicalRoot = resolve(rawRoot).replace(/[\\/]+$/, "").toLowerCase();
    const realRoot = normalizeRootForComparison(rawRoot).toLowerCase();
    if (
      cleanTarget === lexicalRoot ||
      cleanTarget.startsWith(`${lexicalRoot}${sep}`) ||
      cleanTarget === realRoot ||
      cleanTarget.startsWith(`${realRoot}${sep}`)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Walks existing prefixes of `lexicalWinPath` and verifies that any symlink, junction,
 * or reparse point resolves strictly inside the effective configured roots.
 * Throws fail-closed before any mutation if a reparse point escapes configured roots.
 */
export function assertSafeReparseChain(lexicalWinPath: string, allowedRoots?: readonly string[]): void {
  const effectiveRoots = allowedRoots && allowedRoots.length > 0 ? allowedRoots : configuredRootsRegistry;
  const parts = lexicalWinPath.split(/[\\/]+/).filter(Boolean);
  if (parts.length === 0) return;

  let current = `${parts[0]}\\`;
  for (let i = 1; i < parts.length; i++) {
    current = i === 1 ? `${parts[0]}\\${parts[1]}` : `${current}\\${parts[i]}`;
    let lst;
    try {
      lst = lstatSync(current, { throwIfNoEntry: false });
    } catch {
      lst = undefined;
    }
    if (!lst) continue;
    if (lst.isSymbolicLink()) {
      let resolvedTarget: string;
      try {
        resolvedTarget = stripExtendedPathPrefix(realpathSync.native(current));
      } catch {
        try {
          const rawLink = stripExtendedPathPrefix(readlinkSync(current));
          resolvedTarget = isAbsolute(rawLink) ? resolve(rawLink) : resolve(dirname(current), rawLink);
        } catch {
          throw new Error("Symbolic links and junction traversal outside configured roots are blocked.");
        }
      }
      if (effectiveRoots.length > 0 && !isPathWithinRoots(resolvedTarget, effectiveRoots)) {
        throw new Error("Symbolic links and junction traversal outside configured roots are blocked.");
      }
    }
  }
}

function parseLexicalWindowsPath(rawInput: string): { drive: string; stack: string[]; lexicalWinPath: string; lexicalKey: string } {
  let raw = String(rawInput ?? "").trim();
  if (!raw || raw.length > 5_000) {
    throw new Error("File resource path is empty or exceeds 5000 characters.");
  }
  raw = raw.replace(/^(?:file|doc|office|fs|path):/i, "").trim();
  if (!raw) {
    throw new Error("File resource path is empty.");
  }
  if (/[\x00-\x1f*?]/.test(raw)) {
    throw new Error("File resource path contains invalid control or wildcard characters.");
  }
  if (/%(?:2e|2f|5c)/i.test(raw)) {
    throw new Error("File resource path contains ambiguous URL-encoded traversal characters.");
  }
  if (raw.startsWith("\\\\") || raw.startsWith("//")) {
    throw new Error("UNC and device paths are not allowed as file resource keys.");
  }
  if (!/^[A-Za-z]:[\\/]/.test(raw)) {
    throw new Error(`File resource path must be an absolute Windows drive path: ${rawInput}`);
  }
  const drive = raw[0]!.toLowerCase();
  const afterDrive = raw.slice(2);
  if (afterDrive.includes(":")) {
    throw new Error("File resource path contains an invalid secondary colon or alternate data stream.");
  }

  const slashNormalized = afterDrive.replace(/\\/g, "/");
  const rawSegments = slashNormalized.split("/");
  const stack: string[] = [];

  for (const segment of rawSegments) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (stack.length === 0) {
        throw new Error(`File resource path traversal above drive root is forbidden: ${rawInput}`);
      }
      stack.pop();
      continue;
    }
    if (/[. ]$/.test(segment)) {
      throw new Error(`File resource path contains ambiguous trailing dot or space in segment '${segment}'.`);
    }
    stack.push(segment);
  }

  const lexicalWinPath = stack.length > 0
    ? `${drive.toUpperCase()}:\\${stack.join("\\")}`
    : `${drive.toUpperCase()}:\\`;
  const lexicalKey = stack.length > 0
    ? `${drive}:/${stack.map((s) => s.toLowerCase()).join("/")}`
    : `${drive}:/`;

  return { drive, stack, lexicalWinPath, lexicalKey };
}

export type FileResourceIdentity = {
  /** Primary canonical lock key (`file:id:<devHex>:<inoHex>` for existing files, or `file:<resolved-path>` for nonexistent targets). */
  key: string;
  /** Human-readable resolved canonical path (`file:<drive>:/...`). */
  canonicalPath: string;
  /** Physical volume/inode identifier (`vol:<devHex>:ino:<inoHex>` or `parent-vol:<devHex>:ino:<inoHex>/<rel>`) when available. */
  physicalId: string | null;
  /** All deterministic alias keys that must be checked for lock conflicts (bridges pre-creation path locks and post-creation physical ID locks). */
  aliasKeys: string[];
  /** Whether the target existed on disk when resolved. */
  targetExists: boolean;
  /** Whether a symlink/junction/reparse point was resolved along the path. */
  reparseResolved: boolean;
  /** Documented fallback reason when full file physical ID is not used. */
  fallbackReason: "none" | "resolved_parent_plus_basename" | "lexical_canonical_path" | "stat_inode_unavailable";
};

const physicalIdentityCache = new Map<string, { canonicalPath: string; physicalId: string; aliasKeys: Set<string> }>();

function recordPhysicalIdentityCache(key: string, canonicalPath: string, physicalId: string, aliases: Iterable<string>): string[] {
  let entry = physicalIdentityCache.get(key);
  if (!entry) {
    if (physicalIdentityCache.size >= 4096) {
      const oldestKey = physicalIdentityCache.keys().next().value;
      if (oldestKey) physicalIdentityCache.delete(oldestKey);
    }
    entry = { canonicalPath, physicalId, aliasKeys: new Set<string>() };
    physicalIdentityCache.set(key, entry);
  } else {
    entry.canonicalPath = canonicalPath;
    entry.physicalId = physicalId;
  }
  for (const alias of aliases) entry.aliasKeys.add(alias);
  return [...entry.aliasKeys];
}

/**
 * Computes the physical and canonical resource identity for a Windows file path.
 * - For existing files: converges hardlinks, junctions, symlinks, 8.3 names, case, and dot-segments
 *   onto a single physical volume+file-index key (`file:id:<devHex>:<inoHex>`), while retaining
 *   `canonicalPath` (`file:d:/...`) for diagnostics and pre-creation conflict bridging.
 * - For not-yet-existing targets: resolves the deepest existing parent/ancestor directory through
 *   `realpathSync.native` + `statSync(..., { bigint: true })` and combines it with the normalized
 *   relative child path so concurrent creations via junctions or aliases collide deterministically.
 */
export function describeFileResourceIdentity(rawInput: string, allowedRoots?: readonly string[]): FileResourceIdentity {
  const { stack, lexicalWinPath, lexicalKey } = parseLexicalWindowsPath(rawInput);
  assertSafeReparseChain(lexicalWinPath, allowedRoots);
  const effectiveRoots = allowedRoots && allowedRoots.length > 0 ? allowedRoots : configuredRootsRegistry;
  const lexicalWasInRoots = effectiveRoots.length > 0 && isPathWithinRoots(lexicalWinPath, effectiveRoots);

  const lexicalPathKey = `file:${lexicalKey}`;

  // 1. Target exists on disk
  if (existsSync(lexicalWinPath)) {
    let realWinPath = lexicalWinPath;
    try {
      realWinPath = stripExtendedPathPrefix(realpathSync.native(lexicalWinPath));
    } catch {
      realWinPath = lexicalWinPath;
    }
    if (lexicalWasInRoots && !isPathWithinRoots(realWinPath, effectiveRoots)) {
      throw new Error("Symbolic links and junction traversal outside configured roots are blocked.");
    }
    const resolvedKey = toLowerForwardSlashKey(realWinPath);
    const canonicalPath = `file:${resolvedKey}`;
    const reparseResolved = resolvedKey !== lexicalKey;

    try {
      const st = statSync(realWinPath, { bigint: true });
      if (st.dev > 0n && st.ino > 0n) {
        const devHex = st.dev.toString(16);
        const inoHex = st.ino.toString(16);
        const key = `file:id:${devHex}:${inoHex}`;
        const physicalId = `vol:${devHex}:ino:${inoHex}`;
        const aliasKeys = recordPhysicalIdentityCache(key, canonicalPath, physicalId, [key, canonicalPath, lexicalPathKey]);
        return {
          key,
          canonicalPath,
          physicalId,
          aliasKeys,
          targetExists: true,
          reparseResolved,
          fallbackReason: "none",
        };
      }
    } catch {
      // Safe fallback documented below if statSync bigint is unavailable.
    }

    const aliasSet = new Set<string>([canonicalPath, lexicalPathKey]);
    return {
      key: canonicalPath,
      canonicalPath,
      physicalId: null,
      aliasKeys: [...aliasSet],
      targetExists: true,
      reparseResolved,
      fallbackReason: "stat_inode_unavailable",
    };
  }

  // 2. Target does not exist yet: walk up to deepest existing ancestor directory
  if (stack.length > 0) {
    for (let splitIdx = stack.length - 1; splitIdx >= 1; splitIdx--) {
      const ancestorWinPath = `${lexicalWinPath.slice(0, 2)}\\${stack.slice(0, splitIdx).join("\\")}`;
      if (existsSync(ancestorWinPath)) {
        let realAncestor = ancestorWinPath;
        try {
          realAncestor = stripExtendedPathPrefix(realpathSync.native(ancestorWinPath));
        } catch {
          realAncestor = ancestorWinPath;
        }
        if (lexicalWasInRoots && !isPathWithinRoots(realAncestor, effectiveRoots)) {
          throw new Error("Symbolic links and junction traversal outside configured roots are blocked.");
        }
        const ancestorKey = toLowerForwardSlashKey(realAncestor).replace(/\/+$/, "");
        const relSuffix = stack
          .slice(splitIdx)
          .map((s) => s.toLowerCase())
          .join("/");
        const resolvedKey = `${ancestorKey}/${relSuffix}`;
        const canonicalPath = `file:${resolvedKey}`;
        const reparseResolved = resolvedKey !== lexicalKey;

        let physicalId: string | null = null;
        const aliasSet = new Set<string>([canonicalPath, lexicalPathKey]);
        try {
          const pst = statSync(realAncestor, { bigint: true });
          if (pst.dev > 0n && pst.ino > 0n) {
            const devHex = pst.dev.toString(16);
            const inoHex = pst.ino.toString(16);
            physicalId = `parent-vol:${devHex}:ino:${inoHex}/${relSuffix}`;
            aliasSet.add(`file:parent-id:${devHex}:${inoHex}/${relSuffix}`);
          }
        } catch {
          // Ignore parent stat failure; resolved parent path key is already deterministic.
        }

        return {
          key: canonicalPath,
          canonicalPath,
          physicalId,
          aliasKeys: [...aliasSet],
          targetExists: false,
          reparseResolved,
          fallbackReason: "resolved_parent_plus_basename",
        };
      }
    }
  }

  // 3. Neither target nor any subdirectory exists on disk (pure lexical canonical path fallback)
  return {
    key: lexicalPathKey,
    canonicalPath: lexicalPathKey,
    physicalId: null,
    aliasKeys: [lexicalPathKey],
    targetExists: false,
    reparseResolved: false,
    fallbackReason: "lexical_canonical_path",
  };
}

/**
 * Normalizes a Windows absolute path into a canonical lowercase forward-slash path key
 * without a `file:` prefix (e.g., `d:/project/report.docx`).
 * Resolves any in-root junctions/reparse points and rejects outside-root reparse escapes.
 */
export function normalizeWindowsPathKey(rawInput: string, allowedRoots?: readonly string[]): string {
  const identity = describeFileResourceIdentity(rawInput, allowedRoots);
  return identity.canonicalPath.replace(/^file:/, "");
}

/**
 * Canonicalizes a filesystem, Semantic Document, or Office file path into its authoritative
 * lock key (`file:id:<devHex>:<inoHex>` when existing on disk, or `file:<resolved-parent>/<name>`
 * when not yet existing). Ensures hardlinks, junctions, and cross-tool routes share one key.
 */
export function canonicalizeFilePathResource(rawInput: string, allowedRoots?: readonly string[]): string {
  return describeFileResourceIdentity(rawInput, allowedRoots).key;
}

/**
 * Canonicalizes a project-scoped mutable resource key:
 * `project:<canonical-root>:<normalized-scope>`.
 */
export function canonicalizeProjectResource(projectRootInput: string, scopeInput = "state"): string {
  const rootKey = normalizeWindowsPathKey(projectRootInput);
  const scope = String(scopeInput ?? "state")
    .trim()
    .toLowerCase()
    .replace(/\\/g, "/")
    .replace(/\s+/g, "_");
  if (!scope || scope.includes("..") || /[\x00-\x1f*?]/.test(scope)) {
    throw new Error(`Invalid project resource scope: ${scopeInput}`);
  }
  return `project:${rootKey}:${scope}`;
}

/**
 * Canonicalizes a browser tab or target resource key:
 * - Cốc Cốc tab: `browser:coccoc:tab:<tabId>`
 * - Dedicated browser target: `browser:dedicated:target:<targetId>`
 * - Isolated browser target: `browser:isolated:target:<targetId>`
 */
export function canonicalizeBrowserResource(
  provider: "coccoc" | "dedicated" | "isolated",
  targetId: string | number,
): string {
  if (provider === "coccoc") {
    const raw = String(targetId ?? "").trim().toLowerCase();
    if (raw === "active" || raw === "new") return `browser:coccoc:tab:${raw}`;
    const num = Number(targetId);
    if (!Number.isInteger(num) || num < 0) {
      throw new Error(`Invalid Cốc Cốc tab resource id: ${String(targetId)}`);
    }
    return `browser:coccoc:tab:${num}`;
  }
  const cleanTarget = String(targetId ?? "active")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._:-]/g, "");
  if (!cleanTarget) {
    throw new Error(`Invalid ${provider} browser target id.`);
  }
  return `browser:${provider}:target:${cleanTarget}`;
}

function looksLikePathPayload(value: string): boolean {
  if (/^[A-Za-z]:/.test(value)) return true;
  if (value.includes("/") || value.includes("\\") || value.includes("..")) return true;
  if (/\.(?:docx|doc|xlsx|xlsm|xls|pptx|ppt|pdf|txt|md|json|csv|html|xml|sqlite|ps1|mjs|js|ts)$/i.test(value)) return true;
  return false;
}

export type ResourceIdentityDescriptor = {
  key: string;
  canonicalPath: string;
  physicalId: string | null;
  aliasKeys: string[];
};

export function describeResourceIdentity(resourceInput: string, allowedRoots?: readonly string[]): ResourceIdentityDescriptor {
  const raw = String(resourceInput ?? "").trim();
  if (!raw || raw.length > 5_000) {
    throw new Error("resource is empty or exceeds 5000 characters.");
  }
  if (/[\x00-\x1f]/.test(raw)) {
    throw new Error("resource contains invalid control characters.");
  }

  // Already a resolved physical file ID key (`file:id:<dev>:<ino>`)
  if (/^file:id:[0-9a-f]+:[0-9a-f]+$/i.test(raw)) {
    const lower = raw.toLowerCase();
    const cached = physicalIdentityCache.get(lower);
    if (cached) {
      return {
        key: lower,
        canonicalPath: cached.canonicalPath,
        physicalId: cached.physicalId,
        aliasKeys: [...cached.aliasKeys],
      };
    }
    const parts = lower.split(":");
    return {
      key: lower,
      canonicalPath: lower,
      physicalId: `vol:${parts[2]}:ino:${parts[3]}`,
      aliasKeys: [lower],
    };
  }

  if (/^[A-Za-z]:[\\/]/.test(raw) || /^(?:file|fs|path):/i.test(raw)) {
    const fileId = describeFileResourceIdentity(raw, allowedRoots);
    return {
      key: fileId.key,
      canonicalPath: fileId.canonicalPath,
      physicalId: fileId.physicalId,
      aliasKeys: fileId.aliasKeys,
    };
  }

  const docOrOfficeMatch = raw.match(/^(doc|office):(.*)$/i);
  if (docOrOfficeMatch) {
    const prefix = docOrOfficeMatch[1]!.toLowerCase();
    const rest = docOrOfficeMatch[2]!.trim();
    if (!rest) throw new Error(`${prefix} resource identifier is empty.`);
    if (looksLikePathPayload(rest)) {
      const fileId = describeFileResourceIdentity(rest, allowedRoots);
      return {
        key: fileId.key,
        canonicalPath: fileId.canonicalPath,
        physicalId: fileId.physicalId,
        aliasKeys: fileId.aliasKeys,
      };
    }
    const cleanRest = rest.toLowerCase().replace(/\s+/g, "_");
    if (cleanRest.includes("..")) throw new Error("Resource identifier cannot contain '..'.");
    const key = `${prefix}:${cleanRest}`;
    return { key, canonicalPath: key, physicalId: null, aliasKeys: [key] };
  }

  if (/^project:/i.test(raw)) {
    const rest = raw.slice("project:".length).trim();
    const winProjectMatch = rest.match(/^([A-Za-z]:[\\/][^:]*)(?::(.+))?$/);
    if (winProjectMatch) {
      const rootPart = winProjectMatch[1]!;
      const scopePart = winProjectMatch[2]?.trim() || "state";
      const key = canonicalizeProjectResource(rootPart, scopePart);
      return { key, canonicalPath: key, physicalId: null, aliasKeys: [key] };
    }
    if (rest.includes("/") || rest.includes("\\") || rest.includes("..")) {
      throw new Error(`Project path resource must use an absolute Windows drive path: ${raw}`);
    }
    const key = `project:${rest.toLowerCase()}`;
    return { key, canonicalPath: key, physicalId: null, aliasKeys: [key] };
  }

  const tabShortMatch = raw.match(/^(?:tab|coccoc:tab|browser:coccoc:tab|browser:coccoc):(.+)$/i);
  if (tabShortMatch) {
    const key = canonicalizeBrowserResource("coccoc", tabShortMatch[1]!.trim());
    return { key, canonicalPath: key, physicalId: null, aliasKeys: [key] };
  }
  const dedicatedShortMatch = raw.match(/^browser:(dedicated|isolated)(?::target)?:(.+)$/i);
  if (dedicatedShortMatch) {
    const provider = dedicatedShortMatch[1]!.toLowerCase() as "dedicated" | "isolated";
    const key = canonicalizeBrowserResource(provider, dedicatedShortMatch[2]!.trim());
    return { key, canonicalPath: key, physicalId: null, aliasKeys: [key] };
  }
  if (/^browser:cdp:target:(.+)$/i.test(raw)) {
    const target = raw.replace(/^browser:cdp:target:/i, "").trim();
    const key = canonicalizeBrowserResource("dedicated", target);
    return { key, canonicalPath: key, physicalId: null, aliasKeys: [key] };
  }

  const colonIndex = raw.indexOf(":");
  if (colonIndex <= 0 || colonIndex === raw.length - 1) {
    throw new Error(`Resource '${raw}' must include a canonical namespace prefix (e.g. file:, project:, browser:).`);
  }
  const namespace = raw.slice(0, colonIndex).trim().toLowerCase();
  const identifier = raw.slice(colonIndex + 1).trim();
  if (identifier.includes("..") || identifier.includes("\\") || /%(?:2e|2f|5c)/i.test(identifier)) {
    throw new Error(`Resource '${raw}' contains ambiguous path or traversal segments.`);
  }
  const key = `${namespace}:${identifier.toLowerCase().replace(/\/+/g, "/")}`;
  return { key, canonicalPath: key, physicalId: null, aliasKeys: [key] };
}

/**
 * Master resource identity canonicalizer.
 * Maps all aliases of the same physical file, project section, or browser target
 * to a single deterministic resource key before lock lookup or storage.
 */
export function canonicalizeResourceKey(resourceInput: string, allowedRoots?: readonly string[]): string {
  return describeResourceIdentity(resourceInput, allowedRoots).key;
}

/**
 * Canonicalizes, deduplicates, and sorts a list of resource keys in deterministic
 * lexicographical order so multi-resource lock acquisition can never deadlock.
 */
export function canonicalizeResourceList(resources: readonly string[], allowedRoots?: readonly string[]): string[] {
  const unique = new Set<string>();
  for (const item of resources) {
    unique.add(canonicalizeResourceKey(item, allowedRoots));
  }
  return [...unique].sort();
}

/**
 * Given a canonical resource key or canonicalPath, returns any broader parent resource keys
 * that should also be checked for foreign write/exclusive locks.
 */
export function parentConflictResourceKeys(canonicalKey: string): string[] {
  const parents: string[] = [];
  const projectMatch = canonicalKey.match(/^(project:[a-z]:\/[^:]+):(.+)$/);
  if (projectMatch) {
    const base = projectMatch[1]!;
    const scope = projectMatch[2]!;
    if (scope !== "state") parents.push(`${base}:state`);
    if (scope.startsWith("memory:") && scope !== "memory") {
      parents.push(`${base}:memory`);
    }
  }
  if (canonicalKey.startsWith("browser:dedicated:target:") && canonicalKey !== "browser:dedicated:target:active") {
    parents.push("browser:dedicated:target:active");
  }
  return parents;
}

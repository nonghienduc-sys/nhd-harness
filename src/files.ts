import { createReadStream, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync, copyFileSync, watch, type FSWatcher } from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import JSZip from "jszip";
import ExcelJS from "exceljs";
import mammoth from "mammoth";
import { AppConfig } from "./config.js";
import { Store } from "./db.js";
import {
  assertSafeReparseChain,
  canonicalizeFilePathResource,
  createEphemeralOwnerId,
  isPathWithinRoots,
  resolveTaskRunId,
  setConfiguredRoots,
} from "./resource-guard.js";
import { assertNoIntroducedRedaction, nowIso, redact, redactWithFlag, sha256 } from "./security.js";

const SECRET_NAME = /(^|[._-])(env|ssh|credential|credentials|secret|secrets|password|passwd|token|apikey|api-key|cookie|cookies)([._-]|$)/i;
const EXCLUDED_DIR = /(^|\\|\/)(\$RECYCLE\.BIN|System Volume Information|node_modules|\.git|AppData-Moved|WebView2|browser|cache)(\\|\/|$)/i;
const TEXT_EXT = new Set([".txt", ".md", ".json", ".toml", ".yaml", ".yml", ".xml", ".html", ".css", ".js", ".jsx", ".ts", ".tsx", ".py", ".ps1", ".psm1", ".cs", ".java", ".go", ".rs", ".sql", ".csv"]);
const OFFICE_TEMP_NAME = /^~\$/;

// v0.24.9: vùng phát hành chỉ do atomic release controller ghi; fs tools không bao giờ được ghi/chuyển/xóa vào đây.
const RELEASE_SOURCE_ROOT = resolve(process.env.NHD_SOURCE_ROOT || "D:\\ChatGPT-Workstation-MCP");
export function isReleaseProtectedPath(target: string, sourceRoot: string = RELEASE_SOURCE_ROOT): boolean {
  const norm = (value: string) => resolve(value).replace(/[\\/]+$/, "").toLowerCase();
  const candidate = norm(target);
  const base = norm(sourceRoot);
  const dirs = [join(base, "releases"), join(base, "deploy-backups")].map(norm);
  const files = [norm(join(base, "runtime", "release-state.json"))];
  if (process.env.NHD_RELEASE_STATE_PATH) files.push(norm(process.env.NHD_RELEASE_STATE_PATH));
  if (files.includes(candidate)) return true;
  return dirs.some((dir) => candidate === dir || candidate.startsWith(dir + sep));
}
// v0.24.9: roots có thể mở toàn máy; dataDir của Harness (config, CSDL, backup) và thư mục hệ thống luôn chỉ-đọc với fs tools.
const HARNESS_DATA_DIR = resolve(process.env.WORKSTATION_MCP_DATA_DIR || "C:\\ProgramData\\ChatGPTWorkstationBridge");
const SYSTEM_DIR = resolve(process.env.SystemRoot || "C:\\Windows");
export function isSystemProtectedPath(target: string, dataDir: string = HARNESS_DATA_DIR, systemDir: string = SYSTEM_DIR): boolean {
  const norm = (value: string) => resolve(value).replace(/[\\/]+$/, "").toLowerCase();
  const candidate = norm(target);
  return [dataDir, systemDir].map(norm).some((dir) => candidate === dir || candidate.startsWith(dir + sep));
}
function assertNotReleaseProtected(target: string): void {
  if (isSystemProtectedPath(target)) throw new Error("SYSTEM_PROTECTED_PATH: the Harness data directory and the Windows system directory are read-only for filesystem tools.");
  if (isReleaseProtectedPath(target)) throw new Error("RELEASE_PROTECTED_PATH: releases/, deploy-backups/ and runtime/release-state.json are managed only by the atomic release controller.");
}
const OFFICE_ARCHIVE_EXT = new Set([".docx", ".xlsx", ".xlsm", ".pptx"]);
const TRANSIENT_OFFICE_ARCHIVE_ERROR = /central directory|not a zip|invalid zip|unexpected end|end of data|corrupt|truncated/i;

export type IncrementalIndexStatus = {
  watching: boolean;
  roots: { root: string; mode: "recursive" | "root-only" }[];
  pending: number;
  events: number;
  refreshed: number;
  removed: number;
  errors: number;
  transientRetries: number;
  transientRecoveries: number;
  ignoredTempFiles: number;
  startedAt: string | null;
  lastEventAt: string | null;
  lastError: string | null;
};

export class FileService {
  private indexing = false;
  private readonly watchers = new Map<string, FSWatcher>();
  private readonly watchModes = new Map<string, "recursive" | "root-only">();
  private readonly watchTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly watchTransientPaths = new Set<string>();
  private watchEvents = 0;
  private watchRefreshed = 0;
  private watchRemoved = 0;
  private watchErrors = 0;
  private watchTransientRetries = 0;
  private watchTransientRecoveries = 0;
  private watchIgnoredTempFiles = 0;
  private watchStartedAt: string | null = null;
  private watchLastEventAt: string | null = null;
  private watchLastError: string | null = null;

  constructor(readonly config: AppConfig, readonly store: Store) {
    setConfiguredRoots(this.config.roots);
  }

  resolvePath(input: string): string {
    const candidate = resolve(isAbsolute(input) ? input : resolve(this.config.roots[0], input));
    if (!isPathWithinRoots(candidate, this.config.roots)) {
      throw new Error("Path is outside configured roots.");
    }
    assertSafeReparseChain(candidate, this.config.roots);
    if (existsSync(candidate)) {
      let realCandidate = candidate;
      try {
        realCandidate = realpathSync.native(candidate).replace(/^\\\\\?\\/, "");
      } catch {
        throw new Error("Symbolic links and junction traversal outside configured roots are blocked.");
      }
      if (!isPathWithinRoots(realCandidate, this.config.roots)) {
        throw new Error("Symbolic links and junction traversal outside configured roots are blocked.");
      }
      if (SECRET_NAME.test(basename(realCandidate)) || EXCLUDED_DIR.test(realCandidate)) {
        throw new Error("Sensitive or excluded path is blocked.");
      }
    }
    if (SECRET_NAME.test(basename(candidate)) || EXCLUDED_DIR.test(candidate)) throw new Error("Sensitive or excluded path is blocked.");
    return candidate;
  }

  list(path: string, limit = 500) {
    const target = this.resolvePath(path);
    return readdirSync(target, { withFileTypes: true }).filter((entry) => !entry.isSymbolicLink()).slice(0, limit).map((entry) => {
      const full = resolve(target, entry.name);
      const stat = statSync(full);
      return { name: entry.name, path: full, type: entry.isDirectory() ? "directory" : "file", size: stat.size, modifiedAt: stat.mtime.toISOString() };
    });
  }

  stat(path: string) {
    const target = this.resolvePath(path);
    const stat = statSync(target);
    return { path: target, exists: true, type: stat.isDirectory() ? "directory" : "file", size: stat.size, modifiedAt: stat.mtime.toISOString(), hash: stat.isFile() ? this.hashFile(target) : null };
  }

  read(path: string, startLine = 1, endLine = 400, maxChars = 100_000) {
    const target = this.resolvePath(path);
    const stat = statSync(target);
    if (!stat.isFile()) throw new Error("Path is not a file.");
    if (stat.size > 10 * 1024 * 1024) throw new Error("File is too large for direct text read.");
    return this.readWithMeta(path, startLine, endLine, maxChars).text;
  }

  /** v0.24.14: same bounded read, plus whether secrets were masked in the returned range. */
  readWithMeta(path: string, startLine = 1, endLine = 400, maxChars = 100_000) {
    const target = this.resolvePath(path);
    const stat = statSync(target);
    if (!stat.isFile()) throw new Error("Path is not a file.");
    if (stat.size > 10 * 1024 * 1024) throw new Error("File is too large for direct text read.");
    const raw = readFileSync(target, "utf8").split(/\r?\n/).slice(startLine - 1, endLine).join("\n");
    const masked = redactWithFlag(raw);
    return { text: masked.text.slice(0, maxChars), redacted: masked.redacted, redactedCount: masked.redactedCount };
  }

  private originalTextForRedactionCheck(path: string): string {
    try {
      if (!existsSync(path)) return "";
      const stat = statSync(path);
      if (!stat.isFile() || stat.size > 10 * 1024 * 1024) return "";
      return readFileSync(path, "utf8");
    } catch { return ""; }
  }

  hashFile(path: string): string {
    const hash = createHash("sha256");
    const buffer = readFileSync(path);
    hash.update(buffer);
    return hash.digest("hex");
  }

  preview(kind: "write" | "move" | "delete", payload: Record<string, unknown>, taskRunId?: string) {
    if (this.config.emergencyStop || !this.config.writeEnabled) throw new Error("File writes are disabled.");
    const path = this.resolvePath(String(payload.path));
    assertNotReleaseProtected(path);
    if (kind === "write") assertNoIntroducedRedaction(String(payload.content ?? ""), this.originalTextForRedactionCheck(path), "fs_preview_write");
    const expectedHash = existsSync(path) && statSync(path).isFile() ? this.hashFile(path) : null;
    const effectiveTaskRunId = resolveTaskRunId(taskRunId, payload);
    const actionId = this.store.allocatePendingId();
    const ephemeralOwnerId = effectiveTaskRunId ? undefined : createEphemeralOwnerId("pending", actionId);
    const normalized: Record<string, unknown> = {
      ...payload,
      path,
      ...(effectiveTaskRunId ? { taskRunId: effectiveTaskRunId } : {}),
      ...(ephemeralOwnerId ? { ephemeralOwnerId } : {}),
    };
    const resources = [canonicalizeFilePathResource(path, this.config.roots)];
    if (kind === "move") {
      const dest = this.resolvePath(String(payload.destination));
      assertNotReleaseProtected(dest);
      normalized.destination = dest;
      resources.push(canonicalizeFilePathResource(dest, this.config.roots));
    }
    this.store.guardResources(resources, {
      mode: "write",
      taskRunId: effectiveTaskRunId,
      ephemeralOwnerId,
      ttlSeconds: 300,
      operation: `fs_preview_${kind}`,
    });
    const pending = this.store.createPending(`fs:${kind}`, normalized, expectedHash, 300, actionId);
    this.store.audit(`fs_preview_${kind}`, "pending", { path, actionId: pending.id, taskRunId: effectiveTaskRunId ?? ephemeralOwnerId ?? null });
    return { actionId: pending.id, confirmationToken: pending.confirmationToken, expiresAt: pending.expiresAt, expectedHash, preview: this.describe(kind, normalized) };
  }

  apply(actionId: string, confirmationToken: string, expectedKind?: "write" | "move" | "delete", taskRunId?: string) {
    if (this.config.emergencyStop || !this.config.writeEnabled) throw new Error("File writes are disabled.");
    const previewPending = this.store.getPending(actionId, confirmationToken);
    if (!previewPending.kind.startsWith("fs:")) throw new Error("Pending action is not a filesystem action.");
    const previewKind = previewPending.kind.slice(3) as "write" | "move" | "delete";
    if (expectedKind && previewKind !== expectedKind) throw new Error(`Pending action is ${previewKind}, not ${expectedKind}.`);
    const previewPath = this.resolvePath(String(previewPending.payload.path));
    const previewDest = previewKind === "move" ? this.resolvePath(String(previewPending.payload.destination)) : null;
    assertNotReleaseProtected(previewPath);
    if (previewDest) assertNotReleaseProtected(previewDest);
    const recordedTaskRunId = typeof previewPending.payload.taskRunId === "string" ? previewPending.payload.taskRunId.trim() : undefined;
    const recordedEphemeralOwnerId = typeof previewPending.payload.ephemeralOwnerId === "string" ? previewPending.payload.ephemeralOwnerId.trim() : undefined;
    const explicitTaskRunId = resolveTaskRunId(taskRunId);
    if (explicitTaskRunId && recordedTaskRunId && explicitTaskRunId !== recordedTaskRunId) {
      throw new Error(`Foreign pending file action denied: action belongs to task '${recordedTaskRunId}', not '${explicitTaskRunId}'.`);
    }
    if (explicitTaskRunId && !recordedTaskRunId && recordedEphemeralOwnerId) {
      throw new Error(`Foreign pending file action denied: anonymous preview cannot be applied by task '${explicitTaskRunId}'.`);
    }
    const effectiveTaskRunId = explicitTaskRunId ?? recordedTaskRunId;
    const resources = previewDest
      ? [canonicalizeFilePathResource(previewPath, this.config.roots), canonicalizeFilePathResource(previewDest, this.config.roots)]
      : [canonicalizeFilePathResource(previewPath, this.config.roots)];
    this.store.guardResources(resources, {
      mode: "write",
      taskRunId: effectiveTaskRunId,
      ephemeralOwnerId: recordedEphemeralOwnerId,
      operation: `fs_apply_${previewKind}`,
    });

    try {
      const pending = this.store.consumePending(actionId, confirmationToken);
      const kind = pending.kind.slice(3) as "write" | "move" | "delete";
      const path = previewPath;
      if (pending.expectedHash && (!existsSync(path) || this.hashFile(path) !== pending.expectedHash)) throw new Error("File changed after preview.");
      const backup = existsSync(path) && statSync(path).isFile() ? this.backup(path) : null;
      let destination: string | null = null;
      if (kind === "write") {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, String(pending.payload.content ?? ""), "utf8");
        if (effectiveTaskRunId) {
          this.store.guardResources([canonicalizeFilePathResource(path, this.config.roots)], {
            mode: "write",
            taskRunId: effectiveTaskRunId,
            operation: "fs_apply_write_post_create",
          });
        }
      } else if (kind === "move") {
        destination = previewDest!;
        mkdirSync(dirname(destination), { recursive: true });
        renameSync(path, destination);
        if (effectiveTaskRunId) {
          this.store.guardResources([canonicalizeFilePathResource(destination, this.config.roots)], {
            mode: "write",
            taskRunId: effectiveTaskRunId,
            operation: "fs_apply_move_post_create",
          });
        }
      } else {
        if (!statSync(path).isFile()) throw new Error("Only regular files can be deleted.");
        rmSync(path);
      }
      this.store.audit(`fs_apply_${kind}`, "success", { path, actionId, backup, taskRunId: effectiveTaskRunId ?? recordedEphemeralOwnerId ?? null });
      return { applied: true, kind, path, destination, backup, at: nowIso() };
    } finally {
      if (recordedEphemeralOwnerId) {
        this.store.releaseEphemeralOwnerResources(recordedEphemeralOwnerId, `fs_apply_${previewKind}_completed`);
      }
    }
  }

  private backup(path: string): string {
    const name = `${Date.now()}-${sha256(path).slice(0, 12)}-${basename(path)}`;
    const destination = resolve(this.config.backupDir, name);
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(path, destination);
    return destination;
  }

  private describe(kind: string, payload: Record<string, unknown>): string {
    if (kind === "write") return `Write ${String(payload.content ?? "").length} characters to ${payload.path}`;
    if (kind === "move") return `Move ${payload.path} to ${payload.destination}`;
    return `Delete regular file ${payload.path}`;
  }

  watchStatus(): IncrementalIndexStatus {
    return {
      watching: this.watchers.size > 0,
      roots: [...this.watchers.keys()].map((root) => ({ root, mode: this.watchModes.get(root) ?? "root-only" })),
      pending: this.watchTimers.size,
      events: this.watchEvents,
      refreshed: this.watchRefreshed,
      removed: this.watchRemoved,
      errors: this.watchErrors,
      transientRetries: this.watchTransientRetries,
      transientRecoveries: this.watchTransientRecoveries,
      ignoredTempFiles: this.watchIgnoredTempFiles,
      startedAt: this.watchStartedAt,
      lastEventAt: this.watchLastEventAt,
      lastError: this.watchLastError,
    };
  }

  startWatch(rootInput = this.config.projectWorkspaceRoot): IncrementalIndexStatus {
    const root = this.resolvePath(rootInput);
    if (!existsSync(root) || !statSync(root).isDirectory()) throw new Error("Incremental index watch root must be an existing directory.");
    if (this.watchers.has(root)) return this.watchStatus();
    const onEvent = (_eventType: string, filename: string | Buffer | null) => {
      if (!filename) return;
      const relativeName = typeof filename === "string" ? filename : filename.toString();
      const full = resolve(root, relativeName);
      // SQLite/WAL churn is internal state, never supported searchable content.
      if (/\.(?:sqlite|sqlite3|db)(?:-wal|-shm|-journal)?$/i.test(full)) return;
      if (OFFICE_TEMP_NAME.test(basename(full))) { this.watchIgnoredTempFiles += 1; return; }
      if (SECRET_NAME.test(basename(full)) || EXCLUDED_DIR.test(full)) return;
      let safe: string;
      try { safe = this.resolvePath(full); } catch { return; }
      this.watchEvents += 1;
      this.watchLastEventAt = nowIso();
      const existing = this.watchTimers.get(safe);
      if (existing) clearTimeout(existing);
      const timer = setTimeout(() => {
        this.watchTimers.delete(safe);
        void this.refreshWatchedPath(safe).catch((error) => this.recordWatchError(error));
      }, 350);
      this.watchTimers.set(safe, timer);
    };
    let watcher: FSWatcher;
    let mode: "recursive" | "root-only" = "recursive";
    try { watcher = watch(root, { recursive: true }, onEvent); }
    catch { mode = "root-only"; watcher = watch(root, { recursive: false }, onEvent); }
    watcher.on("error", (error) => this.recordWatchError(error));
    this.watchers.set(root, watcher);
    this.watchModes.set(root, mode);
    this.watchStartedAt = this.watchStartedAt ?? nowIso();
    this.store.audit("index_watch_start", "success", { root, mode });
    return this.watchStatus();
  }

  stopWatch(rootInput?: string): IncrementalIndexStatus {
    const roots = rootInput ? [this.resolvePath(rootInput)] : [...this.watchers.keys()];
    for (const root of roots) {
      this.watchers.get(root)?.close();
      this.watchers.delete(root);
      this.watchModes.delete(root);
      for (const [path, timer] of [...this.watchTimers.entries()]) {
        const rel = relative(root, path);
        if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) { clearTimeout(timer); this.watchTimers.delete(path); }
      }
      this.store.audit("index_watch_stop", "success", { root });
    }
    if (this.watchers.size === 0) this.watchStartedAt = null;
    return this.watchStatus();
  }

  async refreshIndexPath(pathInput: string) {
    const path = this.resolvePath(pathInput);
    if (!existsSync(path)) {
      const removed = this.store.indexDelete(path);
      if (removed) this.watchRemoved += 1;
      return { path, status: removed ? "removed" : "absent" as const, indexed: false, removed };
    }
    const stat = statSync(path);
    if (!stat.isFile()) return { path, status: "ignored" as const, indexed: false, removed: false };
    if (stat.size > 15 * 1024 * 1024) {
      const removed = this.store.indexDelete(path);
      if (removed) this.watchRemoved += 1;
      return { path, status: "too_large" as const, indexed: false, removed };
    }
    const previous = this.store.indexMetadata(path);
    if (previous && previous.size === stat.size && Math.abs(previous.mtimeMs - stat.mtimeMs) < 0.5) {
      return { path, status: "unchanged" as const, indexed: true, removed: false, kind: previous.kind };
    }
    const extracted = await this.extract(path);
    if (!extracted.content.trim()) {
      const removed = this.store.indexDelete(path);
      if (removed) this.watchRemoved += 1;
      return { path, status: "unsupported" as const, indexed: false, removed, kind: extracted.kind };
    }
    this.store.indexReplace(path, extracted.kind, redact(extracted.content).slice(0, 500_000), stat.size, stat.mtimeMs);
    this.watchRefreshed += 1;
    return { path, status: "indexed" as const, indexed: true, removed: false, kind: extracted.kind, size: stat.size, modifiedAt: stat.mtime.toISOString() };
  }

  private isTransientOfficeArchiveError(path: string, error: unknown): boolean {
    if (!OFFICE_ARCHIVE_EXT.has(extname(path).toLowerCase())) return false;
    const message = error instanceof Error ? error.message : String(error);
    return TRANSIENT_OFFICE_ARCHIVE_ERROR.test(message);
  }

  private async refreshWatchedPath(path: string, attempt = 0): Promise<void> {
    try {
      await this.refreshIndexPath(path);
      const recoveredTransient = this.watchTransientPaths.delete(path);
      if (attempt > 0 || recoveredTransient) this.watchTransientRecoveries += 1;
    } catch (error) {
      if (attempt < 3 && this.isTransientOfficeArchiveError(path, error)) {
        this.watchTransientRetries += 1;
        this.watchTransientPaths.add(path);
        const previous = this.watchTimers.get(path);
        if (previous) clearTimeout(previous);
        const delay = Math.min(2_000, 400 * (2 ** attempt));
        const timer = setTimeout(() => {
          this.watchTimers.delete(path);
          void this.refreshWatchedPath(path, attempt + 1).catch((retryError) => this.recordWatchError(retryError));
        }, delay);
        this.watchTimers.set(path, timer);
        return;
      }
      this.watchTransientPaths.delete(path);
      throw error;
    }
  }
  private recordWatchError(error: unknown) {
    this.watchErrors += 1;
    this.watchLastError = error instanceof Error ? error.message : String(error);
    this.store.audit("index_watch", "error", { error: this.watchLastError });
  }

  async index(rootInput = this.config.roots[0], maxFiles = 20_000) {
    if (this.indexing) throw new Error("A file indexing job is already running.");
    this.indexing = true;
    try {
      const root = this.resolvePath(rootInput);
      const queue = [root];
      let scanned = 0;
      let indexed = 0;
      let skipped = 0;
      while (queue.length && scanned < maxFiles) {
        const dir = queue.shift()!;
        let entries;
        try { entries = readdirSync(dir, { withFileTypes: true }); } catch { skipped++; continue; }
        for (const entry of entries) {
          if (scanned >= maxFiles) break;
          const full = resolve(dir, entry.name);
          if (OFFICE_TEMP_NAME.test(entry.name) || SECRET_NAME.test(entry.name) || EXCLUDED_DIR.test(full)) { skipped++; continue; }
          if (entry.isDirectory()) { queue.push(full); continue; }
          if (!entry.isFile()) { skipped++; continue; }
          scanned++;
          try {
            const stat = statSync(full);
            if (stat.size > 15 * 1024 * 1024) { skipped++; continue; }
            const extracted = await this.extract(full);
            if (!extracted.content.trim()) { skipped++; continue; }
            this.store.indexReplace(full, extracted.kind, redact(extracted.content).slice(0, 500_000), stat.size, stat.mtimeMs);
            indexed++;
          } catch { skipped++; }
          if (scanned % 20 === 0) await new Promise<void>((resume) => setImmediate(resume));
        }
      }
      const result = { root, scanned, indexed, skipped, completedAt: nowIso() };
      this.store.audit("index", "success", result);
      return result;
    } finally {
      this.indexing = false;
    }
  }

  search(query: string, limit = 20) {
    try { return this.store.search(query.replace(/["']/g, " ").trim(), limit); }
    catch { return []; }
  }

  private async extract(path: string): Promise<{ kind: string; content: string }> {
    const ext = extname(path).toLowerCase();
    if (TEXT_EXT.has(ext)) return { kind: "text", content: readFileSync(path, "utf8") };
    if (ext === ".docx") return { kind: "docx", content: (await mammoth.extractRawText({ path })).value };
    if (ext === ".xlsx" || ext === ".xlsm") {
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.readFile(path);
      const lines: string[] = [];
      workbook.eachSheet((sheet) => {
        lines.push(`# ${sheet.name}`);
        sheet.eachRow((row, number) => {
          const values = Array.isArray(row.values) ? row.values.slice(1) : [];
          lines.push(`${number}: ${values.map(String).join(" | ")}`);
        });
      });
      return { kind: "xlsx", content: lines.join("\n") };
    }
    if (ext === ".pptx") {
      const zip = await JSZip.loadAsync(readFileSync(path));
      const slides = Object.keys(zip.files).filter((name) => /^ppt\/slides\/slide\d+\.xml$/i.test(name)).sort();
      const chunks: string[] = [];
      for (const slide of slides) {
        const xml = await zip.file(slide)!.async("string");
        chunks.push(`${slide}\n${[...xml.matchAll(/<a:t>(.*?)<\/a:t>/g)].map((match) => match[1]).join(" ")}`);
      }
      return { kind: "pptx", content: chunks.join("\n") };
    }
    if (ext === ".pdf") {
      const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
      const document = await pdfjs.getDocument({ data: new Uint8Array(readFileSync(path)), useSystemFonts: true }).promise;
      const pages: string[] = [];
      for (let i = 1; i <= Math.min(document.numPages, 200); i++) {
        const page = await document.getPage(i);
        const content = await page.getTextContent();
        pages.push(`Page ${i}: ${content.items.map((item) => "str" in item ? item.str : "").join(" ")}`);
      }
      return { kind: "pdf", content: pages.join("\n") };
    }
    return { kind: "unknown", content: "" };
  }
}

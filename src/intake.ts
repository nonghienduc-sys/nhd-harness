import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, extname, isAbsolute, relative, resolve, sep } from "node:path";
import { AppConfig } from "./config.js";
import { Store } from "./db.js";
import { nowIso } from "./security.js";

const ALLOWED_EXTENSIONS = new Set([".pdf", ".doc", ".docx", ".xls", ".xlsx", ".xlsm", ".ppt", ".pptx", ".txt", ".csv", ".rtf", ".png", ".jpg", ".jpeg", ".tif", ".tiff"]);
const TEMP_EXTENSION = /\.(?:crdownload|download|part|partial|tmp)$/i;
const SENSITIVE_NAME = /(^|[._-])(env|credential|credentials|secret|secrets|password|passwd|token|apikey|api-key|cookie|cookies)([._-]|$)/i;

export type IntakeFile = {
  path: string;
  name: string;
  extension: string;
  size: number;
  modifiedAt: string;
  hash: string;
  mimeType: string;
  root: string;
};

export class IntakeService {
  constructor(readonly config: AppConfig, readonly store: Store) {}

  status() {
    const roots = this.config.intakeRoots.map((path) => ({ path: resolve(path), available: existsSync(path) }));
    return { enabled: this.config.intakeEnabled, roots, availableRoots: roots.filter((item) => item.available).length, allowedExtensions: [...ALLOWED_EXTENSIONS].sort() };
  }

  resolvePath(input: string): string {
    if (!this.config.intakeEnabled || this.config.emergencyStop) throw new Error("Document Intake is disabled by the owner.");
    const candidate = resolve(isAbsolute(input) ? input : resolve(this.config.intakeRoots[0] ?? "", input));
    const root = this.config.intakeRoots.find((item) => {
      const normalized = resolve(item).replace(/[\\/]+$/, "");
      return candidate.toLowerCase() === normalized.toLowerCase() || candidate.toLowerCase().startsWith(`${normalized.toLowerCase()}${sep}`);
    });
    if (!root) throw new Error("Path is outside approved intake folders.");
    if (SENSITIVE_NAME.test(basename(candidate))) throw new Error("Sensitive intake path is blocked.");
    const rel = relative(resolve(root), candidate);
    let current = resolve(root);
    for (const part of rel.split(/[\\/]+/).filter(Boolean)) {
      current = resolve(current, part);
      if (existsSync(current) && lstatSync(current).isSymbolicLink()) throw new Error("Symbolic links and junction traversal are blocked in intake folders.");
    }
    return candidate;
  }

  describe(pathInput: string): IntakeFile {
    const path = this.resolvePath(pathInput);
    const stat = statSync(path);
    if (!stat.isFile()) throw new Error("Intake path is not a file.");
    const extension = extname(path).toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(extension) || TEMP_EXTENSION.test(path)) throw new Error("File type is not allowed for document intake.");
    const root = this.config.intakeRoots.find((item) => path.toLowerCase().startsWith(resolve(item).toLowerCase()))!;
    return { path, name: basename(path), extension, size: stat.size, modifiedAt: stat.mtime.toISOString(), hash: this.hash(path), mimeType: this.mime(extension), root: resolve(root) };
  }

  listRecent(options: { extension?: string; since?: string; limit?: number; maxDepth?: number } = {}): IntakeFile[] {
    if (!this.config.intakeEnabled || this.config.emergencyStop) throw new Error("Document Intake is disabled by the owner.");
    const extension = options.extension ? `.${options.extension.replace(/^\./, "").toLowerCase()}` : "";
    const since = options.since ? Date.parse(options.since) : Date.now() - 7 * 24 * 60 * 60 * 1000;
    if (!Number.isFinite(since)) throw new Error("Invalid intake since timestamp.");
    const limit = Math.min(Math.max(Math.trunc(options.limit ?? 30), 1), 200);
    const maxDepth = Math.min(Math.max(Math.trunc(options.maxDepth ?? 4), 0), 8);
    const found: Array<{ path: string; modifiedAt: number }> = [];
    let scannedEntries = 0;
    for (const configuredRoot of this.config.intakeRoots) {
      const root = resolve(configuredRoot);
      if (!existsSync(root)) continue;
      const queue: Array<{ path: string; depth: number }> = [{ path: root, depth: 0 }];
      while (queue.length && scannedEntries < 10_000) {
        const current = queue.shift()!;
        let entries;
        try { entries = readdirSync(current.path, { withFileTypes: true }); } catch { continue; }
        for (const entry of entries) {
          scannedEntries++;
          if (scannedEntries > 10_000) break;
          const full = resolve(current.path, entry.name);
          if (entry.isSymbolicLink() || SENSITIVE_NAME.test(entry.name)) continue;
          if (entry.isDirectory()) {
            if (current.depth < maxDepth) queue.push({ path: full, depth: current.depth + 1 });
            continue;
          }
          if (!entry.isFile() || TEMP_EXTENSION.test(entry.name)) continue;
          const ext = extname(entry.name).toLowerCase();
          if (!ALLOWED_EXTENSIONS.has(ext) || (extension && ext !== extension)) continue;
          let stat;
          try { stat = statSync(full); } catch { continue; }
          if (stat.mtimeMs < since) continue;
          found.push({ path: full, modifiedAt: stat.mtimeMs });
        }
      }
    }
    const files = found.sort((a, b) => b.modifiedAt - a.modifiedAt).slice(0, limit).flatMap((item) => { try { return [this.describe(item.path)]; } catch { return []; } });
    this.store.audit("intake_list_recent", "success", { extension: extension || null, since: new Date(since).toISOString(), count: files.length, scannedEntries, scanLimited: scannedEntries >= 10_000 });
    return files;
  }

  async waitForFile(options: { extension?: string; since?: string; timeoutSeconds?: number; settleMilliseconds?: number } = {}): Promise<IntakeFile> {
    const timeout = Math.min(Math.max(Math.trunc(options.timeoutSeconds ?? 30), 1), 120) * 1000;
    const settle = Math.min(Math.max(Math.trunc(options.settleMilliseconds ?? 1000), 250), 5000);
    const started = Date.now();
    const seen = new Map<string, number>();
    while (Date.now() - started < timeout) {
      const candidates = this.listRecent({ extension: options.extension, since: options.since ?? new Date(started - 2000).toISOString(), limit: 20 });
      for (const candidate of candidates) {
        const previous = seen.get(candidate.path);
        if (previous === candidate.size && candidate.size > 0) {
          if (candidate.extension === ".pdf" && readFileSync(candidate.path).subarray(0, 5).toString("ascii") !== "%PDF-") continue;
          this.store.audit("intake_wait_for_file", "success", { path: candidate.path, hash: candidate.hash, size: candidate.size });
          return candidate;
        }
        seen.set(candidate.path, candidate.size);
      }
      await new Promise((resume) => setTimeout(resume, settle));
    }
    throw new Error("No completed intake file appeared before the timeout.");
  }

  private hash(path: string): string {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  }

  private mime(extension: string): string {
    const types: Record<string, string> = { ".pdf": "application/pdf", ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document", ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation", ".txt": "text/plain", ".csv": "text/csv", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".tif": "image/tiff", ".tiff": "image/tiff" };
    return types[extension] ?? "application/octet-stream";
  }
}

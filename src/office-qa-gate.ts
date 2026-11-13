import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { Store } from "./db.js";

export type OfficeQaStatus = "pending" | "pass" | "fail" | "unavailable";

export type OfficeQaState = {
  path: string;
  application: string;
  mutationId: string;
  mutationHash: string | null;
  status: OfficeQaStatus;
  source: string;
  findings: string[];
  reviewedPages: number[];
  updatedAt: string;
  reviewedAt: string | null;
  stale: boolean;
};

function hashFile(path: string) {
  if (!existsSync(path)) return null;
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function norm(path: string) {
  return resolve(path);
}

function id() {
  return `mutation-${randomBytes(12).toString("hex")}`;
}

export class OfficeQaGate {
  constructor(readonly store: Store, readonly roots: string[] = []) {
    this.initSchema();
  }

  registerMutation(pathInput: string, application: string, source: string) {
    const path = norm(pathInput);
    const mutationId = id();
    const mutationHash = hashFile(path);
    const now = new Date().toISOString();
    this.store.db.prepare(`INSERT INTO office_qa_state(path,application,mutation_id,mutation_hash,status,source,findings_json,reviewed_pages_json,updated_at,reviewed_at)
      VALUES(?,?,?,?,? ,?,?,?, ?,NULL)
      ON CONFLICT(path) DO UPDATE SET application=excluded.application,mutation_id=excluded.mutation_id,mutation_hash=excluded.mutation_hash,status='pending',source=excluded.source,findings_json='[]',reviewed_pages_json='[]',updated_at=excluded.updated_at,reviewed_at=NULL`)
      .run(path, application, mutationId, mutationHash, "pending", source, "[]", "[]", now);
    this.store.audit("office_qa_mutation", "pending", { path, application, mutationId, source, mutationHash });
    const state = this.status(path);
    if (!state) throw new Error("Visual QA mutation state was not created.");
    return state;
  }

  ensurePending(pathInput: string, application: string, source = "office_visual_qa_capture") {
    const current = this.status(pathInput);
    if (!current || current.stale) return this.registerMutation(pathInput, application, source);
    return current;
  }

  status(pathInput: string): OfficeQaState | null {
    const path = norm(pathInput);
    const row = this.store.db.prepare("SELECT * FROM office_qa_state WHERE path=?").get(path) as Record<string, unknown> | undefined;
    if (!row) return null;
    const mutationHash = row.mutation_hash ? String(row.mutation_hash) : null;
    const currentHash = hashFile(path);
    const stale = Boolean(mutationHash && currentHash && mutationHash !== currentHash);
    if (stale && String(row.status) === "pass") {
      const now = new Date().toISOString();
      this.store.db.prepare("UPDATE office_qa_state SET status='pending',mutation_id=?,mutation_hash=?,source=?,findings_json='[]',reviewed_pages_json='[]',updated_at=?,reviewed_at=NULL WHERE path=?")
        .run(id(), currentHash, "external_file_change", now, path);
      return this.status(path);
    }
    return {
      path,
      application: String(row.application),
      mutationId: String(row.mutation_id),
      mutationHash: row.mutation_hash ? String(row.mutation_hash) : null,
      status: String(row.status) as OfficeQaStatus,
      source: String(row.source),
      findings: JSON.parse(String(row.findings_json || "[]")),
      reviewedPages: JSON.parse(String(row.reviewed_pages_json || "[]")),
      updatedAt: String(row.updated_at),
      reviewedAt: row.reviewed_at ? String(row.reviewed_at) : null,
      stale,
    };
  }

  verdict(pathInput: string, mutationId: string, verdict: "pass" | "fail", findings: string[] = [], reviewedPages: number[] = []) {
    const path = norm(pathInput);
    const current = this.status(path);
    if (!current) throw new Error("No Visual QA mutation is registered for this Office document. Capture QA first.");
    if (current.mutationId !== mutationId) throw new Error("Visual QA verdict is stale: the document has changed since the reviewed mutation.");
    const currentHash = hashFile(path);
    if (current.mutationHash && currentHash && current.mutationHash !== currentHash) throw new Error("Visual QA verdict is stale: file hash changed after capture.");
    const now = new Date().toISOString();
    const cleanFindings = findings.map((x) => String(x).trim()).filter(Boolean).slice(0, 100);
    const cleanPages = [...new Set(reviewedPages.map((x) => Math.trunc(x)).filter((x) => x > 0))].slice(0, 200);
    this.store.db.prepare("UPDATE office_qa_state SET status=?,findings_json=?,reviewed_pages_json=?,updated_at=?,reviewed_at=? WHERE path=?")
      .run(verdict, JSON.stringify(cleanFindings), JSON.stringify(cleanPages), now, now, path);
    this.store.audit("office_visual_qa_verdict", verdict, { path, mutationId, findings: cleanFindings.length, reviewedPages: cleanPages });
    return this.status(path);
  }

  unavailable(pathInput: string, application: string, reason: string) {
    const current = this.ensurePending(pathInput, application, "visual_review_unavailable");
    const now = new Date().toISOString();
    this.store.db.prepare("UPDATE office_qa_state SET status='unavailable',findings_json=?,updated_at=?,reviewed_at=NULL WHERE path=?")
      .run(JSON.stringify([String(reason).slice(0, 1000)]), now, current.path);
    return this.status(current.path);
  }

  debt(rootInput?: string) {
    const rows = this.store.db.prepare("SELECT path FROM office_qa_state WHERE status!='pass' ORDER BY updated_at DESC").all() as { path: string }[];
    const root = rootInput ? norm(rootInput) : null;
    return rows.map((r) => this.status(r.path)).filter((x): x is OfficeQaState => Boolean(x)).filter((x) => !root || x.path.toLowerCase().startsWith(root.toLowerCase()));
  }

  private initSchema() {
    this.store.db.exec(`CREATE TABLE IF NOT EXISTS office_qa_state(
      path TEXT PRIMARY KEY,
      application TEXT NOT NULL,
      mutation_id TEXT NOT NULL,
      mutation_hash TEXT,
      status TEXT NOT NULL,
      source TEXT NOT NULL,
      findings_json TEXT NOT NULL DEFAULT '[]',
      reviewed_pages_json TEXT NOT NULL DEFAULT '[]',
      updated_at TEXT NOT NULL,
      reviewed_at TEXT
    );`);
  }
}

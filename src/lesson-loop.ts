import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join, resolve, relative, isAbsolute } from "node:path";
import { containsSensitive, parseFrontMatter } from "./brain-kit.js";
import type { SelfEvolutionEngine } from "./self-evolution.js";

const ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/;
const CODE = /^[A-Z][A-Z0-9_]{2,63}$/;
const REMEDIATIONS = new Set(["DOCX_JUSTIFY", "DOCX_SHAPE_LINE", "DOCX_RELEASE_QA", "SKILL_DUPLICATE"]);
export type LessonDecision = "approve" | "reject";
export type FileTransaction = {
  preview: (kind: "write", payload: Record<string, unknown>, taskRunId: string) => { actionId: string; confirmationToken: string; [key: string]: unknown };
  apply: (actionId: string, token: string, kind: "write", taskRunId: string) => unknown;
};
export type LessonFeedback = { luc: string; receipt: string; quy_trinh: string; ma_loi: string; mo_ta: string; nguon: string };
function idCheck(id: string) {
  if (!ID.test(id)) throw new Error("Invalid lesson/process id");
  return id;
}
function ensureSafeText(value: string) {
  if (containsSensitive(value)) throw new Error("Từ chối secret, SĐT, CCCD hoặc email.");
  if (value.length > 2000 || /[\x00-\x08\x0b-\x1f]/.test(value)) throw new Error("Unsafe lesson text.");
}
function inside(root: string, path: string) {
  const rel = relative(resolve(root), resolve(path));
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error("Path outside private knowledge.");
  return path;
}
function lessonDir(root: string, make = false) {
  const base = resolve(root);
  const dir = inside(base, join(base, "bai_hoc"));
  if (existsSync(base) && lstatSync(base).isSymbolicLink()) throw new Error("Knowledge root is a symlink");
  if (existsSync(dir) && lstatSync(dir).isSymbolicLink()) throw new Error("Lesson directory is a symlink");
  if (make) mkdirSync(dir, { recursive: true });
  return dir;
}
function fileFor(root: string, id: string) {
  const path = inside(root, join(lessonDir(root), idCheck(id) + ".md"));
  if (existsSync(path) && !lstatSync(path).isFile()) throw new Error("Lesson target is not a regular file");
  return path;
}
export function readFeedback(root: string): LessonFeedback[] {
  const path = join(resolve(root), "phan_hoi.jsonl");
  if (!existsSync(path)) return [];
  if (!lstatSync(path).isFile() || lstatSync(path).size > 8_000_000) throw new Error("Invalid feedback log");
  const records: LessonFeedback[] = [];
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    let row: unknown;
    try { row = JSON.parse(line); } catch { continue; }
    if (!row || typeof row !== "object") continue;
    const x = row as Record<string, unknown>;
    if (typeof x.quy_trinh !== "string" || !ID.test(x.quy_trinh) ||
        typeof x.ma_loi !== "string" || !CODE.test(x.ma_loi) ||
        typeof x.receipt !== "string" || x.receipt.length > 160 ||
        typeof x.mo_ta !== "string" || x.mo_ta.length > 200 ||
        typeof x.nguon !== "string" || !["nghiem_thu", "nguoi_dung", "mat"].includes(x.nguon)) continue;
    const info = [x.receipt, x.mo_ta, x.quy_trinh, x.ma_loi].join("\n");
    if (containsSensitive(info)) continue;
    records.push({luc: typeof x.luc === "string" ? x.luc.slice(0, 50) : "", receipt: x.receipt,
      quy_trinh: x.quy_trinh, ma_loi: x.ma_loi, mo_ta: x.mo_ta, nguon: x.nguon});
  }
  return records;
}
export function analyzeLessons(root: string) {
  const grouped = new Map<string, { quy_trinh: string; ma_loi: string; so_lan: number; nguon: string[] }>();
  for (const row of readFeedback(root)) {
    const key = row.quy_trinh + "|" + row.ma_loi;
    const g = grouped.get(key) ?? { quy_trinh: row.quy_trinh, ma_loi: row.ma_loi, so_lan: 0, nguon: [] };
    g.so_lan++;
    if (!g.nguon.includes(row.receipt)) g.nguon.push(row.receipt);
    grouped.set(key, g);
  }
  return [...grouped.values()].sort((a, b) => b.so_lan - a.so_lan || a.quy_trinh.localeCompare(b.quy_trinh) || a.ma_loi.localeCompare(b.ma_loi));
}
function readLesson(path: string) {
  const doc = parseFrontMatter(readFileSync(path, "utf8"));
  if (basename(path, ".md") !== doc.fields.id) throw new Error("Lesson id/filename mismatch");
  return doc;
}
export function listLessons(root: string) {
  const dir = lessonDir(root);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(x => x.endsWith(".md")).sort().flatMap(name => {
    const file = join(dir, name);
    if (lstatSync(file).isSymbolicLink()) return [];
    try { const doc = readLesson(file); return [{ id: doc.fields.id, quy_trinh: doc.fields.quy_trinh,
      ma_loi: doc.fields.ma_loi, trang_thai: doc.fields.trang_thai, so_lan: doc.fields.so_lan, noi_dung: doc.body }]; }
    catch { return []; }
  });
}
function document(fields: Record<string, unknown>, body: string) {
  const keys = ["id", "quy_trinh", "ma_loi", "trang_thai", "so_lan", "nguon", "tao_luc", "duyet_luc"];
  const values = keys.filter(k => fields[k] !== undefined).map(k => {
    const v = fields[k];
    return k + ": " + (Array.isArray(v) ? "[" + v.join(", ") + "]" : String(v));
  });
  const result = "---\n" + values.join("\n") + "\n---\n" + body.trim() + "\n";
  ensureSafeText(result);
  return result;
}
export function proposeLesson(root: string, quyTrinh: string, maLoi: string, body = "") {
  idCheck(quyTrinh);
  if (!CODE.test(maLoi)) throw new Error("Invalid error code");
  ensureSafeText(body);
  const group = analyzeLessons(root).find(x => x.quy_trinh === quyTrinh && x.ma_loi === maLoi);
  if (!group || group.so_lan < 2) throw new Error("Cần ít nhất 2 lần lỗi cùng quy trình và mã lỗi.");
  const id = idCheck((quyTrinh + "-" + maLoi.toLowerCase().replace(/_/g, "-")).slice(0, 100));
  lessonDir(root, true);
  const path = fileFor(root, id);
  const old = existsSync(path) ? readLesson(path) : null;
  if (old && old.fields.trang_thai !== "de_xuat") return { id, path, status: old.fields.trang_thai, so_lan: old.fields.so_lan, unchanged: true };
  const text = body.trim() || old?.body || "Đối chiếu lỗi " + maLoi + " với chứng cứ nghiệm thu; sửa nguyên nhân rồi chạy lại các cổng kiểm độc lập.";
  const fields = { id, quy_trinh: quyTrinh, ma_loi: maLoi, trang_thai: "de_xuat",
    so_lan: group.so_lan, nguon: group.nguon.slice(0, 40), tao_luc: old?.fields.tao_luc ?? new Date().toISOString(), duyet_luc: "" };
  const content = document(fields, text);
  if (!old || readFileSync(path, "utf8") !== content) writeFileSync(path, content, "utf8");
  return { id, path, status: "de_xuat", so_lan: group.so_lan, unchanged: Boolean(old && readFileSync(path, "utf8") === content) };
}
export function decisionDocument(root: string, id: string, op: LessonDecision) {
  if (!["approve", "reject"].includes(op)) throw new Error("Invalid decision");
  const path = fileFor(root, id);
  const { fields, body } = readLesson(path);
  if (fields.trang_thai !== "de_xuat") throw new Error("Only proposed lessons can be decided.");
  if (!CODE.test(String(fields.ma_loi)) || !ID.test(String(fields.quy_trinh))) throw new Error("Invalid lesson metadata");
  const content = document({ ...fields, trang_thai: op === "approve" ? "da_duyet" : "bo",
    duyet_luc: new Date().toISOString() }, body);
  return { path, content, fields };
}
export function previewLessonDecision(root: string, id: string, op: LessonDecision, taskRunId: string, files: FileTransaction) {
  if (!taskRunId) throw new Error("Durable task required.");
  const next = decisionDocument(root, id, op);
  const preview = files.preview("write", { path: next.path, content: next.content }, taskRunId);
  return { ...preview, id, op, path: next.path, ma_loi: next.fields.ma_loi };
}
export function applyLessonDecision(root: string, id: string, op: LessonDecision, taskRunId: string,
  actionId: string | undefined, token: string | undefined, pending: { id: string; op: LessonDecision; taskRunId: string; path: string } | undefined,
  files: FileTransaction, evolution?: Pick<SelfEvolutionEngine, "recordFeedback"> | null, skillId?: string) {
  if (!actionId || !token || !taskRunId || !pending || pending.id !== id || pending.op !== op ||
      pending.taskRunId !== taskRunId || pending.path !== fileFor(root, id)) throw new Error("Human approval preview and token required.");
  const prior = decisionDocument(root, id, op);
  const output = files.apply(actionId, token, "write", taskRunId);
  const now = readLesson(prior.path);
  if (now.fields.trang_thai !== (op === "approve" ? "da_duyet" : "bo")) throw new Error("Lesson decision not verified.");
  if (op === "approve" && REMEDIATIONS.has(String(now.fields.ma_loi)) && evolution) {
    const normalizedSkill = (skillId || "brain-kit").toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]{1,79}$/.test(normalizedSkill)) throw new Error("Invalid skill id");
    evolution.recordFeedback({taskId: taskRunId, skillId: normalizedSkill, issueCode: String(now.fields.ma_loi),
      outcome: "failure", source: "verified_qa", verified: true});
  }
  return { id, status: now.fields.trang_thai, output };
}

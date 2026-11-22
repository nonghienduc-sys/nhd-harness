import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { resolve, join, basename } from "node:path";

export type KnowledgeKind = "quy_trinh" | "bai_hoc" | "memory";
export type KnowledgeItem = { id: string; kind: KnowledgeKind; fields: Record<string, any>; body: string; source: "public" | "private" };
export type BrainKitOptions = { publicDir: string; localDir: string; projectSummary?: (root: string) => unknown };
export type BrainStartInput = { yeu_cau: string; project_root?: string; max_chars?: number };
const fileCache = new Map<string, { stamp: string; text: string }>();
const kinds: KnowledgeKind[] = ["quy_trinh", "bai_hoc", "memory"];
const safeId = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/;

export function defaultPublicKnowledgeDir() {
  return resolve(import.meta.dirname ?? resolve(new URL(".", import.meta.url).pathname), "..", "knowledge");
}
export function fold(text: unknown): string {
  return String(text ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[đĐ]/g, "d").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}
function scalar(raw: string): any {
  const s = raw.trim();
  if (!s) return "";
  if (s.startsWith("[") && s.endsWith("]")) return s.slice(1, -1).split(",").map(x => scalar(x)).filter(x => x !== "");
  if (/^-?\d+$/.test(s)) return Number(s);
  if (s === "true") return true;
  if (s === "false") return false;
  return s.replace(/^["']|["']$/g, "");
}
export function parseFrontMatter(input: string): { fields: Record<string, any>; body: string } {
  const text = input.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  const lines = text.split("\n");
  if (lines[0].trim() !== "---") throw new Error("missing opening front matter");
  const last = lines.findIndex((line, i) => i > 0 && line.trim() === "---");
  if (last < 2) throw new Error("missing/empty closing front matter");
  const fields: Record<string, any> = {};
  let section = "";
  let item: Record<string, any> | null = null;
  for (const line of lines.slice(1, last)) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const top = /^([a-zA-Z_][\w-]*):(?:\s+(.*))?$/.exec(line);
    if (top) {
      section = top[1]; item = null;
      fields[section] = top[2] === undefined ? [] : scalar(top[2]);
      continue;
    }
    const list = /^\s+-\s+([a-zA-Z_][\w-]*):\s*(.*)$/.exec(line);
    if (list && section) {
      item = { [list[1]]: scalar(list[2]) };
      if (!Array.isArray(fields[section])) fields[section] = [];
      fields[section].push(item);
      continue;
    }
    const inner = /^\s+([a-zA-Z_][\w-]*):\s*(.*)$/.exec(line);
    if (inner && item) { item[inner[1]] = scalar(inner[2]); continue; }
    const strItem = /^\s+-\s+(.+)$/.exec(line);
    if (strItem && section) {
      if (!Array.isArray(fields[section])) fields[section] = [];
      fields[section].push(scalar(strItem[1]));
      continue;
    }
    throw new Error("invalid YAML front matter line");
  }
  if (typeof fields.id !== "string" || !safeId.test(fields.id)) throw new Error("invalid or missing id");
  return { fields, body: lines.slice(last + 1).join("\n").trim() };
}
function cachedRead(path: string) {
  const s = statSync(path);
  const stamp = String(s.mtimeMs) + ":" + s.size;
  const found = fileCache.get(path);
  if (found?.stamp === stamp) return found.text;
  const text = readFileSync(path, "utf8");
  fileCache.set(path, { stamp, text });
  return text;
}
export function loadKnowledge(opts: BrainKitOptions) {
  const warnings: string[] = [];
  const all = new Map<KnowledgeKind, Map<string, KnowledgeItem>>();
  for (const kind of kinds) all.set(kind, new Map());
  let law = "";
  let gates: Record<string, any> = {};
  for (const [root, source] of [[opts.publicDir, "public"], [opts.localDir, "private"]] as const) {
    if (!existsSync(root)) continue;
    const lawFile = join(root, "luat_nen.md");
    if (existsSync(lawFile)) {
      try { law = cachedRead(lawFile).slice(0, 1500).trim(); }
      catch { warnings.push("Không đọc được luật nền (" + source + ")"); }
    }
    const gateFile = join(root, "cong.json");
    if (existsSync(gateFile)) {
      try {
        const parsed = JSON.parse(cachedRead(gateFile));
        if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") throw new Error();
        gates = { ...gates, ...parsed };
      } catch { warnings.push("cong.json hỏng (" + source + ")"); }
    }
    for (const kind of kinds) {
      const dir = join(root, kind);
      if (!existsSync(dir)) continue;
      let paths: string[] = [];
      try { paths = readdirSync(dir).filter(p => p.endsWith(".md")).sort(); }
      catch { warnings.push("Không đọc được thư mục " + kind); continue; }
      for (const p of paths) {
        const path = join(dir, p);
        try {
          const parsed = parseFrontMatter(cachedRead(path));
          if (basename(p, ".md") !== parsed.fields.id) throw new Error("id does not match filename");
          if (kind === "memory" && !["user", "feedback", "project", "reference"].includes(parsed.fields.loai)) throw new Error("invalid memory type");
          if (kind === "quy_trinh" && (!parsed.fields.ten || !Array.isArray(parsed.fields.tu_khoa))) throw new Error("invalid process metadata");
          if (kind === "bai_hoc" && !["de_xuat", "da_duyet", "bo"].includes(parsed.fields.trang_thai)) throw new Error("invalid lesson status");
          all.get(kind)!.set(parsed.fields.id, { id: parsed.fields.id, kind, fields: parsed.fields, body: parsed.body, source });
        } catch (e) {
          warnings.push("Bỏ qua " + kind + "/" + p + ": " + (e instanceof Error ? e.message : "invalid"));
        }
      }
    }
  }
  return { law, gates, all, warnings };
}
function score(item: KnowledgeItem, query: string): number {
  const q = fold(query);
  if (!q) return 0;
  const tokens = Array.from(new Set(q.split(" ").filter(t => t.length > 1)));
  const weights: [string, number][] = item.kind === "memory"
    ? [["id", 8], ["ten", 6], ["mo_ta", 8], ["noi_dung", 4]]
    : [["tu_khoa", 8], ["ten", 6], ["khi_nao", 4], ["mo_ta", 4]];
  let score = 0;
  for (const [key, weight] of weights) {
    const raw = key === "id" ? item.id : key === "noi_dung" ? item.body : item.fields[key];
    const values = (Array.isArray(raw) ? raw : [raw]).filter(Boolean).map(fold);
    for (const value of values) {
      if (!value) continue;
      if (q.includes(value) && value.length > 3) score += weight * 3;
      if (value.includes(q) && q.length > 3) score += weight * 2;
      for (const token of tokens) {
        if ((" " + value + " ").includes(" " + token + " ")) score += weight;
        else if (token.length > 4 && value.includes(token)) score += weight / 3;
      }
    }
  }
  return score;
}
export function searchKnowledge(store: ReturnType<typeof loadKnowledge>, kind: KnowledgeKind, query: string, limit = 20) {
  return [...store.all.get(kind)!.values()].map(item => ({ item, diem: score(item, query) }))
    .filter(x => x.diem > 0).sort((a, b) => b.diem - a.diem || a.item.id.localeCompare(b.item.id)).slice(0, limit);
}
function size(value: unknown) { return JSON.stringify(value).length; }
function compactItem(item: KnowledgeItem, bodyMax = 240) {
  return { id: item.id, loai: item.fields.loai, mo_ta: String(item.fields.mo_ta ?? "").slice(0, 160), noi_dung: item.body.slice(0, bodyMax) };
}
export function brainStart(input: BrainStartInput, opts: BrainKitOptions) {
  if (!input.yeu_cau?.trim()) throw new Error("yeu_cau bắt buộc");
  const max = Math.max(300, Math.min(50000, input.max_chars ?? 6000));
  const store = loadKnowledge(opts);
  // Rank only meaningful evidence. Generic verbs and deictic references never select a workflow.
  const stop = new Set(("toi ban minh anh em hay giup ho lam viec nay do kia cai ay day no nhu hom qua truoc sau roi chua xong nhe voi cho cua va la thi se can muon duoc da dang mot nhung cac co khong nao sao the nao gi ve tren duoi trong ra tu den ngay lai di di nua luon nhanh nhat voi the theo phai de nhung xu ly kiem tra").split(" "));
  const normalize = (text: unknown) => fold(text).split(" ").filter(Boolean);
  const adminTypes = new Set(["cong van", "to trinh", "bao cao", "ke hoach", "quyet dinh", "thong bao"]);
  const adminForm = new Set(["mau", "the thuc", "dinh dang", "quoc hieu", "tieu ngu"]);
  const query = fold(input.yeu_cau);
  const rawTokens = normalize(query);
  const meaningful = [...new Set(rawTokens.filter(t => t.length > 1 && !stop.has(t)))];
  const concepts = (value: string) => {
    const words = normalize(value);
    const result = new Set(words.filter(t => t.length > 1 && !stop.has(t)));
    const padded = " " + words.join(" ") + " ";
    if ([...adminTypes].some(phrase => padded.includes(" " + phrase + " "))) result.add("admin_document");
    if ([...adminForm].some(phrase => padded.includes(" " + phrase + " "))) result.add("admin_format");
    return result;
  };
  const requestConcepts = concepts(query);
  const requestEvidence = new Set([...meaningful, ...requestConcepts]);
  const processes = [...store.all.get("quy_trinh")!.values()];
  const docs = processes.map(p => {
    const steps = Array.isArray(p.fields.buoc) ? p.fields.buoc : [];
    const gateIds = steps.flatMap((step: any) => Array.isArray(step.cong) ? step.cong : step.cong ? [step.cong] : []);
    const gates = gateIds.map((id: string) => String(id) + " " + String(store.gates[id]?.mo_ta ?? ""));
    const keywords = Array.isArray(p.fields.tu_khoa) ? p.fields.tu_khoa : [];
    const segments = [
      { weight: 5, values: keywords },
      { weight: 4, values: [p.fields.ten] },
      { weight: 3, values: gates },
      { weight: 2, values: steps.map((step: any) => step.viec) },
      { weight: 1, values: [p.fields.khi_nao, p.fields.mo_ta, p.body] },
    ].map(group => ({ weight: group.weight, values: group.values.map(concepts) }));
    const vocabulary = new Set(segments.flatMap(g => g.values.flatMap(v => [...v])));
    return { p, segments, vocabulary };
  });
  const idf = (token: string) => 1 + Math.log((docs.length + 1) / (1 + docs.filter(d => d.vocabulary.has(token)).length));
  const scored = docs.map(d => {
    let points = 0;
    const matched = new Set<string>();
    for (const token of requestEvidence) {
      const group = d.segments.find(g => g.values.some(v => v.has(token)));
      if (!group) continue;
      matched.add(token);
      points += idf(token) * group.weight;
    }
    // Match multi-word concepts as a single coherent piece of evidence, not scattered common words.
    const keyPhrases = (Array.isArray(d.p.fields.tu_khoa) ? d.p.fields.tu_khoa : []).map(fold);
    for (const phrase of keyPhrases) {
      if (phrase.includes(" ") && (" " + query + " ").includes(" " + phrase + " ")) points += 3;
    }
    return { item: d.p, diem: points, matched: matched.size };
  }).sort((a, b) => b.diem - a.diem || a.item.id.localeCompare(b.item.id));
  const ranked = scored.filter(x => x.diem > 0);
  const top = ranked[0], runner = ranked[1];
  const candidates = meaningful.length > 1 ? ranked.slice(0, 3) : [];
  const candidateInfo = candidates.map(x => {
    const steps = Array.isArray(x.item.fields.buoc) ? x.item.fields.buoc : [];
    const gates = [...new Set(steps.flatMap((v: any) => Array.isArray(v.cong) ? v.cong : v.cong ? [v.cong] : []))];
    return { id: x.item.id, ten: x.item.fields.ten, khi_nao: String(x.item.fields.khi_nao ?? "").slice(0, 200), diem: x.diem, cong: gates };
  });
  const hasSpecificIntent = meaningful.length >= 2 &&
    !(meaningful.length <= 2 && meaningful.every(t => ["tai", "lieu", "bao", "cao", "van", "ban"].includes(t)));
  const confident = hasSpecificIntent && !!top && top.matched >= 2 && top.diem >= 7 &&
    (!runner || top.diem >= runner.diem * 1.08 || top.diem - runner.diem >= 3);
  const best = confident ? top.item : undefined;
  const steps = best && Array.isArray(best.fields.buoc) ? best.fields.buoc : [];
  const gateIds = [...new Set((best ? steps : candidates.flatMap(x => Array.isArray(x.item.fields.buoc) ? x.item.fields.buoc : []))
    .flatMap((x: any) => Array.isArray(x.cong) ? x.cong : x.cong ? [x.cong] : []))];
  const missingGates = gateIds.filter(id => !Object.hasOwn(store.gates, id));
  const result: any = {
    luat_nen: store.law || "Chưa cấu hình luật nền.",
    ung_vien: candidateInfo,
    quy_trinh: best ? { id: best.id, ten: best.fields.ten, buoc: steps, ghi_chu: best.body.slice(0, 300), ung_vien: ranked.slice(1, 3).map(x => ({ id: x.item.id, ten: x.item.fields.ten, diem: x.diem })) }
      : { thong_bao: "chưa có quy trình, làm theo luật nền và hỏi người dùng", ung_vien: [] },
    ...(!best ? { can_hoi_lai: { cau_hoi: "Bạn muốn thực hiện quy trình nào, với đầu vào cụ thể nào?", goi_y: candidateInfo.map(x => ({ id: x.id, ten: x.ten })) } } : {}),
    bai_hoc: [...store.all.get("bai_hoc")!.values()]
      .filter(x => x.fields.trang_thai === "da_duyet" && best && x.fields.quy_trinh === best.id)
      .sort((a, b) => (Number(b.fields.so_lan) || 0) - (Number(a.fields.so_lan) || 0)).slice(0, 5)
      .map(x => ({ id: x.id, ma_loi: x.fields.ma_loi, noi_dung: x.body.slice(0, 180) })),
    memory: [],
    du_an: null,
    cong: Object.fromEntries(gateIds.filter(id => Object.hasOwn(store.gates, id)).map(id => {
      const gate = store.gates[id];
      if (!gate || typeof gate !== "object" || Array.isArray(gate)) return [id, gate];
      // Keep actionable gate fields; omit help_cmd to preserve the output budget.
      const { mo_ta, cmd, expect_exit, expect_regex } = gate;
      return [id, Object.fromEntries(Object.entries({ mo_ta, cmd, expect_exit, expect_regex }).filter(([, v]) => v !== undefined))];
    })),
    buoc_tiep_theo: best ? "Thực hiện bước 1 của quy trình, tuân thủ cổng và xác nhận bắt buộc." : "Hỏi người dùng quy trình phù hợp trước khi thao tác.",
    canh_bao: [...store.warnings.slice(0, 8), ...missingGates.map(id => "Thiếu định nghĩa cổng: " + id)],
  };
  const userMem = [...store.all.get("memory")!.values()].filter(x => x.fields.loai === "user");
  const relevantMem = searchKnowledge(store, "memory", input.yeu_cau, 5).map(x => x.item);
  // Five scored matches first; every user memory is included even with score 0.
  result.memory = [...relevantMem, ...userMem]
    .filter((v, i, a) => a.findIndex(x => x.id === v.id) === i)
    .map(x => compactItem(x, 180));
  if (input.project_root && opts.projectSummary) {
    try { result.du_an = JSON.stringify(opts.projectSummary(input.project_root)).slice(0, 500); }
    catch { result.du_an = "Chưa lấy được trạng thái dự án."; }
  }
  // Remove low-priority material first; never truncate the base law or selected process.
  while (size(result) > max) {
    const removableWarning = result.canh_bao.findIndex((x: string) => !x.startsWith("Thiếu định nghĩa cổng: "));
    const longMemory = result.memory.find((x: any) => x.noi_dung.length > 90);
    const longDescription = result.memory.find((x: any) => x.mo_ta.length > 90);
    if (removableWarning >= 0) result.canh_bao.splice(removableWarning, 1);
    else if (result.du_an) result.du_an = null;
    else if (result.ung_vien?.length > 1) result.ung_vien.pop();
    else if (result.can_hoi_lai?.goi_y?.length) result.can_hoi_lai.goi_y.pop();
    else if (result.ung_vien?.some((x: any) => x.khi_nao?.length > 40)) {
      const candidate = result.ung_vien.find((x: any) => x.khi_nao?.length > 40);
      candidate.khi_nao = candidate.khi_nao.slice(0, 40);
    }
    else if (result.quy_trinh?.ung_vien?.length) result.quy_trinh.ung_vien.pop();
    else if (longMemory) longMemory.noi_dung = longMemory.noi_dung.slice(0, Math.max(90, longMemory.noi_dung.length - 80));
    else if (longDescription) longDescription.mo_ta = longDescription.mo_ta.slice(0, 90);
    else if (result.bai_hoc.length) result.bai_hoc.pop();
    else if (result.memory.filter((x: any) => x.loai !== "user").length > 1) {
      const last = result.memory.findLastIndex((x: any) => x.loai !== "user");
      result.memory.splice(last, 1);
    } else if (Object.values(result.cong).some((x: any) => x && typeof x === "object" && x.mo_ta)) {
      const gate = Object.values(result.cong).find((x: any) => x && typeof x === "object" && x.mo_ta) as any;
      delete gate.mo_ta; // Never discard a required gate or its executable check.
    } else if (result.quy_trinh?.ghi_chu?.length) result.quy_trinh.ghi_chu = "";
    else if (result.buoc_tiep_theo.length) result.buoc_tiep_theo = "";
    else if (result.memory.some((x: any) => x.mo_ta.length > 20)) {
      const m = result.memory.find((x: any) => x.mo_ta.length > 20);
      m.mo_ta = m.mo_ta.slice(0, Math.max(20, m.mo_ta.length - 40));
    } else if (result.memory.some((x: any) => x.noi_dung.length > 0)) {
      const m = result.memory.find((x: any) => x.noi_dung.length > 0);
      m.noi_dung = m.noi_dung.slice(0, Math.max(0, m.noi_dung.length - 40));
    } else break;
  }
  if (size(result) > max) throw new Error("max_chars quá nhỏ để chứa nguyên vẹn luật nền và quy trình");
  return result;
}
export function listKnowledge(store: ReturnType<typeof loadKnowledge>, kind?: KnowledgeKind) {
  const types = kind ? [kind] : kinds;
  return types.flatMap(k => [...store.all.get(k)!.values()].map(x =>
    ({ id: x.id, loai: k, ten: x.fields.ten ?? x.fields.mo_ta ?? x.id, nguon: x.source })));
}
export function getKnowledge(store: ReturnType<typeof loadKnowledge>, kind: KnowledgeKind, id: string) {
  if (!safeId.test(id)) throw new Error("invalid id");
  const item = store.all.get(kind)!.get(id);
  return item ? { ...item.fields, body: item.body, source: item.source, kind } : null;
}
export function containsSensitive(text: string) {
  return /(?:[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})|(?:\b(?:\+?84|0)(?:[\s.-]?\d){9,10}\b)|(?:\b\d{9,12}\b)|(?:\b(?:sk-[a-z0-9_-]{12,}|ghp_[a-z0-9]{12,}|(?:api[_ -]?key|token|password|mat khau|mật khẩu)\s*[:=]\s*\S+))/iu.test(text);
}
export function memoryDocument(id: string, loai: string, mo_ta: string, noi_dung: string) {
  if (!safeId.test(id) || !["user", "feedback", "project", "reference"].includes(loai)) throw new Error("invalid id/loai");
  const combined = id + "\n" + loai + "\n" + mo_ta + "\n" + noi_dung;
  if (containsSensitive(combined)) throw new Error("Từ chối secret, số điện thoại, CCCD hoặc email.");
  if (/[\r\n]/.test(mo_ta) || mo_ta.length > 180 || noi_dung.length > 6000) throw new Error("Invalid memory length/description");
  return "---\nid: " + id + "\nloai: " + loai + "\nmo_ta: " + mo_ta + "\n---\n" + noi_dung.trim() + "\n";
}

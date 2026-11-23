// v0.24.44 — code_run: chạy một đoạn JavaScript gọi nhiều tool CHỈ ĐỌC của harness trong một lượt,
// chỉ trả giá trị cuối về client (nguyên lý "Code Mode").
//
// An toàn (nhiều lớp):
// 1. Mã chạy trong tiến trình con `node --permission` (cấm đọc/ghi tệp, cấm sinh tiến trình, cấm worker),
//    env rỗng — kể cả thoát được vm cũng không đọc tệp hay chạy lệnh trực tiếp được.
// 2. Bên trong tiến trình con, mã chạy trong vm context riêng, KHÔNG nhận đối tượng hay hàm nào của host:
//    host chỉ trao đổi chuỗi JSON qua hộp thư (outbox) do chính context tạo.
// 3. Mỗi lệnh tool bên trong đi qua đường gọi tool bình thường của harness (kiểm tham số zod, governor,
//    brain-only…) dưới đúng tên tool, và chỉ được phép nếu tool đó khai báo readOnly, không destructive,
//    không openWorld. code_run không gọi được chính nó.
// 4. Trần thời gian, trần số lệnh, trần số lệnh song song, trần độ dài kết quả.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { resolveNodeRunner } from "./sbce-verify.js";

export type CodeRunOptions = {
  code: string;
  timeoutMs?: number;
  maxCalls?: number;
  maxResultChars?: number;
};

export type CodeRunDeps = {
  /** Trả null nếu được phép, hoặc lý do từ chối. */
  checkTool: (name: string) => Promise<string | null>;
  /** Gọi tool qua đường gọi bình thường của harness, trả output MCP. */
  callTool: (name: string, args: Record<string, unknown>) => Promise<any>;
};

export type CodeRunCall = { name: string; ok: boolean; ms: number; error?: string };

export type CodeRunResult = {
  ok: boolean;
  value?: unknown;
  error?: string;
  truncated?: boolean;
  logs: string[];
  calls: CodeRunCall[];
  callCount: number;
  elapsedMs: number;
  codeSha256: string;
};

export const CODE_RUN_LIMITS = {
  timeoutMs: { def: 60_000, min: 1_000, max: 600_000 },
  maxCalls: { def: 50, min: 1, max: 200 },
  maxResultChars: { def: 8_000, min: 200, max: 50_000 },
  maxCodeChars: 20_000,
  maxConcurrency: 4,
  maxValueChars: 2_000_000,
  maxLogLines: 50,
  maxLogChars: 500,
  maxCallRecords: 100,
} as const;

const clamp = (v: number | undefined, l: { def: number; min: number; max: number }) =>
  Math.min(l.max, Math.max(l.min, Number.isFinite(v) ? Math.floor(v as number) : l.def));

/** Mã khởi tạo chạy BÊN TRONG vm context (realm riêng), không dùng đối tượng host. */
const CONTEXT_BOOTSTRAP = String.raw`(() => {
  const pending = new Map(); let seq = 0; const outbox = [];
  const send = (m) => { outbox.push(JSON.stringify(m)); };
  const callTool = (name, args) => new Promise((resolve, reject) => {
    const id = ++seq; pending.set(id, { resolve, reject });
    let a = args === undefined ? {} : args;
    send({ type: "call", id, name: String(name), args: JSON.parse(JSON.stringify(a)) });
  });
  const show = (x) => typeof x === "string" ? x : (() => { try { return JSON.stringify(x); } catch { return String(x); } })();
  globalThis.tools = new Proxy({}, { get: (_t, name) => typeof name === "string" ? (args) => callTool(name, args) : undefined });
  globalThis.callTool = callTool;
  globalThis.console = { log: (...a) => send({ type: "log", text: a.map(show).join(" ") }) };
  globalThis.console.error = globalThis.console.log; globalThis.console.warn = globalThis.console.log;
  globalThis.__drain = () => { const s = "[" + outbox.join(",") + "]"; outbox.length = 0; return s; };
  globalThis.__deliver = () => {
    const m = JSON.parse(String(globalThis.__in)); globalThis.__in = undefined;
    const p = pending.get(m.id); if (!p) return; pending.delete(m.id);
    if (m.ok) p.resolve(m.value); else p.reject(new Error(String(m.error)));
  };
  globalThis.__finish = (ok, v) => {
    let value; try { value = v === undefined ? null : JSON.parse(JSON.stringify(v)); } catch (e) { ok = false; value = "Kết quả không chuyển được sang JSON: " + String(e); }
    send(ok ? { type: "done", ok: true, value } : { type: "done", ok: false, error: String(v && v.stack || v).slice(0, 4000) });
  };
})();`;

/** Mã tiến trình con (CommonJS, chạy bằng `node --permission -e`). Không đọc tệp nào. */
export const CODE_RUN_CHILD_SOURCE = String.raw`
(() => {
const vm = require("node:vm");
if (!process.permission || process.permission.has("fs.read") || process.permission.has("child")) { try { process.send({ type: "done", ok: false, error: "Hộp cát --permission không bật được trên runtime này; từ chối chạy mã." }); } catch {} setTimeout(() => process.exit(0), 20); return; }
let ctx = null, timer = null, finished = false;
const fail = (msg) => { if (finished) return; finished = true; try { process.send({ type: "done", ok: false, error: msg }); } catch {} setTimeout(() => process.exit(0), 20); };
const pump = () => {
  if (!ctx || finished) return;
  let s;
  try { s = vm.runInContext("__drain()", ctx, { timeout: 1000 }); } catch (e) { return fail("Lỗi hộp thư: " + String(e && e.message || e)); }
  if (typeof s !== "string") return fail("Hộp thư bị sửa");
  let list; try { list = JSON.parse(s); } catch { return fail("Hộp thư hỏng"); }
  if (!Array.isArray(list)) return fail("Hộp thư bị sửa");
  for (const m of list) {
    if (!m || typeof m !== "object") continue;
    if (m.type === "done") { finished = true; process.send(m); setTimeout(() => process.exit(0), 20); return; }
    process.send(m);
  }
};
process.on("message", (m) => {
  if (!m || typeof m !== "object") return;
  if (m.type === "start" && !ctx) {
    ctx = vm.createContext(Object.create(null), { name: "code_run", codeGeneration: { strings: true, wasm: false } });
    try {
      vm.runInContext(m.bootstrap, ctx, { timeout: 1000 });
      const wrapped = "(async () => {\n" + String(m.code) + "\n})().then((v) => __finish(true, v), (e) => __finish(false, e));";
      vm.runInContext(wrapped, ctx, { timeout: Math.max(1000, Number(m.syncTimeoutMs) || 5000), filename: "code_run.js" });
    } catch (e) { return fail(String(e && e.stack || e).slice(0, 4000)); }
    timer = setInterval(pump, 5); pump();
  } else if (m.type === "reply" && ctx && !finished) {
    try { ctx.__in = String(m.payload); vm.runInContext("__deliver()", ctx, { timeout: 1000 }); }
    catch (e) { return fail("Lỗi trả kết quả tool: " + String(e && e.message || e)); }
    setImmediate(pump);
  }
});
process.on("disconnect", () => process.exit(0));
})();
`;

/** Rút giá trị dùng được từ output MCP của một tool. */
export function toolOutputValue(output: any): { ok: boolean; value?: unknown; error?: string } {
  const texts = Array.isArray(output?.content) ? output.content.filter((b: any) => b?.type === "text" && typeof b.text === "string").map((b: any) => b.text) : [];
  if (output?.isError) return { ok: false, error: (texts.join("\n") || "Tool báo lỗi").slice(0, 4000) };
  if (output?.structuredContent && typeof output.structuredContent === "object") return { ok: true, value: output.structuredContent };
  const text = texts.join("\n");
  try { return { ok: true, value: JSON.parse(text) }; } catch { return { ok: true, value: text }; }
}

export async function runCodeScript(options: CodeRunOptions, deps: CodeRunDeps): Promise<CodeRunResult> {
  const code = String(options.code ?? "");
  const started = Date.now();
  const codeSha256 = createHash("sha256").update(code, "utf8").digest("hex");
  const timeoutMs = clamp(options.timeoutMs, CODE_RUN_LIMITS.timeoutMs);
  const maxCalls = clamp(options.maxCalls, CODE_RUN_LIMITS.maxCalls);
  const maxResultChars = clamp(options.maxResultChars, CODE_RUN_LIMITS.maxResultChars);
  const logs: string[] = [];
  const calls: CodeRunCall[] = [];
  let callCount = 0;
  const base = () => ({ logs, calls, callCount, elapsedMs: Date.now() - started, codeSha256 });
  if (!code.trim()) return { ok: false, error: "code rỗng", ...base() };
  if (code.length > CODE_RUN_LIMITS.maxCodeChars) return { ok: false, error: `code dài quá ${CODE_RUN_LIMITS.maxCodeChars} ký tự`, ...base() };

  // Backend chạy dưới electron.exe: phải dùng node.exe thật (NHD_NODE_PATH / PATH), nếu không thì ELECTRON_RUN_AS_NODE.
  const runner = resolveNodeRunner();
  const child = spawn(runner.cmd, ["--permission", "-e", CODE_RUN_CHILD_SOURCE], {
    stdio: ["ignore", "ignore", "pipe", "ipc"], env: { ...runner.extraEnv }, windowsHide: true,
  });
  let stderr = "";
  child.stderr?.on("data", (b) => { stderr = (stderr + String(b)).slice(-2000); });

  return await new Promise<CodeRunResult>((resolveRun) => {
    let settled = false;
    let active = 0;
    const queue: Array<() => void> = [];
    const finish = (r: Omit<CodeRunResult, keyof ReturnType<typeof base>>) => {
      if (settled) return; settled = true; clearTimeout(wall);
      try { child.kill(); } catch { /* đã thoát */ }
      resolveRun({ ...r, ...base() });
    };
    const wall = setTimeout(() => finish({ ok: false, error: `Quá thời gian ${timeoutMs} ms, đã dừng tiến trình mã.` }), timeoutMs);
    const reply = (id: unknown, body: Record<string, unknown>) => {
      if (settled || !child.connected) return;
      let payload = JSON.stringify({ id, ...body });
      if (payload.length > CODE_RUN_LIMITS.maxValueChars) payload = JSON.stringify({ id, ok: false, error: `Kết quả tool lớn quá ${CODE_RUN_LIMITS.maxValueChars} ký tự; hãy lọc/giới hạn tham số.` });
      child.send({ type: "reply", payload });
    };
    const runCall = async (id: unknown, name: string, args: Record<string, unknown>) => {
      const t0 = Date.now();
      const record = (ok: boolean, error?: string) => {
        if (calls.length < CODE_RUN_LIMITS.maxCallRecords) calls.push({ name, ok, ms: Date.now() - t0, ...(error ? { error: error.slice(0, 300) } : {}) });
      };
      try {
        const denied = await deps.checkTool(name);
        if (denied) { record(false, denied); return reply(id, { ok: false, error: denied }); }
        const out = toolOutputValue(await deps.callTool(name, args));
        record(out.ok, out.error);
        reply(id, out.ok ? { ok: true, value: out.value } : { ok: false, error: out.error });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        record(false, msg); reply(id, { ok: false, error: msg });
      }
    };
    const schedule = (job: () => Promise<void>) => {
      const go = () => { active++; job().finally(() => { active--; queue.shift()?.(); }); };
      if (active < CODE_RUN_LIMITS.maxConcurrency) go(); else queue.push(go);
    };
    child.on("message", (m: any) => {
      if (settled || !m || typeof m !== "object") return;
      if (m.type === "log") {
        if (logs.length < CODE_RUN_LIMITS.maxLogLines) logs.push(String(m.text ?? "").slice(0, CODE_RUN_LIMITS.maxLogChars));
      } else if (m.type === "call") {
        const name = typeof m.name === "string" ? m.name : "";
        const args = m.args && typeof m.args === "object" && !Array.isArray(m.args) ? m.args as Record<string, unknown> : {};
        callCount++;
        if (callCount > maxCalls) { reply(m.id, { ok: false, error: `Vượt trần ${maxCalls} lệnh tool.` }); return; }
        schedule(() => runCall(m.id, name, args));
      } else if (m.type === "done") {
        if (!m.ok) return finish({ ok: false, error: String(m.error ?? "Mã lỗi") });
        const json = JSON.stringify(m.value ?? null);
        if (json.length <= maxResultChars) return finish({ ok: true, value: m.value ?? null });
        return finish({ ok: true, value: json.slice(0, maxResultChars), truncated: true });
      }
    });
    child.on("error", (e) => finish({ ok: false, error: "Không chạy được tiến trình mã: " + e.message }));
    child.on("exit", (code) => finish({ ok: false, error: `Tiến trình mã thoát (${code}) trước khi trả kết quả. ${stderr}`.trim() }));
    child.send({ type: "start", bootstrap: CONTEXT_BOOTSTRAP, code, syncTimeoutMs: Math.min(timeoutMs, 30_000) });
  });
}

/** Chính sách cho phép: chỉ tool khai báo readOnly, không destructive, không openWorld. */
export function codeRunToolAllowed(name: string, annotations: Record<string, unknown> | undefined): string | null {
  if (!name) return "Thiếu tên tool.";
  if (name === "code_run") return "code_run không được gọi lồng chính nó.";
  if (!annotations) return `Tool ${name} không tồn tại hoặc không khai báo annotations.`;
  // preview/prepare/propose cấp token xác nhận (bước đầu của ghi) — không cho chạy tự động trong code_run.
  if (/(^|_)(preview|prepare|propose|apply|confirm|approve|authorize)(_|$)/.test(name))
    return `Tool ${name} thuộc chuỗi xem trước/xác nhận ghi; code_run không được gọi.`;
  if (annotations.readOnlyHint !== true || annotations.destructiveHint === true || annotations.openWorldHint === true)
    return `Tool ${name} không phải tool chỉ đọc cục bộ; code_run chỉ được gọi tool chỉ đọc.`;
  return null;
}

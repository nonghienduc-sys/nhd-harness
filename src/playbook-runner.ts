import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, renameSync, unlinkSync, openSync, closeSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { loadKnowledge, getKnowledge, type BrainKitOptions } from "./brain-kit.js";
import { verifyReceiptChecks } from "./receipt-checks.js";

export type GateOutput = { code: number | null; stdout?: string; stderr?: string; timedOut?: boolean; completedAt?: string };
export type GateExecutor = (cmd: string, cwd: string, timeout: number, taskRunId?: string) => Promise<GateOutput>;
export type PlaybookInput = { op: "start" | "next" | "done_step" | "status" | "list" | "abort"; run_id?: string; quy_trinh_id?: string; muc_tieu?: string; bien?: Record<string,string>; so?: number; ghi_chu?: string; ly_do?: string; trang_thai?: string; task_run_id?: string };
type Step = { so: number; viec: string; cong: string[] };
type Run = { run_id: string; quy_trinh_id: string; muc_tieu: string; bien: Record<string,string>; buoc: Step[]; vi_tri: number; trang_thai: "running" | "completed" | "aborted"; tao_luc: string; cap_nhat_luc: string; ghi_chu?: string; lich_su: any[] };
const safeId = /^[a-zA-Z0-9][\w-]{0,99}$/;
const varKey = /^[a-zA-Z_]\w*$/;
const placeholders = /\{([a-zA-Z_]\w*)\}/g;
function varsOf(value?: Record<string,string>) {
  const out: Record<string,string> = {};
  if (value === undefined) return out;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("PLAYBOOK_INVALID_VARIABLES");
  for (const [key, val] of Object.entries(value)) {
    if (!varKey.test(key) || typeof val !== "string" || val.length > 5000 || /["'<>|;&\x60$\r\n%]/.test(val))
      throw Error("PLAYBOOK_INVALID_VARIABLE: " + key);
    out[key] = val;
  }
  return out;
}
function interpolate(cmd: string, vars: Record<string,string>) {
  const missing = [...new Set([...cmd.matchAll(placeholders)].map(m => m[1]).filter(k => !vars[k]))];
  return { cmd: missing.length ? cmd : cmd.replace(placeholders, (_, k: string) => vars[k]), missing };
}
function parseSteps(value: unknown): Step[] {
  if (!Array.isArray(value) || !value.length) throw Error("PLAYBOOK_STEPS_MISSING");
  return value.map((s: any, index) => {
    if (s?.so !== index + 1 || typeof s.viec !== "string" || !s.viec.trim()) throw Error("PLAYBOOK_INVALID_STEP");
    const gates = s.cong === undefined ? [] : Array.isArray(s.cong) ? s.cong : [s.cong];
    if (!gates.every((g: any) => typeof g === "string" && safeId.test(g))) throw Error("PLAYBOOK_INVALID_GATE");
    return { so: s.so, viec: s.viec, cong: gates };
  });
}
export class PlaybookRunner {
  readonly root: string;
  constructor(readonly opts: { dataDir: string; knowledge: BrainKitOptions; executeGate: GateExecutor }) {
    this.root = resolve(opts.dataDir, "playbook-runs"); mkdirSync(this.root, { recursive: true });
  }
  private path(id: string) {
    if (!/^pb-[a-f0-9-]{36}$/.test(id)) throw Error("PLAYBOOK_INVALID_RUN_ID");
    return join(this.root, id + ".json");
  }
  private read(id: string): Run {
    const p = this.path(id);
    if (!existsSync(p)) throw Error("PLAYBOOK_RUN_NOT_FOUND");
    return JSON.parse(readFileSync(p, "utf8"));
  }
  private save(run: Run) {
    const p = this.path(run.run_id), tmp = p + "." + randomUUID() + ".tmp";
    try { writeFileSync(tmp, JSON.stringify(run, null, 2) + "\n", { flag: "wx" }); renameSync(tmp, p); }
    finally { if (existsSync(tmp)) unlinkSync(tmp); }
  }
  private async lock<T>(id: string, work: () => Promise<T>) {
    const p = this.path(id) + ".lock";
    let fd: number;
    try { fd = openSync(p, "wx"); }
    catch {
      if (!existsSync(p) || Date.now() - statSync(p).mtimeMs < 600000) throw Error("PLAYBOOK_RUN_BUSY");
      unlinkSync(p); fd = openSync(p, "wx");
    }
    try { return await work(); } finally { closeSync(fd); unlinkSync(p); }
  }
  private knowledge() { return loadKnowledge(this.opts.knowledge); }
  private lessons(id: string) {
    return [...this.knowledge().all.get("bai_hoc")!.values()]
      .filter(x => x.fields.quy_trinh === id && x.fields.trang_thai === "da_duyet")
      .sort((a,b) => Number(b.fields.so_lan??0) - Number(a.fields.so_lan??0))
      .slice(0,8).map(x => ({ id: x.id, ma_loi: x.fields.ma_loi, noi_dung: x.body.slice(0,300) }));
  }
  private display(run: Run) {
    return { run_id: run.run_id, quy_trinh_id: run.quy_trinh_id, muc_tieu: run.muc_tieu, trang_thai: run.trang_thai,
      buoc_hien_tai: run.trang_thai === "running" ? run.buoc[run.vi_tri]?.so : null,
      da_xong: run.vi_tri, tong_buoc: run.buoc.length, tao_luc: run.tao_luc, cap_nhat_luc: run.cap_nhat_luc,
      lich_su: run.lich_su, ghi_chu: run.ghi_chu ?? null };
  }
  private gate(id: string, vars: Record<string,string>) {
    const gate = this.knowledge().gates[id];
    if (!gate || typeof gate.cmd !== "string" || !gate.cmd.trim()) throw Error("PLAYBOOK_GATE_MISSING: " + id);
    const command = interpolate(gate.cmd, vars);
    const working = gate.cwd === undefined ? {cmd: vars.tep && isAbsolute(vars.tep) ? dirname(vars.tep) : process.cwd(), missing: []} : interpolate(String(gate.cwd), vars);
    const missing = [...new Set([...command.missing, ...working.missing])];
    if (!missing.length && !isAbsolute(working.cmd)) throw Error("PLAYBOOK_CWD_INVALID: " + id);
    const timeout = gate.timeout_s === undefined ? 300 : Number(gate.timeout_s);
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > 1800) throw Error("PLAYBOOK_TIMEOUT_INVALID");
    return { cong: id, cmd: command.cmd, cwd: working.cmd, timeout_s: timeout,
      expect_exit: gate.expect_exit ?? 0, expect_regex: gate.expect_regex, thieu_bien: missing };
  }
  async handle(input: PlaybookInput): Promise<unknown> {
    if (input.op === "start") {
      if (!input.quy_trinh_id || !safeId.test(input.quy_trinh_id) || !input.muc_tieu?.trim()) throw Error("PLAYBOOK_START_ARGUMENTS_REQUIRED");
      const process = getKnowledge(this.knowledge(), "quy_trinh", input.quy_trinh_id);
      if (!process) throw Error("PLAYBOOK_PROCESS_NOT_FOUND");
      const now = new Date().toISOString();
      const run: Run = { run_id: "pb-" + randomUUID(), quy_trinh_id: input.quy_trinh_id, muc_tieu: input.muc_tieu.slice(0,2000),
        bien: varsOf(input.bien), buoc: parseSteps((process as Record<string, any>).buoc), vi_tri: 0, trang_thai: "running", tao_luc: now, cap_nhat_luc: now, lich_su: [] };
      this.save(run); return this.display(run);
    }
    if (input.op === "list") {
      const runs = readdirSync(this.root).filter(s => /^pb-[a-f0-9-]{36}\.json$/.test(s))
        .flatMap(s => { try { return [this.display(this.read(s.slice(0,-5)))]; } catch { return []; } });
      return { runs: input.trang_thai ? runs.filter(r => r.trang_thai === input.trang_thai) : runs };
    }
    if (!input.run_id) throw Error("PLAYBOOK_RUN_ID_REQUIRED");
    if (input.op === "status") return this.display(this.read(input.run_id));
    if (input.op === "next") {
      const run = this.read(input.run_id);
      return { ...this.display(run), buoc: run.trang_thai === "running" ? {
        ...run.buoc[run.vi_tri], lenh_cong: run.buoc[run.vi_tri].cong.map(g => this.gate(g,run.bien))
      } : null, bai_hoc: this.lessons(run.quy_trinh_id) };
    }
    if (input.op === "abort") return this.lock(input.run_id, async () => {
      const run = this.read(input.run_id!);
      if (run.trang_thai !== "running" || !input.ly_do?.trim()) throw Error("PLAYBOOK_ABORT_INVALID");
      run.trang_thai = "aborted"; run.ghi_chu = input.ly_do.slice(0,2000); run.cap_nhat_luc = new Date().toISOString(); this.save(run);
      return this.display(run);
    });
    if (input.op !== "done_step") throw Error("PLAYBOOK_UNKNOWN_OPERATION");
    return this.lock(input.run_id, async () => {
      const run = this.read(input.run_id!);
      if (run.trang_thai !== "running") throw Error("PLAYBOOK_NOT_RUNNING");
      const step = run.buoc[run.vi_tri];
      if (step.so !== input.so) throw Error("PLAYBOOK_STEP_OUT_OF_ORDER: expected " + step.so);
      const vars = { ...run.bien, ...varsOf(input.bien) };
      const gates = step.cong.map(g => this.gate(g, vars));
      const missing = [...new Set(gates.flatMap(g => g.thieu_bien))];
      if (missing.length) throw Error("PLAYBOOK_MISSING_VARIABLES: " + missing.join(", "));
      const evidences: any[] = [];
      for (const gate of gates) {
        const out = await this.opts.executeGate(gate.cmd,gate.cwd,gate.timeout_s,input.task_run_id);
        const at = out.completedAt ?? new Date().toISOString();
        const verified = verifyReceiptChecks([{
          cmd: gate.cmd,cwd:gate.cwd,expect_exit:gate.expect_exit,expect_regex:gate.expect_regex
        }], [{ at, action: "terminal_execute", detail: {
          command: gate.cmd,cwd:gate.cwd,code:out.code,timedOut:out.timedOut === true,
          stdout:out.stdout??"",stderr:out.stderr??"",completedAt:at
        }}]).checks[0].evidence;
        evidences.push({cong:gate.cong,cmd:gate.cmd,cwd:gate.cwd,
          exit:verified.exit_code??null,timed_out:verified.timed_out??false,
          output_tail:verified.output_tail??"",luc:at,dat:verified.passed});
        if (!verified.passed) break;
      }
      const passed = evidences.every(x=>x.dat);
      run.lich_su.push({so:step.so,luc:new Date().toISOString(),ghi_chu:input.ghi_chu?.slice(0,1000),ket_qua:evidences});
      if (passed) {run.vi_tri++;run.bien=vars;if(run.vi_tri>=run.buoc.length)run.trang_thai="completed";}
      run.cap_nhat_luc=new Date().toISOString();this.save(run);
      return {dat:passed,...this.display(run),ket_qua_cong:evidences,
        ...(passed?{}:{loi:"PLAYBOOK_GATE_FAILED",goi_y:this.lessons(run.quy_trinh_id)})};
    });
  }
}
export function terminalGateExecutor(terminal: { preview: (...args:any[])=>any; execute: (...args:any[])=>Promise<Record<string,unknown>> }): GateExecutor {
  return async (cmd,cwd,timeout,taskRunId) => {
    const p = terminal.preview(cmd,cwd,timeout,{},taskRunId);
    if (p.requiresUserConfirmationTurn || p.confirmationMode === "critical_phrase") throw Error("PLAYBOOK_GATE_CONFIRMATION_REQUIRED");
    const out = await terminal.execute(p.actionId,p.commandHash,p.confirmationToken);
    return {code:typeof out.code==="number"?out.code:null,stdout:String(out.stdout??""),
      stderr:String(out.stderr??""),timedOut:out.timedOut===true,completedAt:String(out.completedAt??new Date().toISOString())};
  };
}

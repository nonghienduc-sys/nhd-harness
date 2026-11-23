import { z } from "zod";
import { CODE_RUN_LIMITS, codeRunToolAllowed, runCodeScript } from "../code-run.js";
import { failure, readOnly, result, type ToolRegistryContext } from "./shared.js";

export type CodeRunWiring = {
  listTools: () => Promise<any[]>;
  innerCall: (name: string, args: Record<string, unknown>, extra: any) => Promise<any>;
  audit?: (detail: Record<string, unknown>) => void;
};

const DESCRIPTION = [
  "Run async JS that chains/parallelizes READ-ONLY local tools; only the returned value comes back.",
  "Call `await tools.fs_read({path})` or `callTool(name,args)`; tool errors throw.",
  "Each call returns the tool's structuredContent, uncompacted: fs_list {entries:[{name,path,type,size}]}, fs_read {text}, fs_search {hits:[{path,excerpt}]}, fs_stat {type,size,hash}.",
  `Writes, previews, terminal, browser are refused; each call passes the governor. No require/network. ${CODE_RUN_LIMITS.maxConcurrency} parallel calls.`,
].join(" ");

export function registerCodeRunTool(ctx: ToolRegistryContext, wiring: CodeRunWiring) {
  ctx.server.registerTool("code_run", {
    description: DESCRIPTION,
    inputSchema: {
      code: z.string().min(1).max(CODE_RUN_LIMITS.maxCodeChars),
      timeout_ms: z.number().int().min(CODE_RUN_LIMITS.timeoutMs.min).max(CODE_RUN_LIMITS.timeoutMs.max).optional(),
      max_calls: z.number().int().min(CODE_RUN_LIMITS.maxCalls.min).max(CODE_RUN_LIMITS.maxCalls.max).optional(),
      max_result_chars: z.number().int().min(CODE_RUN_LIMITS.maxResultChars.min).max(CODE_RUN_LIMITS.maxResultChars.max).optional(),
      task_run_id: z.string().max(256).optional(),
    },
    annotations: readOnly,
  }, async (input: any, extra: any) => {
    try {
      let annotationsByName: Map<string, Record<string, unknown> | undefined> | null = null;
      const annotationsOf = async (name: string) => {
        if (!annotationsByName) {
          const tools = await wiring.listTools();
          annotationsByName = new Map(tools.map((t: any) => [String(t.name), t.annotations && typeof t.annotations === "object" ? t.annotations : undefined]));
        }
        return annotationsByName.get(name);
      };
      const run = await runCodeScript({
        code: input.code, timeoutMs: input.timeout_ms, maxCalls: input.max_calls, maxResultChars: input.max_result_chars,
      }, {
        checkTool: async (name) => codeRunToolAllowed(name, await annotationsOf(name)),
        callTool: (name, args) => {
          const withRun = input.task_run_id && args.task_run_id === undefined ? { ...args, task_run_id: input.task_run_id } : args;
          return wiring.innerCall(name, withRun, extra);
        },
      });
      try {
        wiring.audit?.({ ok: run.ok, codeSha256: run.codeSha256, code: String(input.code).slice(0, 4000), callCount: run.callCount,
          calls: run.calls.map((c) => `${c.name}:${c.ok ? "ok" : "err"}`).slice(0, 50), elapsedMs: run.elapsedMs, error: run.error?.slice(0, 500) });
      } catch { /* audit best-effort */ }
      return run.ok ? result(run) : { ...result(run), isError: true };
    } catch (e) { return failure(e); }
  });
}

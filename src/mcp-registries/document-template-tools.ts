import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { z } from "zod";
import { isReleaseProtectedPath, isSystemProtectedPath } from "../files.js";
import { failure, result, readOnly, reversibleMutation, type ToolRegistryContext } from "./shared.js";

const TAIL_CHARS = 2000;
function tail(text: string) { return text.slice(-TAIL_CHARS); }

export async function runDocumentScript(python: string, script: string, args: string[]) {
  return await new Promise<{ exitCode: number; outputTail: string; timedOut: boolean }>((resolve) => {
    let output = "", ended = false, timedOut = false;
    const complete = (exitCode: number) => {
      if (ended) return; ended = true;
      resolve({ exitCode, outputTail: tail(output), timedOut });
    };
    const child = spawn(python, ["-I", script, ...args], {
      shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    });
    const collect = (chunk: Buffer) => { output = tail(output + chunk.toString("utf8")); };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);
    const timeout = setTimeout(() => { timedOut = true; child.kill(); }, 300_000);
    child.on("error", (error) => { clearTimeout(timeout); output = tail(output + String(error.message)); complete(-1); });
    child.on("close", (code) => { clearTimeout(timeout); complete(code ?? -1); });
  });
}
const sha256 = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

export function registerDocumentTemplateTools(ctx: ToolRegistryContext) {
  const { server, runtime } = ctx;
  const { config, files, store } = runtime;
  const configured = (key: "buildScript" | "formatCheckScript") => {
    const settings = config.documentTemplateTools ?? {};
    if (!settings.python || !settings[key]) throw new Error("Chưa cấu hình documentTemplateTools.python và documentTemplateTools." + key);
    return { python: settings.python, script: settings[key] };
  };
  const safeInput = (path: string) => {
    const resolved = files.resolvePath(path);
    if (!existsSync(resolved) || !statSync(resolved).isFile()) throw new Error("Input file does not exist.");
    return resolved;
  };
  server.registerTool("doc_from_template", {
    description: "Create a document from a template with a configured Python script; output must be within allowed roots.",
    inputSchema: {
      template: z.string().min(1), output: z.string().min(1),
      replacements_json: z.string().min(1), a4: z.boolean().optional(),
      overwrite: z.boolean().optional(), task_run_id: z.string().optional(),
    },
    annotations: reversibleMutation,
  }, async (input) => {
    try {
      if (!config.writeEnabled || config.emergencyStop) throw new Error("Document creation is disabled by writeEnabled/emergencyStop.");
      const { python, script } = configured("buildScript");
      const template = safeInput(input.template);
      const replacement = safeInput(input.replacements_json);
      const output = files.resolvePath(input.output);
      if (isReleaseProtectedPath(output) || isSystemProtectedPath(output)) throw new Error("Protected output path.");
      if (!isAbsolute(output)) throw new Error("Output must be an absolute path.");
      if (existsSync(output) && !input.overwrite) throw new Error("Output exists; set overwrite=true explicitly.");
      const args = [template, output, "--thay", replacement, ...(input.a4 ? ["--a4"] : [])];
      const outcome = await runDocumentScript(python, script, args);
      if (outcome.exitCode !== 0 || outcome.timedOut || !existsSync(output) || !statSync(output).isFile())
        throw new Error("Document build failed (exit=" + outcome.exitCode + ", timedOut=" + outcome.timedOut + "): " + outcome.outputTail);
      const hash = sha256(output);
      store.audit("doc_from_template", "ok", { exitCode: outcome.exitCode, sha256: hash });
      return result({ exitCode: outcome.exitCode, outputTail: outcome.outputTail, sha256: hash, output });
    } catch (error) {
      store.audit("doc_from_template", "error", { reason: error instanceof Error ? error.name : "error" });
      return failure(error);
    }
  });
  server.registerTool("doc_format_check", {
    description: "Read-only check of document format using a configured Python script.",
    inputSchema: {
      path: z.string().min(1), template: z.string().optional(), forbid: z.array(z.string()).optional(),
      task_run_id: z.string().optional(),
    },
    annotations: readOnly,
  }, async (input) => {
    try {
      const { python, script } = configured("formatCheckScript");
      const path = safeInput(input.path);
      const args = [path, ...(input.template ? ["--mau", safeInput(input.template)] : []),
        ...(input.forbid ?? []).flatMap((value) => ["--cam", value])];
      const outcome = await runDocumentScript(python, script, args);
      const verdict = outcome.outputTail.includes("TỔNG: ĐẠT") ? "DAT" : "LOI";
      const ok = outcome.exitCode === 0 && !outcome.timedOut;
      store.audit("doc_format_check", ok ? "ok" : "error", { exitCode: outcome.exitCode, verdict });
      return result({ verdict, exitCode: outcome.exitCode, outputTail: outcome.outputTail, timedOut: outcome.timedOut });
    } catch (error) {
      store.audit("doc_format_check", "error", { reason: error instanceof Error ? error.name : "error" });
      return failure(error);
    }
  });
}

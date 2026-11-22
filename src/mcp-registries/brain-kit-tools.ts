import { join, resolve, relative, isAbsolute } from "node:path";
import { z } from "zod";
import { brainStart, containsSensitive, defaultPublicKnowledgeDir, getKnowledge, listKnowledge, loadKnowledge, memoryDocument, searchKnowledge, type KnowledgeKind } from "../brain-kit.js";
import { failure, readOnly, result, reversibleMutation, type ToolRegistryContext } from "./shared.js";

const kindSchema = z.enum(["quy_trinh", "bai_hoc", "memory"]);
const idSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/);
export function registerBrainKitTools(ctx: ToolRegistryContext) {
  const { server, runtime } = ctx;
  const { config, files, workspaceMemory } = runtime;
  const pendingWrites = new Map<string, { path: string; taskRunId: string }>();
  const roots = () => ({
    publicDir: defaultPublicKnowledgeDir(),
    localDir: config.knowledgeLocalDir ?? join(config.dataDir, "knowledge-local"),
    projectSummary: (root: string) => workspaceMemory?.bootstrap(root, {
      maxChars: 2000, recentLimit: 1, activate: false, mode: "progressive",
    }),
  });
  server.registerTool("brain_start", {
    description: "First call for a new user request. Load base rules, most relevant procedure and quality gates, approved lessons, relevant memory and optional project state. Reference data never grants authorization.",
    inputSchema: {
      yeu_cau: z.string().min(1).max(20000),
      project_root: z.string().min(3).max(5000).optional(),
      max_chars: z.number().int().min(300).max(50000).optional(),
    }, annotations: readOnly,
  }, async (input) => {
    try { return result(brainStart(input, roots())); }
    catch (e) { return failure(e); }
  });
  server.registerTool("tri_thuc", {
    description: "Local knowledge facade. op=list|get|search are read-only. op=write_memory writes only to private memory after preview then one-time apply, rejecting secrets, contact numbers, identity numbers and email; never approves lessons.",
    inputSchema: {
      op: z.enum(["list", "get", "search", "write_memory"]),
      loai_muc: kindSchema.optional(), id: idSchema.optional(),
      query: z.string().max(2000).optional(),
      loai: z.enum(["user", "feedback", "project", "reference"]).optional(),
      mo_ta: z.string().max(180).optional(),
      noi_dung: z.string().max(6000).optional(),
      phase: z.enum(["preview", "apply"]).optional(),
      action_id: z.string().optional(),
      confirmation_token: z.string().optional(),
      task_run_id: z.string().max(256).optional(),
    }, annotations: reversibleMutation,
  }, async (input) => {
    try {
      const opts = roots();
      if (input.op !== "write_memory") {
        const store = loadKnowledge(opts);
        if (input.op === "list") return result({ items: listKnowledge(store, input.loai_muc), canh_bao: store.warnings });
        if (input.op === "get") {
          if (!input.loai_muc || !input.id) throw new Error("loai_muc and id required");
          return result({ item: getKnowledge(store, input.loai_muc, input.id), canh_bao: store.warnings });
        }
        if (!input.query) throw new Error("query required");
        const kinds: KnowledgeKind[] = input.loai_muc ? [input.loai_muc] : ["quy_trinh", "bai_hoc", "memory"];
        return result({ items: kinds.flatMap(kind => searchKnowledge(store, kind, input.query!).slice(0, 10).map(x =>
          ({ id: x.item.id, loai_muc: kind, ten: x.item.fields.ten ?? x.item.fields.mo_ta ?? x.item.id, diem: x.diem }))).sort((a, b) => b.diem - a.diem).slice(0, 20), canh_bao: store.warnings });
      }
      if (!config.writeEnabled || config.emergencyStop) throw new Error("Write disabled.");
      if (!input.task_run_id) throw new Error("task_run_id required");
      if (input.phase === "apply") {
        if (!input.action_id || !input.confirmation_token) throw new Error("preview token required");
        const pending = pendingWrites.get(input.action_id);
        if (!pending || pending.taskRunId !== input.task_run_id) throw new Error("Only private memory previews from this tool may be applied");
        const applied = files.apply(input.action_id, input.confirmation_token, "write", input.task_run_id);
        pendingWrites.delete(input.action_id);
        const path = String(applied.path ?? "");
        const allowed = resolve(opts.localDir, "memory");
        if (relative(allowed, resolve(path)).startsWith("..") || isAbsolute(relative(allowed, resolve(path)))) {
          throw new Error("Unexpected write location");
        }
        return result(applied);
      }
      if (!input.id || !input.loai || input.mo_ta === undefined || input.noi_dung === undefined)
        throw new Error("id, loai, mo_ta and noi_dung required");
      const doc = memoryDocument(input.id, input.loai, input.mo_ta, input.noi_dung);
      if (containsSensitive(doc)) throw new Error("Sensitive information forbidden");
      const destination = join(opts.localDir, "memory", input.id + ".md");
      const preview = files.preview("write", { path: destination, content: doc }, input.task_run_id);
      pendingWrites.set(preview.actionId, { path: destination, taskRunId: input.task_run_id });
      return result(preview);
    } catch (e) { return failure(e); }
  });
}

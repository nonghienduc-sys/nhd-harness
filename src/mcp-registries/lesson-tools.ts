import { join } from "node:path";
import { z } from "zod";
import { analyzeLessons, listLessons, proposeLesson, previewLessonDecision, applyLessonDecision, type LessonDecision } from "../lesson-loop.js";
import type { SelfEvolutionEngine } from "../self-evolution.js";
import { result, failure, reversibleMutation, type ToolRegistryContext } from "./shared.js";

const id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/);
const code = z.string().regex(/^[A-Z][A-Z0-9_]{2,63}$/);

/** All lesson mutations are confined to private knowledge, never public knowledge or the runtime. */
export function registerLessonTools(ctx: ToolRegistryContext, engine?: SelfEvolutionEngine | null) {
  const { server, runtime } = ctx;
  const { config, files, store, taskRuns } = runtime;
  const pending = new Map<string, { id: string; op: LessonDecision; taskRunId: string; path: string }>();
  const localDir = () => config.knowledgeLocalDir ?? join(config.dataDir, "knowledge-local");
  server.registerTool("bai_hoc", {
    description: "Learning loop facade. analyze/list read private feedback and lessons; propose records a recurring failure as a draft; approve/reject require a high-authorized durable task and explicit one-time preview/apply token. Never approve autonomously.",
    inputSchema: {
      op: z.enum(["analyze", "propose", "list", "approve", "reject"]),
      quy_trinh: id.optional(), ma_loi: code.optional(), id: id.optional(),
      noi_dung: z.string().max(1500).optional(),
      phase: z.enum(["preview", "apply"]).optional(),
      action_id: z.string().optional(),
      confirmation_token: z.string().optional(),
      task_run_id: z.string().max(256).optional(),
      skill_id: z.string().regex(/^[a-z0-9][a-z0-9-]{1,79}$/).optional(),
    }, annotations: reversibleMutation,
  }, async input => {
    try {
      if (input.op === "analyze") return result({ groups: analyzeLessons(localDir()) });
      if (input.op === "list") return result({ lessons: listLessons(localDir()) });
      if (config.emergencyStop || !config.writeEnabled) throw new Error("Write disabled");
      if (!input.task_run_id) throw new Error("task_run_id required");
      store.requireExistingTaskRun(input.task_run_id);
      if (input.op === "propose") {
        if (!input.quy_trinh || !input.ma_loi) throw new Error("quy_trinh and ma_loi required");
        return result(proposeLesson(localDir(), input.quy_trinh, input.ma_loi, input.noi_dung));
      }
      if (!input.id) throw new Error("id required");
      if (!taskRuns?.authorizations.allows(input.task_run_id, "high"))
        throw new Error("Explicit high-risk task authorization and human confirmation required.");
      if (input.phase === "apply") {
        if (!input.action_id || !input.confirmation_token) throw new Error("preview token required");
        const entry = pending.get(input.action_id);
        const applied = applyLessonDecision(localDir(), input.id, input.op, input.task_run_id,
          input.action_id, input.confirmation_token, entry, files, engine, input.skill_id);
        pending.delete(input.action_id);
        return result(applied);
      }
      const preview = previewLessonDecision(localDir(), input.id, input.op, input.task_run_id, files);
      pending.set(preview.actionId, { id: input.id, op: input.op, taskRunId: input.task_run_id, path: preview.path });
      return result(preview);
    } catch (error) { return failure(error); }
  });
}

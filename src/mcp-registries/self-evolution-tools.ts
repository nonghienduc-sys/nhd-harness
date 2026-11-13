import { z } from "zod";
import { SelfEvolutionEngine } from "../self-evolution.js";
import { readOnly, reversibleMutation, result, failure, type ToolRegistryContext } from "./shared.js";

/** The evolution engine can create staged skill candidates; never apply them. */
export function registerSelfEvolutionTools(ctx: ToolRegistryContext, engine: SelfEvolutionEngine) {
  const { server, runtime } = ctx;
  // Engine is shared with the global tool-failure observer.
  server.registerTool("self_evolution_status", {
    description: "Read NHD self-evolution telemetry status, metadata-only. There is no auto-apply or auto-promotion.",
    inputSchema: {}, annotations: readOnly
  }, async () => { try { return result(engine.status()); } catch(e) { return failure(e); } });
  server.registerTool("self_evolution_analyze", {
    description: "Analyze verified, deduplicated recurring feedback across distinct tasks; does not change skills.",
    inputSchema: { min_distinct_tasks: z.number().int().min(2).max(100).optional() }, annotations: readOnly
  }, async ({ min_distinct_tasks }) => { try { return result({ issues: engine.analyze(min_distinct_tasks ?? 2) }); } catch(e) { return failure(e); } });
  server.registerTool("self_evolution_record_feedback", {
    description: "Record one structured correction/QA outcome without raw conversation text. Requires an existing durable task; repeated event keys are deduplicated.",
    inputSchema: {
      task_run_id: z.string().min(1).max(256), skill_id: z.string().min(2).max(80),
      issue_code: z.string().min(3).max(64),
      outcome: z.enum(["failure","success"]),
      source: z.enum(["user_correction","verified_qa"]),
      verified: z.boolean(),
    }, annotations: reversibleMutation
  }, async (input) => { try {
    if (runtime.config.emergencyStop) throw new Error("Emergency Stop active.");
    if (!runtime.config.writeEnabled) throw new Error("Write permission is locked.");
    runtime.store.requireExistingTaskRun(input.task_run_id);
    const accepted = engine.recordFeedback({taskId: input.task_run_id,skillId: input.skill_id,issueCode: input.issue_code,outcome: input.outcome,source: input.source,verified:input.verified});
    return result(accepted);
  } catch(e) { return failure(e); } });
  server.registerTool("self_evolution_propose", {
    description: "Stage an append-only SKILL.md.candidate from repeated verified failures. Cannot edit live skills or deploy itself.",
    inputSchema: { task_run_id: z.string().min(1).max(256), skill_id: z.string().min(2).max(80), issue_code: z.string().min(3).max(64) },
    annotations: reversibleMutation
  }, async (input) => { try {
    if (runtime.config.emergencyStop) throw new Error("Emergency Stop active.");
    if (!runtime.config.writeEnabled) throw new Error("Write permission is locked.");
    runtime.store.requireExistingTaskRun(input.task_run_id);
    return result(engine.propose(input.skill_id,input.issue_code));
  } catch(e) { return failure(e); } });
  server.registerTool("self_evolution_evaluate", {
    description: "Check staged candidate integrity and conservative static rules; passing does not approve release.",
    inputSchema: { candidate_id: z.string().regex(/^[a-f0-9]{24}$/) }, annotations: readOnly
  }, async ({ candidate_id }) => { try { return result(engine.evaluate(candidate_id)); } catch(e) { return failure(e); } });
  return engine;
}

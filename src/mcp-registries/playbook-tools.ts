import { join } from "node:path";
import { z } from "zod";
import { defaultPublicKnowledgeDir } from "../brain-kit.js";
import { PlaybookRunner, terminalGateExecutor } from "../playbook-runner.js";
import { failure, result, reversibleMutation, type ToolRegistryContext } from "./shared.js";

export function registerPlaybookTools(ctx: ToolRegistryContext) {
  const { server, runtime } = ctx;
  const { config, terminal } = runtime;
  const runner = new PlaybookRunner({
    dataDir: config.dataDir,
    knowledge: { publicDir: defaultPublicKnowledgeDir(), localDir: config.knowledgeLocalDir ?? join(config.dataDir, "knowledge-local") },
    executeGate: terminalGateExecutor(terminal),
  });
  server.registerTool("quy_trinh_chay", {
    description: "Durable step-by-step playbook. op=start|next|done_step|status|list|abort. Only gates registered in local cong.json may be run; terminal policy and receipt-checks enforce gate verdicts.",
    inputSchema: {
      op: z.enum(["start","next","done_step","status","list","abort"]),
      run_id: z.string().max(120).optional(),
      quy_trinh_id: z.string().max(100).optional(),
      muc_tieu: z.string().max(2000).optional(),
      bien: z.record(z.string(),z.string().max(5000)).optional(),
      so: z.number().int().min(1).optional(),
      ghi_chu: z.string().max(1000).optional(),
      ly_do: z.string().max(2000).optional(),
      trang_thai: z.enum(["running","completed","aborted"]).optional(),
      task_run_id: z.string().max(256).optional(),
    },
    annotations: reversibleMutation,
  }, async input => {
    try {
      if (config.emergencyStop && ["start","done_step","abort"].includes(input.op)) throw Error("PLAYBOOK_EMERGENCY_STOP");
      if (input.op === "done_step" && (!config.terminalEnabled || !config.writeEnabled)) throw Error("PLAYBOOK_EXECUTION_DISABLED");
      if (["start","done_step","abort"].includes(input.op) && !config.writeEnabled) throw Error("PLAYBOOK_WRITE_DISABLED");
      return result(await runner.handle(input));
    } catch (error) { return failure(error); }
  });
}

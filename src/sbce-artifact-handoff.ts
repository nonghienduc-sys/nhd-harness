/** Brain-approved SBCE text draft -> guarded Windows FileService, never worker OS access. */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { win32 } from "node:path";
import type { ToolRegistryContext } from "./mcp-registries/shared.js";
import type { SbceProcess } from "./sbce-process.js";

const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const redactionMarker = ["[RED", "ACTED]"].join("");
const allowed = new Set([".txt", ".md", ".csv"]);
const jobPattern = /^job-[a-f0-9-]{36}$/;

export class SbceArtifactHandoff {
  constructor(private readonly ctx: ToolRegistryContext, private readonly executor: SbceProcess) {}

  private requireTask(id: string) {
    const { taskRuns, config } = this.ctx.runtime;
    if (!taskRuns) throw Error("SBCE_HANDOFF_TASK_RUNTIME_UNAVAILABLE");
    if (!config.writeEnabled || config.emergencyStop) throw Error("SBCE_HANDOFF_WRITES_DISABLED");
    if (this.executor.mode !== "on") throw Error("SBCE_HANDOFF_EXECUTOR_NOT_ON");
    const task = taskRuns.get(id);
    if (task.state !== "running") throw Error("SBCE_HANDOFF_TASK_NOT_RUNNING");
    if (!taskRuns.authorizations.allows(id, "moderate")) throw Error("SBCE_HANDOFF_AUTHORIZATION_REQUIRED");
    if (!task.root || !win32.isAbsolute(task.root)) throw Error("SBCE_HANDOFF_TASK_ROOT_REQUIRED");
    return win32.resolve(task.root);
  }

  private requireDestination(path: string, root: string) {
    if (!win32.isAbsolute(path)) throw Error("SBCE_HANDOFF_ABSOLUTE_PATH_REQUIRED");
    const target = win32.resolve(path), rel = win32.relative(root, target);
    if (!rel || rel.startsWith("..") || win32.isAbsolute(rel)) throw Error("SBCE_HANDOFF_OUTSIDE_TASK_ROOT");
    if (rel.split("\\").some(p => !p || p.startsWith(".") || /^(?:src|test|dist|releases|deploy-backups|runtime|node_modules)$/i.test(p))) {
      throw Error("SBCE_HANDOFF_PROTECTED_SEGMENT");
    }
    if (!allowed.has(win32.extname(target).toLowerCase())) throw Error("SBCE_HANDOFF_TEXT_EXTENSION_ONLY");
    const safe = this.ctx.runtime.files.resolvePath(target);
    if (safe.toLowerCase() !== target.toLowerCase()) throw Error("SBCE_HANDOFF_CANONICAL_PATH_MISMATCH");
    return safe;
  }

  private async requireAccepted(id: string, jobId: string) {
    if (!jobPattern.test(jobId)) throw Error("SBCE_HANDOFF_JOB_INVALID");
    const job = await this.executor.request("POST", "/jobs/" + jobId + "/status", { owner: id });
    if (job?.owner !== id || job.status !== "accepted") throw Error("SBCE_HANDOFF_BRAIN_ACCEPTANCE_REQUIRED");
    if (job.applyMode !== "apply_after_accept") throw Error("SBCE_HANDOFF_SANDBOX_ONLY_DENIED");
    if (!job.review?.artifacts?.draft) throw Error("SBCE_HANDOFF_NO_DRAFT");
    if (!Array.isArray(job.review.checks) || job.review.checks.some((c: {ok:boolean}) => c.ok !== true)) {
      throw Error("SBCE_HANDOFF_QUALITY_CHECKS_FAILED");
    }
  }

  private async readDraft(id: string, jobId: string) {
    let content = "", total: number | null = null;
    for (let i=0; i<9; i++) {
      const part = await this.executor.request("POST", "/jobs/"+jobId+"/pull", {
        owner:id, which:"draft", start_char:content.length, max_chars:8000
      });
      if (part?.job_id !== jobId || part.kind !== "draft" || part.offset !== content.length ||
          typeof part.text !== "string" || !Number.isSafeInteger(part.total_chars)) {
        throw Error("SBCE_HANDOFF_BAD_DRAFT_RESPONSE");
      }
      if (total===null) total=part.total_chars;
      if (total!==part.total_chars || (total??0)>64000) throw Error("SBCE_HANDOFF_TOO_LARGE_OR_CHANGED");
      content+=part.text;
      if (content.length>64000 || (part.truncated && part.text.length===0)) throw Error("SBCE_HANDOFF_TRUNCATED");
      if (!part.truncated) break;
    }
    if (!content || content.length!==total) throw Error("SBCE_HANDOFF_INCOMPLETE_OR_MASKED_DRAFT");
    if (content.includes("[HIDDEN]") || content.includes(redactionMarker)) throw Error("SBCE_HANDOFF_MASKED_CONTENT_DENIED");
    return content;
  }

  async preview(taskRunId: string, jobId: string, path: string) {
    const root=this.requireTask(taskRunId), dest=this.requireDestination(path,root);
    await this.requireAccepted(taskRunId,jobId);
    if (existsSync(dest)) throw Error("SBCE_HANDOFF_WOULD_OVERWRITE");
    const content=await this.readDraft(taskRunId,jobId);
    const staged=this.ctx.runtime.files.preview("write",{path:dest,content,noOverwrite:true},taskRunId);
    const token=this.ctx.runtime.store.createPending("sbce:artifact-handoff",{
      taskRunId,jobId,path:dest,fsActionId:staged.actionId,fsToken:staged.confirmationToken,
      sha256:sha(content),bytes:Buffer.byteLength(content,"utf8")
    },null,240);
    this.ctx.runtime.store.audit("sbce_artifact_handoff","preview",{taskRunId,jobId,path:dest,sha256:sha(content)});
    return {actionId:token.id,confirmationToken:token.confirmationToken,expiresAt:token.expiresAt,
      jobId,path:dest,bytes:Buffer.byteLength(content,"utf8"),sha256:sha(content),preview:"No Windows file modified yet."};
  }

  async apply(taskRunId:string,actionId:string,confirmationToken:string) {
    const {store,files}=this.ctx.runtime;
    const pending=store.getPending(actionId,confirmationToken);
    if (pending.kind!=="sbce:artifact-handoff" || pending.payload.taskRunId!==taskRunId) {
      throw Error("SBCE_HANDOFF_FOREIGN_PENDING_ACTION");
    }
    const root=this.requireTask(taskRunId),jobId=String(pending.payload.jobId);
    const path=this.requireDestination(String(pending.payload.path),root);
    await this.requireAccepted(taskRunId,jobId);
    const content=await this.readDraft(taskRunId,jobId);
    if (sha(content)!==pending.payload.sha256) throw Error("SBCE_HANDOFF_DRAFT_CHANGED");
    if (existsSync(path)) throw Error("SBCE_HANDOFF_WOULD_OVERWRITE");
    store.consumePending(actionId,confirmationToken);
    const result=files.apply(String(pending.payload.fsActionId),String(pending.payload.fsToken),"write",taskRunId);
    const host=files.stat(path);
    if (!result.applied || host.hash!==pending.payload.sha256 || host.size!==pending.payload.bytes) {
      throw Error("SBCE_HANDOFF_HOST_READBACK_MISMATCH");
    }
    const receipt={applied:true,verified:true,jobId,taskRunId,path,sha256:host.hash,bytes:host.size,hostReceipt:result};
    store.audit("sbce_artifact_handoff","verified",receipt);
    return receipt;
  }
}

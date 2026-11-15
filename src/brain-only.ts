import process from "node:process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const BRAIN_ONLY_MESSAGE = (name: string): string =>
  `BRAIN_ONLY: kết nối này chỉ làm Brain. Không tự chạy ${name}; hãy viết phiếu và giao qua delegate_task, rồi duyệt bằng review_pack.`;

export const BRAIN_ONLY_ALLOWED: readonly string[] = [
  "harness_mode",
  "delegate_task",
  "review_pack",
  "sbce_artifact_handoff",
  "workstation_health",
  "workstation_plan",
  "runtime_identity",
  "execution_info",
  "tool_governor",
  "project_open",
  "skills_registry",
  "intake_files",
  "self_evolution_feedback",
];

export const BRAIN_ONLY_PREFIXES: readonly string[] = ["context_", "task_"];

export const BRAIN_ONLY_TRANSPORTS: readonly string[] = ["remote-http", "openai-secure-tunnel"];

export const isBrainOnlyTransport = (
  transport: string,
  env: Record<string, string | undefined> = process.env,
): boolean => BRAIN_ONLY_TRANSPORTS.includes(transport) && env.NHD_BRAIN_ONLY !== "0";

export type BrainMode = "harness" | "self" | "direct";

export const brainModeFile = (env: Record<string, string | undefined> = process.env): string =>
  env.NHD_BRAIN_MODE_FILE && env.NHD_BRAIN_MODE_FILE.trim()
    ? env.NHD_BRAIN_MODE_FILE
    : resolve(process.cwd(), "runtime", "brain-mode.json");

type BrainModeRecord = { mode: BrainMode; updated_at: string };

const isValidBrainMode = (value: unknown): value is BrainMode =>
  value === "harness" || value === "self" || value === "direct";

export const readBrainMode = (file?: string): BrainMode => {
  const targetFile = file ?? brainModeFile();
  try {
    const raw = readFileSync(targetFile, "utf8");
    const parsed = JSON.parse(raw) as { mode?: unknown; updated_at?: unknown };
    if (!isValidBrainMode(parsed.mode)) return "harness";
    const value: BrainModeRecord = {
      mode: parsed.mode,
      updated_at: typeof parsed.updated_at === "string" ? parsed.updated_at : new Date().toISOString(),
    };
    return value.mode;
  } catch {
    return "harness";
  }
};

export const writeBrainMode = (mode: BrainMode, file?: string): BrainModeRecord => {
  if (!isValidBrainMode(mode)) throw new Error("INVALID_BRAIN_MODE");
  const targetFile = file ?? brainModeFile();
  const parentDir = dirname(targetFile);
  if (!existsSync(parentDir)) mkdirSync(parentDir, { recursive: true });
  const record: BrainModeRecord = { mode, updated_at: new Date().toISOString() };
  const tmpFile = `${targetFile}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmpFile, JSON.stringify(record), "utf8");
  renameSync(tmpFile, targetFile);
  return record;
};

export const isBrainOnlyActive = (
  env: Record<string, string | undefined> = process.env,
  file?: string,
): boolean => env.NHD_BRAIN_ONLY !== "0" && readBrainMode(file) === "harness";

export const brainOnlyAllows = (name: string): boolean =>
  BRAIN_ONLY_ALLOWED.includes(name) ||
  BRAIN_ONLY_PREFIXES.some((prefix) => name.startsWith(prefix));

/** Returns the standard denial response for disallowed Brain-only tools. */
export const brainOnlyDenied = (name: string) => ({
  content: [{ type: "text" as const, text: BRAIN_ONLY_MESSAGE(name) }],
  isError: true,
});

export const isDelegationBlocked = (
  env: Record<string, string | undefined> = process.env,
  file?: string,
): boolean => readBrainMode(file) === "self";

export const brainSelfDenied = (name: string) => ({
  content: [{ type: "text" as const, text: `BRAIN_SELF: chế độ Brain tự làm đang bật. Không giao việc cho model bé qua ${name}; hãy tự dùng công cụ NHD rồi tự kiểm tra kết quả.` }],
  isError: true,
});

/** Chế độ 3: không thực hiện thao tác workstation qua MCP, ngoại trừ khôi phục chế độ và chẩn đoán tối thiểu. */
export const isBrainDetached = (file?: string): boolean => readBrainMode(file) === "direct";
export const brainDetachedAllows = (name: string): boolean =>
  name === "harness_mode" || name === "runtime_identity" || name === "workstation_health";
export const brainDetachedDenied = (name: string) => ({
  content: [{ type: "text" as const, text: `BRAIN_DETACHED: chế độ 3 không dùng Harness để thực thi ${name}. Dùng harness_mode để chuyển chế độ sau khi được cấp quyền.` }],
  isError: true,
});

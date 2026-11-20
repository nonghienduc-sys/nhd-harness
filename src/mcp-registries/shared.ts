import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WorkstationRuntime } from "../workstation-runtime.js";
import type { ToolGovernorService } from "../tool-governor.js";
import type { RuntimeIdentityService } from "../runtime-identity.js";
import type { LocalIntelligenceService } from "../local-intelligence.js";
import type { WorkstationRouter } from "../router.js";
import type { TerminalSessionView } from "../terminal-session.js";
import type { UnifiedExecutionPlanner } from "../execution-planner.js";
import type { ResultPayloadGatewayService } from "../result-payload-gateway.js";
import type { ProjectRagService } from "../project-rag.js";

export const readOnly = { readOnlyHint: true, destructiveHint: false, openWorldHint: false } as const;
export const preview = { readOnlyHint: true, destructiveHint: false, openWorldHint: false } as const;
export const destructive = { readOnlyHint: false, destructiveHint: true, openWorldHint: false } as const;
export const reversibleMutation = { readOnlyHint: false, destructiveHint: false, openWorldHint: false } as const;
export const navigation = { readOnlyHint: false, destructiveHint: false, openWorldHint: false } as const;
export const webRead = { readOnlyHint: true, destructiveHint: false, openWorldHint: true } as const;
export const webNavigation = { readOnlyHint: false, destructiveHint: false, openWorldHint: true } as const;

export function result(value: unknown) {
  return { structuredContent: value as Record<string, unknown>, content: [{ type: "text" as const, text: JSON.stringify(value) }] };
}

export function compactResult(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }] };
}

export function failure(error: unknown) {
  return { isError: true, content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }] };
}

export function resultWithImages(value: any) {
  const single = value?.image ? [value.image] : [];
  const many = Array.isArray(value?.images) ? value.images : [];
  const images = [...single, ...many].filter((item) => item?.data && item?.mimeType);
  const structured = { ...value } as Record<string, unknown>;
  if (value?.image) { const { data: _data, ...meta } = value.image; structured.image = meta; }
  if (Array.isArray(value?.images)) structured.images = value.images.map(({ data: _data, ...meta }: any) => meta);
  return { structuredContent: structured, content: [{ type: "text" as const, text: JSON.stringify(structured) }, ...images.map((item: any) => ({ type: "image" as const, data: item.data, mimeType: item.mimeType }))] };
}

export function publicTerminalSession(session: TerminalSessionView) {
  const { env, ...rest } = session;
  return { ...rest, environmentNames: Object.keys(env).sort() };
}

export type ToolRegistryContext = {
  server: McpServer;
  connectionKey?: string | null;
  runtime: WorkstationRuntime;
  governor: ToolGovernorService;
  runtimeIdentity: RuntimeIdentityService;
  localAi: LocalIntelligenceService;
  workstationRouter: WorkstationRouter;
  executionPlanner: UnifiedExecutionPlanner;
  runtimeCapabilities: () => Promise<any>;
  resultPayloadGateway?: ResultPayloadGatewayService;
  projectRag?: ProjectRagService;
};


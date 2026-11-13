export type HarnessTransport = "remote-http" | "local-http" | "stdio-proxy" | "openai-secure-tunnel";

export type HarnessConnectionObservation = {
  harnessId?: string | null;
  connectionId?: string | null;
  transport: HarnessTransport;
  userAgent?: string | null;
};

type HarnessConnectionRecord = {
  key: string;
  harnessId: string;
  connectionId: string | null;
  transport: HarnessTransport;
  userAgent: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  requestCount: number;
};

type LocalIngressStatus = {
  enabled: boolean;
  host: "127.0.0.1";
  port: number;
  listening: boolean;
  lastError: string | null;
  startedAt: string | null;
};

function clean(value: unknown, fallback = "unknown", max = 180): string {
  const text = String(value ?? "").replace(/[\r\n\t]+/g, " ").trim();
  return (text || fallback).slice(0, max);
}

export class HarnessConnectionService {
  private readonly records = new Map<string, HarnessConnectionRecord>();
  private localIngress: LocalIngressStatus;

  constructor(localPort = 39104, enabled = true) {
    this.localIngress = { enabled, host: "127.0.0.1", port: localPort, listening: false, lastError: null, startedAt: null };
  }

  observe(input: HarnessConnectionObservation) {
    const harnessId = clean(input.harnessId, input.transport === "remote-http" ? "remote-mcp" : "local-harness", 120);
    const connectionId = input.connectionId ? clean(input.connectionId, "", 160) : null;
    const userAgent = input.userAgent ? clean(input.userAgent, "", 240) : null;
    const key = `${input.transport}:${connectionId || harnessId}`;
    const now = new Date().toISOString();
    const current = this.records.get(key);
    const next: HarnessConnectionRecord = current
      ? { ...current, harnessId, connectionId, userAgent: userAgent || current.userAgent, lastSeenAt: now, requestCount: current.requestCount + 1 }
      : { key, harnessId, connectionId, transport: input.transport, userAgent, firstSeenAt: now, lastSeenAt: now, requestCount: 1 };
    this.records.set(key, next);
    this.prune();
    return { ...next };
  }

  setLocalIngress(input: Partial<Pick<LocalIngressStatus, "enabled" | "port" | "listening" | "lastError" | "startedAt">>) {
    this.localIngress = { ...this.localIngress, ...input, host: "127.0.0.1" };
    return { ...this.localIngress };
  }

  private prune() {
    if (this.records.size <= 100) return;
    const sorted = [...this.records.values()].sort((a, b) => a.lastSeenAt.localeCompare(b.lastSeenAt));
    for (const row of sorted.slice(0, this.records.size - 100)) this.records.delete(row.key);
  }

  status(activeWindowMs = 5 * 60_000) {
    const now = Date.now();
    const connections = [...this.records.values()]
      .sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt))
      .map((row) => ({ ...row, active: now - new Date(row.lastSeenAt).getTime() <= activeWindowMs }));
    const active = connections.filter((row) => row.active);
    return {
      available: true,
      model: "multi-harness-single-core-v1",
      localIngress: { ...this.localIngress, mcpUrl: `http://127.0.0.1:${this.localIngress.port}/mcp` },
      connectionCount: connections.length,
      activeConnectionCount: active.length,
      activeHarnesses: [...new Set(active.map((row) => row.harnessId))],
      transports: [...new Set(active.map((row) => row.transport))],
      connections,
    };
  }
}

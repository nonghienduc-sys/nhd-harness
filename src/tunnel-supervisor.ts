import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadConfig } from "./config.js";
import { Store } from "./db.js";
import { TunnelService } from "./tunnel.js";

const config = loadConfig();
const store = new Store();
const tunnel = new TunnelService(config, store);
const controlPort = Number(process.env.WORKSTATION_TUNNEL_SUPERVISOR_PORT ?? (config.port + 3));
const secret = String(process.env.WORKSTATION_COMPANION_SECRET || config.companionSecret || "");
const startedAt = new Date().toISOString();
const statusPath = resolve(config.dataDir, "tunnel-supervisor-status.json");
let stopping = false;

function syncTunnelConfig() {
  const latest = loadConfig();
  config.tunnelEnabled = latest.tunnelEnabled;
  config.tunnelMode = latest.tunnelMode;
  config.namedTunnelName = latest.namedTunnelName;
  config.namedTunnelConfig = latest.namedTunnelConfig;
  config.publicHostname = latest.publicHostname;
  config.cloudflaredPath = latest.cloudflaredPath;
  config.emergencyStop = latest.emergencyStop;
}

function view() {
  return {
    ...tunnel.status(),
    instanceId: config.instanceId,
    lifecycle: "external-supervisor-v1",
    supervisor: {
      running: true,
      pid: process.pid,
      startedAt,
      controlPort,
    },
    updatedAt: new Date().toISOString(),
  };
}

function persist() {
  try {
    mkdirSync(config.dataDir, { recursive: true });
    writeFileSync(statusPath, JSON.stringify(view(), null, 2), { encoding: "utf8", mode: 0o600 });
  } catch {}
}

function json(response: ServerResponse, code: number, payload: unknown) {
  const body = JSON.stringify(payload);
  response.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(body);
}

function authorized(request: IncomingMessage) {
  return Boolean(secret) && request.headers["x-workstation-companion-secret"] === secret;
}

const server = createServer(async (request, response) => {
  if (request.socket.remoteAddress !== "127.0.0.1" && request.socket.remoteAddress !== "::1" && request.socket.remoteAddress !== "::ffff:127.0.0.1") {
    return json(response, 404, { error: "Not found" });
  }
  if (!authorized(request)) return json(response, 401, { error: "Unauthorized" });
  const path = String(request.url || "/").split("?", 1)[0];
  try {
    if (request.method === "GET" && path === "/status") {
      syncTunnelConfig();
      persist();
      return json(response, 200, view());
    }
    if (request.method === "POST" && path === "/start") {
      syncTunnelConfig();
      if (config.emergencyStop) return json(response, 409, { error: "Emergency Stop is active.", ...view() });
      config.tunnelEnabled = true;
      const result = tunnel.start();
      persist();
      return json(response, 200, { ...result, instanceId: config.instanceId, lifecycle: "external-supervisor-v1", supervisor: view().supervisor, updatedAt: new Date().toISOString() });
    }
    if (request.method === "POST" && path === "/stop") {
      config.tunnelEnabled = false;
      const result = tunnel.stop();
      persist();
      return json(response, 200, { ...result, instanceId: config.instanceId, lifecycle: "external-supervisor-v1", supervisor: view().supervisor, updatedAt: new Date().toISOString() });
    }
    return json(response, 404, { error: "Not found" });
  } catch (error) {
    persist();
    return json(response, 500, { error: error instanceof Error ? error.message : String(error), ...view() });
  }
});

server.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code === "EADDRINUSE") process.exit(0);
  console.error("Tunnel supervisor failed:", error);
  process.exit(1);
});

server.listen(controlPort, "127.0.0.1", () => {
  store.audit("tunnel_supervisor", "started", { pid: process.pid, controlPort });
  syncTunnelConfig();
  if (config.tunnelEnabled && !config.emergencyStop) tunnel.start();
  persist();
});

const statusTimer = setInterval(persist, 1000);
statusTimer.unref?.();

function exit(reason: string) {
  if (stopping) return;
  stopping = true;
  clearInterval(statusTimer);
  try { tunnel.stop(); } catch {}
  try { store.audit("tunnel_supervisor", "stopped", { reason, pid: process.pid }); } catch {}
  persist();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref?.();
}

process.on("SIGINT", () => exit("SIGINT"));
process.on("SIGTERM", () => exit("SIGTERM"));

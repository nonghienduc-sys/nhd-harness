import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";

const harnessId = String(process.env.NHD_MCP_HARNESS_ID || "local-stdio").trim().slice(0, 120) || "local-stdio";
const connectionId = String(process.env.NHD_MCP_CONNECTION_ID || `stdio-${process.pid}-${randomUUID()}`).trim().slice(0, 160);
const localPort = Number(process.env.WORKSTATION_MCP_LOCAL_PORT || process.env.NHD_MCP_LOCAL_PORT || 39104);
const target = String(process.env.NHD_MCP_LOCAL_URL || `http://127.0.0.1:${localPort}/mcp`).trim();

function emit(value: unknown) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function rpcError(id: unknown, message: string) {
  if (id === undefined) return;
  emit({ jsonrpc: "2.0", id: id ?? null, error: { code: -32000, message } });
}

function parseSse(text: string): unknown[] {
  const result: unknown[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const raw = line.slice(5).trim();
    if (!raw || raw === "[DONE]") continue;
    try { result.push(JSON.parse(raw)); } catch {}
  }
  return result;
}

async function forward(rawLine: string) {
  const line = rawLine.trim();
  if (!line) return;
  let message: any;
  try { message = JSON.parse(line); }
  catch (error) { process.stderr.write(`[nhd-stdio] invalid JSON input: ${error instanceof Error ? error.message : String(error)}\n`); return; }
  try {
    const response = await fetch(target, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "accept": "application/json, text/event-stream",
        "x-nhd-harness-id": harnessId,
        "x-nhd-connection-id": connectionId,
        "x-nhd-transport": "stdio-proxy",
        "user-agent": `nhd-mcp-stdio/${process.version}`,
      },
      body: line,
    });
    const body = await response.text();
    if (!response.ok) {
      const detail = body.trim().slice(0, 500);
      rpcError(message?.id, `NHD local MCP returned HTTP ${response.status}${detail ? `: ${detail}` : ""}`);
      return;
    }
    if (!body.trim()) return;
    const contentType = response.headers.get("content-type") || "";
    if (contentType.includes("text/event-stream")) {
      for (const item of parseSse(body)) emit(item);
      return;
    }
    try { emit(JSON.parse(body)); }
    catch { rpcError(message?.id, "NHD local MCP returned a non-JSON response."); }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[nhd-stdio] local MCP unavailable at ${target}: ${detail}\n`);
    rpcError(message?.id, `NHD local MCP unavailable: ${detail}`);
  }
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity, terminal: false });
rl.on("line", (line) => { void forward(line); });
rl.on("close", () => { process.exitCode = 0; });
process.on("SIGINT", () => rl.close());
process.on("SIGTERM", () => rl.close());

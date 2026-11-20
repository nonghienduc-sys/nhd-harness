import { createHash } from "node:crypto";

type ClientRecord = { name: string; version: string; at: number };
const clients = new Map<string, ClientRecord>();
const LIMIT = 500;
const IDLE_MS = 2 * 60 * 60 * 1000;

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

/** The request may be stateless. Resolve a stable key without retaining bearer values or IP. */
export function resolveMcpClientIdentityKey(input: {
  sessionId?: string | null;
  authorization?: string | null;
  authenticatedBearer?: boolean;
  connectionKey?: string | null;
}): string | null {
  const session = input.sessionId?.trim();
  if (session) return "session:" + shortHash(session);
  const bearer = input.authenticatedBearer === true
    ? /^Bearer\s+([^\s]+)\s*$/i.exec(input.authorization ?? "")?.[1]
    : null;
  if (bearer) return "bearer:" + shortHash(bearer);
  return input.connectionKey?.trim() || null;
}

export function rememberMcpClient(connectionKey: string, clientInfo: unknown): void {
  if (!connectionKey || !clientInfo || typeof clientInfo !== "object") return;
  const info = clientInfo as Record<string, unknown>;
  if (typeof info.name !== "string" || typeof info.version !== "string") return;
  clients.set(connectionKey, { name: info.name.slice(0, 96), version: info.version.slice(0, 40), at: Date.now() });
  if (clients.size > LIMIT) {
    const expired = Date.now() - IDLE_MS;
    for (const [key, value] of clients) if (value.at < expired || clients.size > LIMIT) clients.delete(key);
  }
}

export function getMcpClient(connectionKey?: string | null): { name: string; version: string } | null {
  const value = connectionKey ? clients.get(connectionKey) : undefined;
  if (!value || Date.now() - value.at > IDLE_MS) return null;
  return { name: value.name, version: value.version };
}

/** Read-only, intentionally returns only the declared name/version, not keys or addresses. */
export function observedMcpClients(): Array<{ name: string; version: string }> {
  const entries = [...clients.values()].filter(item => Date.now() - item.at <= IDLE_MS)
    .sort((a, b) => b.at - a.at);
  const result: Array<{ name: string; version: string }> = [];
  const unique = new Set<string>();
  let remainingChars = 850;
  for (const item of entries) {
    const key = item.name + "\0" + item.version;
    if (unique.has(key)) continue;
    unique.add(key);
    const entry = { name: item.name, version: item.version };
    const size = JSON.stringify(entry).length + 1;
    if (size > remainingChars) continue;
    result.push(entry);
    remainingChars -= size;
    if (result.length >= 20) break;
  }
  return result;
}

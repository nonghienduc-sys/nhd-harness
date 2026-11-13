import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export const DEFAULT_CODEX_CONFIG_PATH = resolve(process.env.NHD_CODEX_CONFIG_PATH || join(homedir(), ".codex", "config.toml"));
export const MAX_CODEX_CONFIG_BYTES = 256 * 1024;
export const BASELINE_NHD_CATALOG_FINGERPRINT = "sha256:267A3B38A03B2CFE3CA1E0D260633E399CEF2D2CE3399B25AF8056186E00803E";

export type ClientMcpGuardState = "ok" | "duplicate" | "unavailable" | "malformed";
export type ClientMcpGuardView = {
  available: boolean;
  configPath: string;
  state: ClientMcpGuardState;
  duplicateNhd: boolean;
  nhdEntryCount: number;
  nhdEntries: string[];
  knownEndpointCount: number;
  canonicalTargetHints: string[];
  catalogFingerprint: string;
  checkedAt: string;
  error: string | null;
};

type ParsedEntry = { name: string; url: string };

export function canonicalizeMcpUrl(input: unknown): string | null {
  const raw = String(input ?? "").trim();
  if (!raw) return null;
  try {
    const u = new URL(raw);
    const protocol = u.protocol.toLowerCase();
    if (protocol !== "http:" && protocol !== "https:") return null;
    let host = u.hostname.toLowerCase();
    const bare = host.replace(/^\[|\]$/g, "");
    if (bare === "localhost" || bare === "::1" || bare === "127.0.0.1") host = "127.0.0.1";
    let port = u.port;
    if ((protocol === "http:" && port === "80") || (protocol === "https:" && port === "443")) port = "";
    let path = u.pathname || "/";
    if (path.length > 1) path = path.replace(/\/+$/, "") || "/";
    const authority = host.includes(":") && host !== "127.0.0.1" ? `[${host}]` : host;
    return `${protocol}//${authority}${port ? `:${port}` : ""}${path}${u.search}`;
  } catch {
    return null;
  }
}

function parseCodexMcpUrls(text: string): { entries: ParsedEntry[]; malformed: string[] } {
  const entries: ParsedEntry[] = [];
  const malformed: string[] = [];
  let section: string | null = null;
  const sectionPattern = /^\s*\[\s*mcp_servers\.(?:"([^"]+)"|'([^']+)'|([^\]\s]+))\s*\]\s*(?:#.*)?$/;
  const urlPattern = /^\s*url\s*=\s*(?:"([^"]+)"|'([^']+)')\s*(?:#.*)?$/;
  for (const rawLine of text.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("[")) {
      const match = rawLine.match(sectionPattern);
      section = match ? String(match[1] ?? match[2] ?? match[3] ?? "").trim() : null;
      continue;
    }
    if (!section || !/^\s*url\s*=/.test(rawLine)) continue;
    const match = rawLine.match(urlPattern);
    if (!match) {
      malformed.push(section);
      continue;
    }
    const value = String(match[1] ?? match[2] ?? "").trim();
    if (!canonicalizeMcpUrl(value)) {
      malformed.push(section);
      continue;
    }
    entries.push({ name: section.slice(0, 120), url: value });
  }
  return { entries, malformed: [...new Set(malformed)].sort() };
}

export function inspectCodexMcpConfig(input: {
  configPath?: string;
  knownEndpoints?: Array<string | null | undefined>;
  catalogFingerprint?: string;
  maxBytes?: number;
} = {}): ClientMcpGuardView {
  const configPath = resolve(input.configPath || DEFAULT_CODEX_CONFIG_PATH);
  const checkedAt = new Date().toISOString();
  const maxBytes = Math.max(1, Math.min(Number(input.maxBytes ?? MAX_CODEX_CONFIG_BYTES), MAX_CODEX_CONFIG_BYTES));
  const known = [...new Set((input.knownEndpoints ?? []).map(canonicalizeMcpUrl).filter((x): x is string => Boolean(x)))].sort();
  const base = {
    configPath,
    knownEndpointCount: known.length,
    canonicalTargetHints: known,
    catalogFingerprint: input.catalogFingerprint || BASELINE_NHD_CATALOG_FINGERPRINT,
    checkedAt,
  };
  try {
    if (!existsSync(configPath)) return { available: false, state: "unavailable", duplicateNhd: false, nhdEntryCount: 0, nhdEntries: [], error: "Codex MCP config was not found.", ...base };
    const stat = statSync(configPath);
    if (!stat.isFile()) return { available: false, state: "unavailable", duplicateNhd: false, nhdEntryCount: 0, nhdEntries: [], error: "Codex MCP config path is not a file.", ...base };
    if (stat.size > maxBytes) return { available: false, state: "unavailable", duplicateNhd: false, nhdEntryCount: 0, nhdEntries: [], error: `Codex MCP config exceeds the ${maxBytes}-byte guard limit.`, ...base };
    const parsed = parseCodexMcpUrls(readFileSync(configPath, "utf8"));
    const knownSet = new Set(known);
    const nhdEntries = parsed.entries.filter((row) => knownSet.has(canonicalizeMcpUrl(row.url) ?? "")).map((row) => row.name).sort();
    const duplicateNhd = nhdEntries.length > 1;
    const state: ClientMcpGuardState = duplicateNhd ? "duplicate" : parsed.malformed.length ? "malformed" : "ok";
    const error = parsed.malformed.length ? `Malformed MCP URL field in section(s): ${parsed.malformed.join(", ")}.` : null;
    return { available: true, state, duplicateNhd, nhdEntryCount: nhdEntries.length, nhdEntries, error, ...base };
  } catch (error) {
    return { available: false, state: "unavailable", duplicateNhd: false, nhdEntryCount: 0, nhdEntries: [], error: error instanceof Error ? error.message : String(error), ...base };
  }
}

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

export type ResultPayloadGatewayDecision = {
  output: unknown;
  compacted: boolean;
  originalChars: number;
  compactedChars: number;
  artifactPath: string | null;
  artifactSha256: string | null;
  reason: string;
};

type GatewayOptions = {
  enabled?: boolean;
  artifactRoot: string;
  thresholdChars?: number;
  previewStringChars?: number;
  arrayItems?: number;
  chunkChars?: number;
  maxArtifacts?: number;
  maxAgeMs?: number;
  safeTools?: string[];
};

const DEFAULT_SAFE_TOOLS = ["pdf_document", "context_recall", "office_read"];
const ARTIFACT_ID = /^[a-f0-9]{64}$/;

function serialized(value: unknown): string { return JSON.stringify(value); }
function hasImageContent(output: any): boolean { return Array.isArray(output?.content) && output.content.some((item: any) => item?.type === "image"); }
function hasError(output: any): boolean { return Boolean(output?.isError); }
function normalizeQuery(value: string): string { return value.toLocaleLowerCase("vi-VN").replace(/\s+/g, " ").trim(); }

function compactValue(value: unknown, maxString: number, maxArray: number, depth = 0): unknown {
  if (depth > 8) return "[NHD depth-compacted]";
  if (typeof value === "string") {
    if (value.length <= maxString) return value;
    const head = Math.max(256, Math.floor(maxString * 0.72));
    const tail = Math.max(128, maxString - head);
    return `${value.slice(0, head)}\n[NHD compacted ${value.length - head - tail} chars]\n${value.slice(-tail)}`;
  }
  if (Array.isArray(value)) {
    if (value.length <= maxArray) return value.map((item) => compactValue(item, maxString, maxArray, depth + 1));
    const headCount = Math.max(1, Math.ceil(maxArray * 0.7));
    const tailCount = Math.max(1, maxArray - headCount);
    return [
      ...value.slice(0, headCount).map((item) => compactValue(item, maxString, maxArray, depth + 1)),
      { _nhdCompactedItems: value.length - headCount - tailCount },
      ...value.slice(-tailCount).map((item) => compactValue(item, maxString, maxArray, depth + 1)),
    ];
  }
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, compactValue(item, maxString, maxArray, depth + 1)]));
  return value;
}

// v0.24.11: tóm tắt trường vô hướng quan trọng để client không phải gọi lại chỉ để biết trạng thái.
const DIGEST_KEYS = new Set(["state", "status", "available", "healthy", "version", "productionVersion", "failureCount", "errors", "lastError", "deepHealthRequired", "running", "online", "enabled", "currentMatchesActive", "count", "total", "ok", "mode", "url", "pageCount", "totalChars"]);
export function scalarDigest(value: unknown, maxChars = 1_200): string {
  const parts: string[] = [];
  let used = 0;
  const queue: Array<{ node: unknown; path: string; depth: number }> = [{ node: value, path: "", depth: 0 }];
  while (queue.length && used < maxChars) {
    const { node, path, depth } = queue.shift()!;
    if (!node || typeof node !== "object" || Array.isArray(node) || depth > 3) continue;
    for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
      const childPath = path ? `${path}.${key}` : key;
      if (child !== null && typeof child === "object") { if (!Array.isArray(child)) queue.push({ node: child, path: childPath, depth: depth + 1 }); continue; }
      if (!DIGEST_KEYS.has(key)) continue;
      const text = `${childPath}=${typeof child === "string" ? child.slice(0, 120) : String(child)}`;
      if (used + text.length + 2 > maxChars) { used = maxChars; break; }
      parts.push(text); used += text.length + 2;
    }
  }
  return parts.join("; ");
}

// v0.24.13: client chỉ đọc text vẫn thấy bằng chứng recall hàng đầu.
export function recallEvidenceText(structured: any, maxItems = 5, maxChars = 280): string {
  const results = Array.isArray(structured?.results) ? structured.results : [];
  return results.slice(0, maxItems).map((item: any, index: number) => {
    const when = typeof item?.updatedAt === "string" ? item.updatedAt.slice(0, 10) : "";
    const body = String(item?.text ?? "").replace(/\s+/g, " ").trim();
    return `[${index + 1}] ${item?.kind ?? "item"} ${item?.id ?? ""}${when ? ` (${when})` : ""}: ${body.length > maxChars ? body.slice(0, maxChars) + "…" : body}`;
  }).join("\n");
}

function compactPdfPreview(output: any, maxString: number): unknown {
  const structured = output?.structuredContent;
  if (!structured || typeof structured !== "object" || Array.isArray(structured)) return compactValue(output, Math.min(maxString, 1_600), 4);
  const source = structured as Record<string, unknown>;
  const pages = Array.isArray(source.pages) ? source.pages : [];
  const pageTextChars = Math.max(500, Math.min(maxString, 1_000));
  const compactPage = (page: any) => {
    if (!page || typeof page !== "object") return compactValue(page, pageTextChars, 4);
    const item: Record<string, unknown> = {};
    for (const key of ["page", "characters", "scanned"]) if (key in page) item[key] = page[key];
    if (typeof page.text === "string") item.text = compactValue(page.text, pageTextChars, 4);
    return item;
  };
  let pagePreview: unknown[] = [];
  if (pages.length <= 3) pagePreview = pages.map(compactPage);
  else {
    const middle = Math.floor((pages.length - 1) / 2);
    pagePreview = [compactPage(pages[0]), { _nhdCompactedItems: pages.length - 3, _nhdRange: `2-${pages.length - 1}` }, compactPage(pages[middle]), compactPage(pages[pages.length - 1])];
  }
  const metadata: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    if (key === "pages") continue;
    metadata[key] = compactValue(value, Math.min(maxString, 1_600), 6);
  }
  return {
    ...metadata,
    pages: pagePreview,
    _nhdPreview: {
      strategy: "pdf-first-middle-last-v1",
      originalPageItems: pages.length,
      rawContentRepresentationOmitted: Array.isArray(output?.content) ? output.content.length : 0,
      note: "Use context_payload_artifact search/pack/read for evidence outside the bounded preview.",
    },
  };
}

type OfficeEvidenceUnit = { path: string; text: string };
function officeValueText(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value === "object") {
    const item = value as Record<string, unknown>;
    if ("formula" in item) return `formula=${String(item.formula ?? "")} result=${officeValueText(item.result)}`;
    if ("text" in item) return String(item.text ?? "");
    try { return JSON.stringify(value); } catch { return String(value); }
  }
  return String(value);
}
function officeEvidenceUnits(output: any): OfficeEvidenceUnit[] {
  const source = output?.structuredContent;
  if (!source || typeof source !== "object" || Array.isArray(source)) return [];
  const units: OfficeEvidenceUnit[] = [];
  const kind = String(source.kind ?? "");
  if (kind === "docx") {
    const paragraphs = String(source.text ?? "").split(/\n+/).map((item) => item.replace(/\s+/g, " ").trim()).filter(Boolean);
    paragraphs.forEach((text, index) => units.push({ path: `paragraph:${index + 1}`, text }));
    if (Array.isArray(source.tables)) source.tables.forEach((table: any, tableIndex: number) => {
      if (!Array.isArray(table?.rows)) return;
      table.rows.forEach((row: any, rowIndex: number) => {
        if (!Array.isArray(row?.cells)) return;
        row.cells.forEach((cell: any, cellIndex: number) => {
          const text = officeValueText(cell?.text).replace(/\s+/g, " ").trim();
          if (text) units.push({ path: `table:${Number(table?.table ?? tableIndex + 1)}/R${Number(row?.row ?? rowIndex + 1)}C${Number(cell?.cell ?? cellIndex + 1)}`, text });
        });
      });
    });
  } else if (kind === "xlsx") {
    if (Array.isArray(source.sheets)) source.sheets.forEach((sheet: any, sheetIndex: number) => {
      const name = String(sheet?.name ?? `Sheet${sheetIndex + 1}`);
      if (!Array.isArray(sheet?.rows)) return;
      sheet.rows.forEach((row: any, rowIndex: number) => {
        if (!Array.isArray(row)) return;
        const cells = row.map((value: unknown, cellIndex: number) => {
          const text = officeValueText(value).replace(/\s+/g, " ").trim();
          return text ? `C${cellIndex}=${text}` : "";
        }).filter(Boolean);
        if (cells.length) units.push({ path: `sheet:${name}!R${rowIndex + 1}`, text: cells.join(" | ") });
      });
    });
  } else if (kind === "pptx") {
    if (Array.isArray(source.slides)) source.slides.forEach((slide: any, index: number) => {
      const text = officeValueText(slide?.text).replace(/\s+/g, " ").trim();
      if (text) units.push({ path: `slide:${index + 1}:${String(slide?.slide ?? "")}`, text });
    });
  }
  const seen = new Set<string>();
  return units.filter((unit) => {
    const key = `${unit.path}|${normalizeQuery(unit.text)}`;
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
}
function rankOfficeEvidence(output: any, query: string, limit = 8, maxChars = 10_000) {
  const normalized = normalizeQuery(query);
  const terms = [...new Set(normalized.split(/[^\p{L}\p{N}_-]+/u).filter((term) => term.length >= 2))].slice(0, 16);
  const units = officeEvidenceUnits(output);
  const df = new Map<string, number>();
  for (const term of terms) df.set(term, units.reduce((count, unit) => count + (normalizeQuery(unit.text).includes(term) ? 1 : 0), 0));
  const candidates = units.map((unit) => {
    const lower = normalizeQuery(unit.text); let matched = 0, weighted = 0; const positions: number[] = [];
    for (const term of terms) { const at = lower.indexOf(term); if (at < 0) continue; matched += 1; positions.push(at); weighted += Math.log((units.length + 1) / ((df.get(term) ?? 0) + 1)) + 1; }
    if (!matched) return null;
    const exact = lower.includes(normalized) ? 500 : 0; let orderedBonus = 0;
    if (positions.length >= 2) { let ordered = true; for (let i = 1; i < positions.length; i++) if (positions[i] < positions[i - 1]) { ordered = false; break; } if (ordered) { const span = positions.at(-1)! - positions[0] + 1; orderedBonus = 120 + Math.max(0, 180 - Math.floor(span / 3)); } }
    const coverage = terms.length ? matched / terms.length : 0;
    let at = lower.indexOf(normalized); if (at < 0) at = positions.length ? Math.min(...positions) : 0;
    const contextChars = 1_800; const start = Math.max(0, at - Math.floor(contextChars * 0.35)); const snippet = unit.text.slice(start, Math.min(unit.text.length, start + contextChars));
    return { path: unit.path, score: exact + orderedBonus + weighted * 25 + coverage * 300, snippet };
  }).filter(Boolean) as Array<{ path: string; score: number; snippet: string }>;
  candidates.sort((a,b) => b.score - a.score || a.path.localeCompare(b.path));
  const evidence: Array<{ path: string; score: number; snippet: string }> = []; const boundedMax = Math.max(1_000, Math.min(Math.trunc(maxChars), 24_000)); let used = 0;
  for (const candidate of candidates) {
    if (evidence.length >= Math.max(1, Math.min(Math.trunc(limit), 20))) break;
    const header = `[${evidence.length + 1}] ${candidate.path}\n`; const separator = evidence.length ? "\n\n" : ""; const remaining = boundedMax - used - header.length - separator.length; if (remaining <= 120) break;
    const snippet = candidate.snippet.slice(0, remaining); if (!snippet.trim()) continue;
    evidence.push({ path: candidate.path, score: Number(candidate.score.toFixed(3)), snippet }); used += separator.length + header.length + snippet.length;
  }
  return { query, unitCount: units.length, evidenceCount: evidence.length, usedChars: used, evidence, evidenceText: evidence.map((item,index) => `[${index + 1}] ${item.path}\n${item.snippet}`).join("\n\n") };
}
function wrapChunks(text: string, chunkChars: number): string {
  const chunks: string[] = [];
  for (let offset = 0; offset < text.length; offset += chunkChars) chunks.push(text.slice(offset, offset + chunkChars));
  return chunks.join("\n");
}
function unwrapChunks(text: string): string { return text.split(/\r?\n/).join(""); }

export class ResultPayloadGatewayService {
  private readonly enabled: boolean;
  private readonly artifactRoot: string;
  private readonly thresholdChars: number;
  private readonly previewStringChars: number;
  private readonly arrayItems: number;
  private readonly chunkChars: number;
  private readonly maxArtifacts: number;
  private readonly maxAgeMs: number;
  private readonly safeTools: Set<string>;
  private readonly chunkIndexCache = new Map<string, { totalChars: number; chunks: Array<{ path: string; startChar: number; snippet: string; lower: string }> }>();
  private metrics = {
    calls: 0,
    compacted: 0,
    bypassed: 0,
    originalChars: 0,
    returnedChars: 0,
    artifactsWritten: 0,
    artifactReads: 0,
    artifactSearches: 0,
    artifactPacks: 0,
    indexCacheHits: 0,
    indexCacheMisses: 0,
  };

  constructor(options: GatewayOptions) {
    this.enabled = Boolean(options.enabled);
    this.artifactRoot = resolve(options.artifactRoot);
    this.thresholdChars = Math.max(16_000, Math.min(options.thresholdChars ?? 64_000, 20_000_000));
    this.previewStringChars = Math.max(512, Math.min(options.previewStringChars ?? 4_000, 32_000));
    this.arrayItems = Math.max(4, Math.min(options.arrayItems ?? 16, 100));
    this.chunkChars = Math.max(2_000, Math.min(options.chunkChars ?? 8_000, 64_000));
    this.maxArtifacts = Math.max(8, Math.min(options.maxArtifacts ?? 64, 512));
    this.maxAgeMs = Math.max(60_000, Math.min(options.maxAgeMs ?? 21_600_000, 86_400_000));
    this.safeTools = new Set((options.safeTools ?? DEFAULT_SAFE_TOOLS).map((item) => String(item).trim()).filter(Boolean));
  }

  process(toolName: string, output: unknown, input?: unknown, annotations?: Record<string, unknown>): ResultPayloadGatewayDecision {
    this.metrics.calls += 1;
    const name = String(toolName);
    const raw = serialized(output);
    const originalChars = raw.length;
    this.metrics.originalChars += originalChars;
    const bypass = (reason: string): ResultPayloadGatewayDecision => {
      this.metrics.bypassed += 1;
      this.metrics.returnedChars += originalChars;
      return { output, compacted: false, originalChars, compactedChars: originalChars, artifactPath: null, artifactSha256: null, reason };
    };
    const inputObject = input && typeof input === "object" ? input as Record<string, unknown> : null;
    const queryHint = inputObject && typeof inputObject.query === "string" ? String(inputObject.query).trim().slice(0, 2_000) : null;
    if (!this.enabled) return bypass("disabled");
    if (!this.safeTools.has(name)) return bypass("tool-not-allowlisted");
    if (name === "office_read" && !queryHint) return bypass("quality-guard-office-read-missing-query");
    if (name === "context_recall" && !queryHint) return bypass("quality-guard-context-recall-missing-query");
    if (name === "pdf_document" && input && typeof input === "object" && String((input as Record<string, unknown>).action ?? "") !== "read") return bypass("quality-guard-non-read-pdf");
    if (annotations?.destructiveHint || annotations?.readOnlyHint === false) return bypass("mutation-or-destructive");
    if (hasError(output)) return bypass("error-result");
    if (hasImageContent(output)) return bypass("image-result");
    if (originalChars <= this.thresholdChars) return bypass("below-threshold");

    const artifactSha256 = createHash("sha256").update(raw).digest("hex");
    const artifactPath = this.persistArtifact(artifactSha256, raw);
    const contextPack = name === "context_recall" && queryHint ? this.evidencePack(artifactSha256, queryHint, 8, 10_000, 1_400) : null;
    if (name === "context_recall" && (!contextPack || contextPack.evidenceCount === 0)) return bypass("quality-guard-context-recall-no-evidence");
    const officePack = name === "office_read" && queryHint ? rankOfficeEvidence(output, queryHint, 8, 10_000) : null;
    if (name === "office_read" && (!officePack || officePack.evidenceCount === 0)) return bypass("quality-guard-office-read-no-evidence");
    const contextStructured = (output as any)?.structuredContent;
    const compactedBody = name === "pdf_document"
      ? compactPdfPreview(output, this.previewStringChars)
      : name === "context_recall" && contextPack
        ? {
            root: contextStructured?.root ?? null,
            query: queryHint,
            originalCount: contextStructured?.count ?? null,
            evidenceCount: contextPack.evidenceCount,
            evidence: contextPack.evidence,
            _nhdPreview: { strategy: "query-aware-context-recall-v1", maxEvidenceChars: 10_000, note: "Evidence is ranked against the recall query; use context_payload_artifact for additional search/pack/read." },
          }
        : name === "office_read" && officePack
          ? {
              path: contextStructured?.path ?? null,
              kind: contextStructured?.kind ?? null,
              parser: contextStructured?.parser ?? null,
              query: queryHint,
              evidenceCount: officePack.evidenceCount,
              evidence: officePack.evidence,
              _nhdPreview: { strategy: "structured-office-evidence-v1", unitCount: officePack.unitCount, maxEvidenceChars: 10_000, locators: ["paragraph:N","table:T/R#C#","sheet:Name!R#","slide:N"], note: "Structured Office evidence is query-ranked; use context_payload_artifact for additional raw search/pack/read." },
            }
          : compactValue(output, this.previewStringChars, this.arrayItems);
    const metadata = {
      version: "result-payload-gateway-v4",
      compacted: true,
      tool: name,
      originalChars,
      sha256: artifactSha256,
      artifactId: artifactSha256,
      artifactFormat: "concatenated fixed-width UTF-8 chunks, one chunk per line",
      chunkChars: this.chunkChars,
      chunkCount: Math.ceil(raw.length / this.chunkChars),
      retrieval: {
        tool: "context_payload_artifact",
        artifactId: artifactSha256,
        search: { action: "search", note: "Search bounded evidence snippets by natural-language or exact terms." },
        pack: { action: "pack", note: "Build a token-bounded query-aware evidence pack from the raw artifact." },
        read: { action: "read", note: "Read a bounded raw JSON character range when exact reconstruction is required." },
      },
      inputHint: inputObject ? Object.keys(inputObject).slice(0, 16) : [],
      queryHint,
    };
    const compactedOutput = {
      structuredContent: { _nhdPayloadGateway: metadata, preview: compactedBody },
      content: [{ type: "text" as const, text: (() => { const digest = scalarDigest(contextStructured); const evidence = name === "context_recall" ? recallEvidenceText(contextStructured) : ""; return `NHD compacted ${name} result (${originalChars} raw chars). Artifact ${artifactSha256}.${digest ? ` Summary: ${digest}.` : ""}${evidence ? `\nTop evidence:\n${evidence}` : ""}\nUse context_payload_artifact search/pack/read for bounded evidence retrieval.`; })() }],
    };
    const compactedChars = serialized(compactedOutput).length;
    this.metrics.compacted += 1;
    this.metrics.returnedChars += compactedChars;
    return { output: compactedOutput, compacted: true, originalChars, compactedChars, artifactPath, artifactSha256, reason: "compacted" };
  }

  status() {
    const savings = this.metrics.originalChars > 0 ? 1 - this.metrics.returnedChars / this.metrics.originalChars : 0;
    const savedChars = Math.max(0, this.metrics.originalChars - this.metrics.returnedChars);
    return {
      available: true,
      enabled: this.enabled,
      mode: "reversible-result-payload-gateway-v4",
      thresholdChars: this.thresholdChars,
      safeTools: [...this.safeTools].sort(),
      artifactRoot: this.artifactRoot,
      maxArtifacts: this.maxArtifacts,
      maxAgeMs: this.maxAgeMs,
      metrics: {
        ...this.metrics,
        savedChars,
        savedEstimatedTokens: Math.ceil(savedChars / 4),
        savingsRatio: Number(Math.max(0, savings).toFixed(6)),
      },
    };
  }

  readArtifact(path: string): string {
    const resolved = resolve(path);
    const root = this.artifactRoot.toLowerCase();
    const candidate = resolved.toLowerCase();
    if (candidate !== root && !candidate.startsWith(`${root}\\`)) throw new Error("Artifact path is outside the Result Payload Gateway root.");
    return unwrapChunks(readFileSync(resolved, "utf8"));
  }

  readArtifactById(artifactId: string, startChar = 0, maxChars = 12_000) {
    const raw = this.readArtifact(this.artifactPathForId(artifactId));
    const start = Math.max(0, Math.min(Math.trunc(startChar), raw.length));
    const length = Math.max(100, Math.min(Math.trunc(maxChars), 50_000));
    const end = Math.min(raw.length, start + length);
    this.metrics.artifactReads += 1;
    return { artifactId, totalChars: raw.length, startChar: start, endChar: end, text: raw.slice(start, end), complete: start === 0 && end === raw.length };
  }

  private getIndexedChunks(artifactId: string, boundedContext: number) {
    const normalizedId = String(artifactId).toLowerCase();
    const cacheKey = `${normalizedId}:${boundedContext}`;
    // Verify artifact still exists on disk before serving from cache
    const artifactPath = this.artifactPathForId(normalizedId);
    const cached = this.chunkIndexCache.get(cacheKey);
    if (cached) {
      this.metrics.indexCacheHits += 1;
      this.chunkIndexCache.delete(cacheKey);
      this.chunkIndexCache.set(cacheKey, cached);
      return cached;
    }
    this.metrics.indexCacheMisses += 1;
    const raw = this.readArtifact(artifactPath);
    const parsed = JSON.parse(raw);
    const chunks: Array<{ path: string; startChar: number; snippet: string; lower: string }> = [];
    const seenChunk = new Set<string>();
    const stride = Math.max(120, Math.floor(boundedContext / 2));
    const collectString = (value: string, path: string) => {
      if (!value) return;
      for (let start = 0; start < value.length; start += stride) {
        const snippet = value.slice(start, Math.min(value.length, start + boundedContext));
        if (!snippet.trim()) continue;
        const lower = snippet.toLocaleLowerCase("vi-VN");
        const fingerprint = createHash("sha256").update(lower).digest("hex").slice(0, 20);
        if (seenChunk.has(fingerprint)) continue;
        seenChunk.add(fingerprint);
        chunks.push({ path, startChar: start, snippet, lower });
        if (chunks.length >= 50_000) return;
      }
    };
    const hasStructuredContent = Boolean(parsed && typeof parsed === "object" && !Array.isArray(parsed) && (parsed as Record<string, unknown>).structuredContent);
    const walk = (value: unknown, path: string, depth = 0) => {
      if (depth > 10 || chunks.length >= 50_000) return;
      if (typeof value === "string") { collectString(value, path); return; }
      if (Array.isArray(value)) { value.forEach((item, index) => walk(item, `${path}[${index}]`, depth + 1)); return; }
      if (value && typeof value === "object") {
        for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
          if (hasStructuredContent && path === "$" && key === "content") continue;
          if (path === "$.structuredContent" && key === "query") continue;
          walk(item, `${path}.${key}`, depth + 1);
        }
      }
    };
    walk(parsed, "$", 0);
    const entry = { totalChars: raw.length, chunks };
    if (this.chunkIndexCache.size >= 16) {
      const oldestKey = this.chunkIndexCache.keys().next().value;
      if (oldestKey) this.chunkIndexCache.delete(oldestKey);
    }
    this.chunkIndexCache.set(cacheKey, entry);
    return entry;
  }

  searchArtifact(artifactId: string, query: string, limit = 8, contextChars = 900) {
    const normalized = normalizeQuery(query);
    if (!normalized) throw new Error("query is required.");
    const terms = [...new Set(normalized.split(/[^\p{L}\p{N}_-]+/u).filter((term) => term.length >= 2))].slice(0, 16);
    const boundedLimit = Math.max(1, Math.min(Math.trunc(limit), 20));
    const boundedContext = Math.max(200, Math.min(Math.trunc(contextChars), 2_000));
    const { totalChars, chunks } = this.getIndexedChunks(artifactId, boundedContext);
    const candidates: Array<{ path: string; startChar: number; score: number; snippet: string }> = [];
    const documentFrequency = new Map<string, number>();
    for (const term of terms) documentFrequency.set(term, chunks.reduce((count, chunk) => count + (chunk.lower.includes(term) ? 1 : 0), 0));
    for (const chunk of chunks) {
      let matched = 0;
      let weighted = 0;
      const positions: number[] = [];
      for (const term of terms) {
        const at = chunk.lower.indexOf(term);
        if (at < 0) continue;
        matched += 1;
        positions.push(at);
        const df = documentFrequency.get(term) ?? 0;
        weighted += Math.log((chunks.length + 1) / (df + 1)) + 1;
      }
      if (!matched) continue;
      const exact = chunk.lower.includes(normalized) ? 500 : 0;
      let orderedBonus = 0;
      if (positions.length >= 2) {
        let ordered = true;
        for (let i = 1; i < positions.length; i++) if (positions[i] < positions[i - 1]) { ordered = false; break; }
        if (ordered) {
          const span = positions[positions.length - 1] - positions[0] + 1;
          orderedBonus = 120 + Math.max(0, 180 - Math.floor(span / 3));
        }
      }
      const coverage = terms.length ? matched / terms.length : 0;
      const score = exact + orderedBonus + weighted * 25 + coverage * 300;
      candidates.push({ path: chunk.path, startChar: chunk.startChar, score, snippet: chunk.snippet });
    }
    const deduped: typeof candidates = [];
    for (const candidate of candidates.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path) || a.startChar - b.startChar)) {
      if (deduped.some((item) => item.path === candidate.path && Math.abs(item.startChar - candidate.startChar) < Math.floor(boundedContext / 2))) continue;
      deduped.push(candidate);
      if (deduped.length >= boundedLimit) break;
    }
    this.metrics.artifactSearches += 1;
    return { artifactId, query, terms, totalChars, matches: deduped, matchCount: deduped.length };
  }

  evidencePack(artifactId: string, query: string, limit = 8, maxChars = 8_000, contextChars = 1_000) {
    const boundedMax = Math.max(1_000, Math.min(Math.trunc(maxChars), 24_000));
    const searched = this.searchArtifact(artifactId, query, Math.max(limit, 12), contextChars);
    const evidence: Array<{ path: string; startChar: number; score: number; snippet: string }> = [];
    let used = 0;
    for (const match of searched.matches) {
      if (evidence.length >= Math.max(1, Math.min(Math.trunc(limit), 20))) break;
      const index = evidence.length + 1;
      const header = `[${index}] ${match.path}@${match.startChar}\n`;
      const separator = evidence.length ? "\n\n" : "";
      const remaining = boundedMax - used - header.length - separator.length;
      if (remaining <= 120) break;
      const snippet = match.snippet.slice(0, remaining);
      if (!snippet.trim()) continue;
      evidence.push({ path: match.path, startChar: match.startChar, score: Number(match.score.toFixed(3)), snippet });
      used += separator.length + header.length + snippet.length;
    }
    const evidenceText = evidence.map((item, index) => `[${index + 1}] ${item.path}@${item.startChar}\n${item.snippet}`).join("\n\n");
    this.metrics.artifactPacks += 1;
    return { artifactId, query, totalChars: searched.totalChars, maxChars: boundedMax, usedChars: evidenceText.length, evidenceCount: evidence.length, evidence, evidenceText };
  }
  private artifactPathForId(artifactId: string): string {
    const id = String(artifactId).toLowerCase();
    if (!ARTIFACT_ID.test(id)) throw new Error("artifact_id must be a 64-character SHA-256 hex string.");
    const path = resolve(this.artifactRoot, `${id}.nhdpayload`);
    if (!existsSync(path)) throw new Error("Result payload artifact was not found or has expired.");
    return path;
  }

  private persistArtifact(sha256: string, raw: string): string {
    mkdirSync(this.artifactRoot, { recursive: true });
    this.cleanup();
    const path = resolve(this.artifactRoot, `${sha256}.nhdpayload`);
    if (existsSync(path)) return path;
    const temp = resolve(this.artifactRoot, `.${sha256}.${process.pid}.tmp`);
    writeFileSync(temp, wrapChunks(raw, this.chunkChars), { encoding: "utf8", mode: 0o600 });
    renameSync(temp, path);
    this.metrics.artifactsWritten += 1;
    return path;
  }

  private cleanup() {
    if (!existsSync(this.artifactRoot)) return;
    const now = Date.now();
    const entries = readdirSync(this.artifactRoot).filter((name) => name.endsWith(".nhdpayload")).map((name) => {
      const path = resolve(this.artifactRoot, name);
      try { return { path, mtimeMs: statSync(path).mtimeMs }; } catch { return null; }
    }).filter(Boolean) as Array<{ path: string; mtimeMs: number }>;
    for (const entry of entries) if (now - entry.mtimeMs > this.maxAgeMs) { try { unlinkSync(entry.path); } catch {} }
    const survivors = entries.filter((entry) => now - entry.mtimeMs <= this.maxAgeMs).sort((a, b) => b.mtimeMs - a.mtimeMs);
    for (const entry of survivors.slice(this.maxArtifacts)) { try { unlinkSync(entry.path); } catch {} }
  }
}







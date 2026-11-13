import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PersistentJsonWorker } from "./persistent-json-worker.js";

export type RequestedOcrEngine = "auto" | "paddleocr" | "tesseract";
export type ConcreteOcrEngine = Exclude<RequestedOcrEngine, "auto">;

export type OcrPageResult = {
  page: number;
  text: string;
  confidence: number | null;
  engine: ConcreteOcrEngine;
  lines?: Array<{ text: string; confidence: number | null; box?: unknown }>;
};

export type OcrResult = Record<string, unknown> & {
  path?: string;
  language: string;
  engine: ConcreteOcrEngine;
  requestedEngine: RequestedOcrEngine;
  fallbackUsed: boolean;
  warnings: string[];
  pages: OcrPageResult[];
};

export type OcrEngineAvailability = { paddleocr: boolean; tesseract: boolean };
export type RenderedOcrImage = { page: number; mimeType: "image/png"; data: string; width: number; height: number };

type PaddleStatus = Record<string, unknown> & { available?: boolean; paddleocr?: string; paddle?: string; numpy?: string };
type PaddleWorkerResult = Record<string, unknown> & { language?: string; pages?: Array<{ page: number; text: string; confidence: number | null; lines?: OcrPageResult["lines"] }> };

export function normalizePaddleLanguage(language = "vie+eng") {
  const raw = language.trim().toLowerCase();
  const parts = raw.split(/[+,;\s]+/).filter(Boolean);
  if (parts.some((part) => part === "vie" || part === "vi" || part === "vietnamese")) return "vi";
  if (parts.some((part) => part === "eng" || part === "en" || part === "english")) return "en";
  if (parts.length === 1 && /^[a-z]{2,3}$/.test(parts[0])) return parts[0] === "vie" ? "vi" : parts[0] === "eng" ? "en" : parts[0];
  return "vi";
}

export function chooseOcrEngine(requested: RequestedOcrEngine, availability: OcrEngineAvailability): ConcreteOcrEngine {
  if (requested === "paddleocr") {
    if (!availability.paddleocr) throw new Error("PaddleOCR was requested but its runtime is unavailable.");
    return "paddleocr";
  }
  if (requested === "tesseract") {
    if (!availability.tesseract) throw new Error("Tesseract was requested but its executable/runtime is unavailable.");
    return "tesseract";
  }
  if (availability.paddleocr) return "paddleocr";
  if (availability.tesseract) return "tesseract";
  throw new Error("No OCR engine is currently available. PaddleOCR and Tesseract are both unavailable.");
}

function boundedSet<K, V>(map: Map<K, V>, key: K, value: V, limit: number) {
  if (map.has(key)) map.delete(key);
  map.set(key, value);
  while (map.size > limit) map.delete(map.keys().next().value as K);
}

function pageQuality(page: { text: string; confidence: number | null }) {
  const text = page.text.trim();
  if (!text) return 0;
  if (page.confidence != null && Number.isFinite(page.confidence)) return Math.max(0, Math.min(100, page.confidence));
  return text.length >= 20 ? 55 : 35;
}

function resultQuality(result: OcrResult) {
  if (!result.pages.length) return 0;
  return result.pages.reduce((sum, page) => sum + pageQuality(page), 0) / result.pages.length;
}

export class OcrDispatcher {
  private cachedPaddleStatus: { at: number; value: PaddleStatus } | null = null;
  private paddleWorker: PersistentJsonWorker | null = null;
  private readonly paddlePageCache = new Map<string, OcrPageResult>();
  private cacheHits = 0;
  private cacheMisses = 0;
  private oneShotFallbacks = 0;
  private qualityCrossChecks = 0;

  constructor(readonly baseDir = process.cwd()) {}

  dispose() {
    this.paddleWorker?.stop();
    this.paddleWorker = null;
  }

  status() {
    return {
      persistentPaddleWorker: this.paddleWorker?.status() ?? { name: "paddleocr", online: false, pid: null, requests: 0, failures: 0, pending: 0, lastRttMs: null, startupMs: null, startedAt: null, stderrTail: "" },
      pageCache: { entries: this.paddlePageCache.size, hits: this.cacheHits, misses: this.cacheMisses, maxEntries: 256, key: "rendered-page-sha256 + PaddleOCR/Paddle version + language" },
      oneShotFallbacks: this.oneShotFallbacks,
      qualityCrossChecks: this.qualityCrossChecks,
    };
  }

  async paddleStatus(): Promise<PaddleStatus> {
    if (this.cachedPaddleStatus && Date.now() - this.cachedPaddleStatus.at < 60_000) return this.cachedPaddleStatus.value;
    const python = resolve(this.baseDir, "runtime", "paddleocr-venv", "Scripts", "python.exe");
    const script = resolve(this.baseDir, "office", "paddle_ocr_worker.py");
    if (!existsSync(python) || !existsSync(script)) {
      const value = { available: false, python: existsSync(python) ? python : null, script: existsSync(script) ? script : null };
      this.cachedPaddleStatus = { at: Date.now(), value };
      return value;
    }
    try {
      const value = await this.paddleRequest({ action: "status" }, 30_000) as PaddleStatus;
      this.cachedPaddleStatus = { at: Date.now(), value };
      return value;
    } catch (error) {
      const value = { available: false, error: error instanceof Error ? error.message : String(error) };
      this.cachedPaddleStatus = { at: Date.now(), value };
      return value;
    }
  }

  async runPdf(input: {
    path: string;
    pages: number[];
    language: string;
    requestedEngine?: RequestedOcrEngine;
    tesseractAvailable: boolean;
    render: () => Promise<{ images?: RenderedOcrImage[] }>;
    runTesseract: () => Promise<Record<string, unknown> & { pages?: Array<{ page: number; text: string; confidence: number | null }> }>;
  }): Promise<OcrResult> {
    const requestedEngine = input.requestedEngine ?? "auto";
    const paddle = await this.paddleStatus();
    const availability = { paddleocr: paddle.available === true, tesseract: input.tesseractAvailable };
    const selected = chooseOcrEngine(requestedEngine, availability);
    if (selected === "tesseract") return this.normalizeTesseract(await input.runTesseract(), input.path, input.language, requestedEngine, false, []);

    try {
      const paddleResult = await this.runPaddle(input.path, input.language, requestedEngine, await input.render(), paddle);
      const lowConfidence = paddleResult.pages.some((page) => pageQuality(page) < 55);
      if (requestedEngine === "auto" && availability.tesseract && lowConfidence) {
        this.qualityCrossChecks += 1;
        const tesseract = this.normalizeTesseract(await input.runTesseract(), input.path, input.language, requestedEngine, true, ["PaddleOCR returned low-confidence or sparse text; Tesseract was run as a quality cross-check."]);
        if (resultQuality(tesseract) >= resultQuality(paddleResult) + 5) {
          tesseract.warnings.push("Tesseract scored materially better than PaddleOCR and was selected.");
          return tesseract;
        }
        paddleResult.warnings.push("PaddleOCR was low-confidence on at least one page; Tesseract was cross-checked but did not score materially better, so the PaddleOCR result was retained.");
      }
      return paddleResult;
    } catch (error) {
      if (requestedEngine !== "auto" || !availability.tesseract) throw error;
      const message = error instanceof Error ? error.message : String(error);
      return this.normalizeTesseract(await input.runTesseract(), input.path, input.language, requestedEngine, true, [`PaddleOCR failed; Tesseract fallback was used: ${message}`]);
    }
  }

  private async runPaddle(path: string, language: string, requestedEngine: RequestedOcrEngine, rendered: { images?: RenderedOcrImage[] }, paddleStatus: PaddleStatus): Promise<OcrResult> {
    const images = rendered.images ?? [];
    if (!images.length) throw new Error("PDF rendering returned no page images for PaddleOCR.");
    const modelLanguage = normalizePaddleLanguage(language);
    const signature = `${String(paddleStatus.paddleocr ?? "unknown")}|${String(paddleStatus.paddle ?? "unknown")}|${modelLanguage}`;
    const resolved = new Map<number, OcrPageResult>();
    const misses: Array<{ image: RenderedOcrImage; key: string }> = [];
    for (const image of images) {
      const hash = createHash("sha256").update(Buffer.from(image.data, "base64")).digest("hex");
      const key = `${hash}|${signature}`;
      const cached = this.paddlePageCache.get(key);
      if (cached) {
        this.cacheHits += 1;
        this.paddlePageCache.delete(key);
        this.paddlePageCache.set(key, cached);
        resolved.set(image.page, { ...cached, page: image.page });
      } else {
        this.cacheMisses += 1;
        misses.push({ image, key });
      }
    }

    let workerMetadata: Record<string, unknown> = {};
    if (misses.length) {
      const temp = mkdtempSync(join(tmpdir(), "nhd-ocr-"));
      try {
        const items = misses.map(({ image }) => {
          const file = join(temp, `page-${String(image.page).padStart(4, "0")}.png`);
          writeFileSync(file, Buffer.from(image.data, "base64"));
          return { page: image.page, path: file };
        });
        const result = await this.paddleRequest({ action: "ocr", items, language: modelLanguage }, 300_000) as PaddleWorkerResult;
        workerMetadata = Object.fromEntries(Object.entries(result).filter(([key]) => key !== "pages"));
        const byPage = new Map((result.pages ?? []).map((page) => [page.page, page]));
        for (const miss of misses) {
          const raw = byPage.get(miss.image.page);
          if (!raw) throw new Error(`PaddleOCR did not return page ${miss.image.page}.`);
          const normalized: OcrPageResult = { ...raw, engine: "paddleocr" as const };
          resolved.set(miss.image.page, normalized);
          boundedSet(this.paddlePageCache, miss.key, { ...normalized, page: 0 }, 256);
        }
      } finally {
        rmSync(temp, { recursive: true, force: true });
      }
    }

    return {
      path,
      language,
      modelLanguage,
      engine: "paddleocr",
      requestedEngine,
      fallbackUsed: false,
      warnings: [],
      cache: { hits: images.length - misses.length, misses: misses.length },
      ...workerMetadata,
      pages: images.map((image) => resolved.get(image.page)).filter((page): page is OcrPageResult => Boolean(page)),
    };
  }

  private normalizeTesseract(result: Record<string, unknown> & { pages?: Array<{ page: number; text: string; confidence: number | null }> }, path: string, language: string, requestedEngine: RequestedOcrEngine, fallbackUsed: boolean, warnings: string[]): OcrResult {
    return { ...result, path, language, engine: "tesseract", requestedEngine, fallbackUsed, warnings, pages: (result.pages ?? []).map((page) => ({ ...page, engine: "tesseract" as const })) };
  }

  private async paddleRequest(payload: Record<string, unknown>, timeoutMs: number): Promise<Record<string, unknown>> {
    const python = resolve(this.baseDir, "runtime", "paddleocr-venv", "Scripts", "python.exe");
    const script = resolve(this.baseDir, "office", "paddle_ocr_worker.py");
    if (!this.paddleWorker) this.paddleWorker = new PersistentJsonWorker("paddleocr", python, [script, "--persistent"], this.baseDir);
    const worker = this.paddleWorker;
    try {
      return await worker.request(payload, timeoutMs);
    } catch (persistentError) {
      // Another concurrent request may already have retired the shared worker while this request was awaiting.
      // Keep a local reference so cleanup never dereferences a null shared pointer.
      worker.stop();
      if (this.paddleWorker === worker) this.paddleWorker = null;
      this.oneShotFallbacks += 1;
      try { return await this.runProcess(python, [script], payload, timeoutMs); }
      catch (oneShotError) {
        const first = persistentError instanceof Error ? persistentError.message : String(persistentError);
        const second = oneShotError instanceof Error ? oneShotError.message : String(oneShotError);
        throw new Error(`Persistent PaddleOCR failed (${first}); one-shot fallback also failed (${second}).`);
      }
    }
  }

  private runProcess(executable: string, args: string[], payload: Record<string, unknown>, timeoutMs: number): Promise<Record<string, unknown>> {
    return new Promise((resolvePromise, reject) => {
      const child = spawn(executable, args, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      const timer = setTimeout(() => { child.kill(); reject(new Error("OCR worker timed out.")); }, timeoutMs);
      child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
      child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
      child.once("error", (error) => { clearTimeout(timer); reject(error); });
      child.once("exit", (code) => {
        clearTimeout(timer);
        const output = Buffer.concat(stdout).toString("utf8").trim();
        const errors = Buffer.concat(stderr).toString("utf8").trim();
        if (code !== 0) return reject(new Error(errors || output || `OCR worker exited with ${code}.`));
        try { resolvePromise(JSON.parse(output) as Record<string, unknown>); }
        catch { reject(new Error(`OCR worker returned invalid JSON${errors ? `: ${errors.slice(-1000)}` : "."}`)); }
      });
      child.stdin.end(JSON.stringify(payload));
    });
  }
}

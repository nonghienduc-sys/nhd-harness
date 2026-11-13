import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { AppConfig } from "./config.js";
import { Store } from "./db.js";
import { FileService } from "./files.js";
import { IntakeService } from "./intake.js";
import { OcrDispatcher, RequestedOcrEngine, RenderedOcrImage, OcrResult } from "./ocr.js";
import { PersistentJsonWorker } from "./persistent-json-worker.js";

import { resolveNhdPython } from "./python-runtime.js";
type PdfPage = { page: number; text: string; characters: number; scanned: boolean };
type WorkerResult = Record<string, unknown> & { images?: RenderedOcrImage[]; pages?: Array<{ page: number; text: string; confidence: number | null }> };
type PdfCacheEntry = {
  path: string;
  size: number;
  mtimeMs: number;
  hash: string;
  document: any;
  pages: Map<number, PdfPage>;
  metadata?: { info: unknown; metadata: unknown };
};

function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
function boundedSet<K, V>(map: Map<K, V>, key: K, value: V, limit: number, onEvict?: (value: V) => void) {
  if (map.has(key)) map.delete(key);
  map.set(key, value);
  while (map.size > limit) {
    const first = map.keys().next().value as K;
    const evicted = map.get(first);
    map.delete(first);
    if (evicted !== undefined) onEvict?.(evicted);
  }
}

export class PdfService {
  private cachedWorkerStatus: { at: number; value: Record<string, unknown> } | null = null;
  private readonly ocrDispatcher = new OcrDispatcher(process.cwd());
  private pdfWorker: PersistentJsonWorker | null = null;
  private readonly documents = new Map<string, PdfCacheEntry>();
  private readonly renderCache = new Map<string, RenderedOcrImage>();
  private readonly ocrCache = new Map<string, OcrResult>();
  private metrics = { documentHits: 0, documentMisses: 0, pageHits: 0, pageMisses: 0, renderHits: 0, renderMisses: 0, ocrHits: 0, ocrMisses: 0, workerOneShotFallbacks: 0 };
  private static readonly TEXT_CACHE_VERSION = "pdfjs-text-v2";
  private static readonly RENDER_CACHE_VERSION = "pymupdf-render-v2";

  constructor(readonly config: AppConfig, readonly store: Store, readonly files: FileService, readonly intake: IntakeService) {}

  dispose() {
    this.pdfWorker?.stop();
    this.pdfWorker = null;
    this.ocrDispatcher.dispose();
    for (const entry of this.documents.values()) {
      try { void entry.document.destroy?.(); } catch {}
    }
    this.documents.clear();
    this.renderCache.clear();
    this.ocrCache.clear();
  }

  cacheStatus() {
    const pageEntries = [...this.documents.values()].reduce((sum, entry) => sum + entry.pages.size, 0);
    return {
      strategy: "content-hash + parser/renderer/OCR-version",
      native: { documents: this.documents.size, pages: pageEntries, maxDocuments: 8, parserVersion: PdfService.TEXT_CACHE_VERSION },
      render: { entries: this.renderCache.size, maxEntries: 12, rendererVersion: PdfService.RENDER_CACHE_VERSION },
      ocr: { entries: this.ocrCache.size, maxEntries: 32, pageSelectiveReuse: "rendered-page-sha256 in OcrDispatcher" },
      metrics: { ...this.metrics },
      worker: this.pdfWorker?.status() ?? { name: "pdf", online: false, pid: null, requests: 0, failures: 0, pending: 0, lastRttMs: null, startupMs: null, startedAt: null, stderrTail: "" },
      paddle: this.ocrDispatcher.status(),
    };
  }

  async status() {
    const [worker, paddleocr] = await Promise.all([this.workerStatus(), this.ocrDispatcher.paddleStatus()]);
    const tesseractAvailable = worker.ocr === true;
    const paddleAvailable = paddleocr.available === true;
    return {
      nativeTextExtraction: true,
      pageSearch: true,
      intakeEnabled: this.config.intakeEnabled,
      ocrEnabled: this.config.ocrEnabled,
      worker,
      ocr: {
        available: this.config.ocrEnabled && (paddleAvailable || tesseractAvailable),
        primaryEngine: paddleAvailable ? "paddleocr" : tesseractAvailable ? "tesseract" : null,
        fallbackEngine: paddleAvailable && tesseractAvailable ? "tesseract" : null,
        engines: { paddleocr, tesseract: { available: tesseractAvailable, executable: typeof worker.tesseract === "string" ? worker.tesseract : null, modules: worker.modules ?? null } },
      },
      performance: this.cacheStatus(),
    };
  }

  async inspect(pathInput: string) {
    const entry = await this.open(pathInput);
    if (!entry.metadata) entry.metadata = await entry.document.getMetadata().catch(() => ({ info: {}, metadata: null }));
    const metadata = entry.metadata ?? { info: {}, metadata: null };
    const pageStats: Array<{ page: number; characters: number; scanned: boolean }> = [];
    let textCharacters = 0;
    for (let pageNumber = 1; pageNumber <= entry.document.numPages; pageNumber++) {
      const page = await this.page(entry, pageNumber);
      textCharacters += page.characters;
      pageStats.push({ page: pageNumber, characters: page.characters, scanned: page.scanned });
    }
    const result = { path: entry.path, size: entry.size, pages: entry.document.numPages, metadata: metadata.info, textCharacters, scannedPages: pageStats.filter((page) => page.scanned).map((page) => page.page), pageStats, hash: entry.hash };
    this.store.audit("pdf_inspect", "success", { path: entry.path, pages: entry.document.numPages, textCharacters, scannedPages: result.scannedPages.length });
    return result;
  }

  async read(pathInput: string, startPage = 1, endPage?: number, maxChars = 100_000) {
    const entry = await this.open(pathInput);
    const start = Math.min(Math.max(Math.trunc(startPage), 1), entry.document.numPages);
    const end = Math.min(Math.max(Math.trunc(endPage ?? entry.document.numPages), start), entry.document.numPages);
    const budget = Math.min(Math.max(Math.trunc(maxChars), 1000), 500_000);
    const pages: PdfPage[] = [];
    let usedCharacters = 0;
    let nextPage: number | null = null;
    for (let pageNumber = start; pageNumber <= end; pageNumber++) {
      const page = await this.page(entry, pageNumber);
      const cost = page.text.length + 40;
      if (pages.length && usedCharacters + cost > budget) { nextPage = pageNumber; break; }
      if (!pages.length && cost > budget) {
        pages.push({ ...page, text: page.text.slice(0, budget) });
        usedCharacters = pages[0].text.length;
        nextPage = pageNumber + 1 <= end ? pageNumber + 1 : null;
        break;
      }
      pages.push(page); usedCharacters += cost;
    }
    const result = { path: entry.path, pageRange: { start, end: pages.at(-1)?.page ?? start }, totalPages: entry.document.numPages, pages, usedCharacters, truncated: nextPage != null, nextCursor: nextPage == null ? null : { startPage: nextPage, endPage: end, maxChars: budget }, warnings: pages.some((page) => page.scanned) ? ["Some returned pages contain little native text. Use PDF OCR for those pages."] : [] };
    this.store.audit("pdf_read", "success", { path: entry.path, start, returnedPages: pages.length, usedCharacters, nextPage });
    return result;
  }

  async search(pathInput: string, query: string, limit = 50) {
    const entry = await this.open(pathInput);
    const needle = query.trim().toLocaleLowerCase("vi");
    if (!needle) throw new Error("PDF search query is required.");
    const hits: Array<{ page: number; excerpt: string }> = [];
    for (let pageNumber = 1; pageNumber <= entry.document.numPages && hits.length < Math.min(Math.max(limit, 1), 100); pageNumber++) {
      const page = await this.page(entry, pageNumber);
      const lower = page.text.toLocaleLowerCase("vi");
      let offset = lower.indexOf(needle);
      while (offset >= 0 && hits.length < limit) {
        hits.push({ page: pageNumber, excerpt: page.text.slice(Math.max(0, offset - 180), Math.min(page.text.length, offset + needle.length + 220)) });
        offset = lower.indexOf(needle, offset + needle.length);
      }
    }
    this.store.audit("pdf_search", "success", { path: entry.path, query: query.slice(0, 200), hits: hits.length });
    return { path: entry.path, query, hits };
  }

  async render(pathInput: string, pages: number[], maxWidth = 1600): Promise<WorkerResult> {
    const entry = await this.open(pathInput);
    const selected = [...new Set(pages.map((page) => Math.trunc(page)).filter((page) => page > 0))].slice(0, 6);
    if (!selected.length) throw new Error("At least one PDF page is required.");
    const width = Math.min(Math.max(Math.trunc(maxWidth), 640), 2400);
    const resolved = new Map<number, RenderedOcrImage>();
    const misses: number[] = [];
    for (const page of selected) {
      const key = this.renderKey(entry.hash, page, width);
      const cached = this.renderCache.get(key);
      if (cached) {
        this.metrics.renderHits += 1;
        this.renderCache.delete(key); this.renderCache.set(key, cached);
        resolved.set(page, cached);
      } else { this.metrics.renderMisses += 1; misses.push(page); }
    }
    if (misses.length) {
      const result = await this.worker({ action: "render", path: entry.path, pages: misses, maxWidth: width }, 90_000);
      for (const image of result.images ?? []) {
        const key = this.renderKey(entry.hash, image.page, width);
        boundedSet(this.renderCache, key, image, 12);
        resolved.set(image.page, image);
      }
    }
    const images = selected.map((page) => resolved.get(page)).filter((image): image is RenderedOcrImage => Boolean(image));
    const result: WorkerResult = { path: entry.path, pageCount: entry.document.numPages, images, cache: { hits: selected.length - misses.length, misses: misses.length } };
    this.store.audit("pdf_render", "success", { path: entry.path, pages: selected, images: images.length, cacheHits: selected.length - misses.length });
    return result;
  }

  async ocr(pathInput: string, pages: number[], language = "vie+eng", engine: RequestedOcrEngine = "auto") {
    if (!this.config.ocrEnabled || this.config.emergencyStop) throw new Error("PDF OCR is disabled by the owner.");
    const entry = await this.open(pathInput);
    const selected = [...new Set(pages.map((page) => Math.trunc(page)).filter((page) => page > 0))].slice(0, 20);
    if (!selected.length) throw new Error("At least one PDF page is required for OCR.");
    const [workerStatus, paddleStatus] = await Promise.all([this.workerStatus(), this.ocrDispatcher.paddleStatus()]);
    const signature = `${PdfService.RENDER_CACHE_VERSION}|tess:${String(workerStatus.tesseractVersion ?? "unknown")}|paddle:${String(paddleStatus.paddleocr ?? "unknown")}|${String(paddleStatus.paddle ?? "unknown")}`;
    const cacheKey = `${entry.hash}|${selected.join(",")}|${language}|${engine}|${signature}`;
    const cached = this.ocrCache.get(cacheKey);
    if (cached) {
      this.metrics.ocrHits += 1;
      this.ocrCache.delete(cacheKey); this.ocrCache.set(cacheKey, cached);
      return { ...clone(cached), cache: { resultHit: true } };
    }
    this.metrics.ocrMisses += 1;
    const result = await this.ocrDispatcher.runPdf({
      path: entry.path,
      pages: selected,
      language,
      requestedEngine: engine,
      tesseractAvailable: workerStatus.ocr === true,
      render: () => this.render(entry.path, selected, 2000),
      runTesseract: () => this.worker({ action: "ocr", path: entry.path, pages: selected, language }, 180_000),
    });
    boundedSet(this.ocrCache, cacheKey, clone(result), 32);
    this.store.audit("pdf_ocr", "success", { path: entry.path, pages: selected, language, requestedEngine: engine, engine: result.engine, fallbackUsed: result.fallbackUsed, returnedPages: result.pages.length, cacheHit: false });
    return { ...result, cache: { ...(typeof result.cache === "object" && result.cache ? result.cache as object : {}), resultHit: false } };
  }

  private async workerStatus() {
    if (this.cachedWorkerStatus && Date.now() - this.cachedWorkerStatus.at < 60_000) return this.cachedWorkerStatus.value;
    let worker: Record<string, unknown> = { available: false };
    try { worker = await this.worker({ action: "status" }, 20_000); }
    catch (error) { worker = { available: false, error: error instanceof Error ? error.message : String(error) }; }
    this.cachedWorkerStatus = { at: Date.now(), value: worker };
    return worker;
  }

  private resolveReadable(pathInput: string) {
    try { return this.files.resolvePath(pathInput); }
    catch (rootError) {
      try { return this.intake.resolvePath(pathInput); }
      catch { throw rootError; }
    }
  }

  private async open(pathInput: string): Promise<PdfCacheEntry> {
    const path = this.resolveReadable(pathInput);
    if (!existsSync(path) || !statSync(path).isFile()) throw new Error("PDF path is not a file.");
    if (!path.toLowerCase().endsWith(".pdf")) throw new Error("Path is not a PDF file.");
    const stat = statSync(path);
    if (stat.size > 250 * 1024 * 1024) throw new Error("PDF exceeds the 250 MB read limit.");
    const existing = this.documents.get(path);
    if (existing && existing.size === stat.size && existing.mtimeMs === stat.mtimeMs) {
      this.metrics.documentHits += 1;
      this.documents.delete(path); this.documents.set(path, existing);
      return existing;
    }
    this.metrics.documentMisses += 1;
    if (existing) { this.documents.delete(path); try { void existing.document.destroy?.(); } catch {} }
    const bytes = readFileSync(path);
    const hash = createHash("sha256").update(bytes).digest("hex");
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const document = await pdfjs.getDocument({ data: new Uint8Array(bytes), useSystemFonts: true }).promise;
    const entry: PdfCacheEntry = { path, size: stat.size, mtimeMs: stat.mtimeMs, hash, document, pages: new Map() };
    boundedSet(this.documents, path, entry, 8, (evicted) => { try { void evicted.document.destroy?.(); } catch {} });
    return entry;
  }

  private async page(entry: PdfCacheEntry, pageNumber: number): Promise<PdfPage> {
    const cached = entry.pages.get(pageNumber);
    if (cached) { this.metrics.pageHits += 1; return cached; }
    this.metrics.pageMisses += 1;
    const page = await entry.document.getPage(pageNumber);
    const content = await page.getTextContent();
    const text = content.items.map((item: any) => typeof item.str === "string" ? item.str : "").join(" ").replace(/\s+/g, " ").trim();
    const result = { page: pageNumber, text, characters: text.length, scanned: text.length < 30 };
    entry.pages.set(pageNumber, result);
    return result;
  }

  private renderKey(hash: string, page: number, width: number) { return `${hash}|${PdfService.RENDER_CACHE_VERSION}|${width}|${page}`; }

  private async worker(payload: Record<string, unknown>, timeoutMs: number): Promise<WorkerResult> {
    const script = resolve(process.cwd(), "office", "pdf_worker.py");
    const python = resolveNhdPython();
    if (!this.pdfWorker) this.pdfWorker = new PersistentJsonWorker("pdf", python, [script, "--persistent"], process.cwd());
    const worker = this.pdfWorker;
    try { return await worker.request(payload, timeoutMs) as WorkerResult; }
    catch (persistentError) {
      worker.stop();
      if (this.pdfWorker === worker) this.pdfWorker = null;
      this.metrics.workerOneShotFallbacks += 1;
      try { return await this.oneShotWorker(script, payload, timeoutMs); }
      catch (oneShotError) {
        const first = persistentError instanceof Error ? persistentError.message : String(persistentError);
        const second = oneShotError instanceof Error ? oneShotError.message : String(oneShotError);
        throw new Error(`Persistent PDF worker failed (${first}); one-shot fallback also failed (${second}).`);
      }
    }
  }

  private oneShotWorker(script: string, payload: Record<string, unknown>, timeoutMs: number): Promise<WorkerResult> {
    return new Promise((resolvePromise, reject) => {
      const child = spawn(resolveNhdPython(), [script], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
      const stdout: Buffer[] = [], stderr: Buffer[] = [];
      const timer = setTimeout(() => { child.kill(); reject(new Error("PDF worker timed out.")); }, timeoutMs);
      child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
      child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
      child.once("error", (error) => { clearTimeout(timer); reject(error); });
      child.once("exit", (code) => {
        clearTimeout(timer);
        const output = Buffer.concat(stdout).toString("utf8").trim();
        const errors = Buffer.concat(stderr).toString("utf8").trim();
        if (code !== 0) return reject(new Error(errors || output || `PDF worker exited with ${code}.`));
        try { resolvePromise(JSON.parse(output) as WorkerResult); }
        catch { reject(new Error("PDF worker returned invalid JSON.")); }
      });
      child.stdin.end(JSON.stringify(payload));
    });
  }
}

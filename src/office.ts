import { readFileSync, writeFileSync, copyFileSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { basename, dirname, extname, resolve } from "node:path";
import JSZip from "jszip";
import ExcelJS from "exceljs";
import mammoth from "mammoth";
import { AppConfig } from "./config.js";
import { Store } from "./db.js";
import { FileService } from "./files.js";
import { canonicalizeFilePathResource, createEphemeralOwnerId, resolveTaskRunId } from "./resource-guard.js";
import { assertNoIntroducedRedaction, nowIso, randomToken, sha256 } from "./security.js";

// v0.24.14: keys whose string values describe text that already exists in the target.
const LIVE_ORIGINAL_TEXT_KEYS = new Set(["find", "search", "match", "target", "oldText", "old_text", "expectedText", "expected_text"]);

function splitLiveOperationText(value: unknown, original: string[], written: string[], key = ""): void {
  if (typeof value === "string") { (LIVE_ORIGINAL_TEXT_KEYS.has(key) ? original : written).push(value); return; }
  if (Array.isArray(value)) { for (const item of value) splitLiveOperationText(item, original, written, key); return; }
  if (value && typeof value === "object") for (const [k, v] of Object.entries(value as Record<string, unknown>)) splitLiveOperationText(v, original, written, k);
}

function assertLiveOperationRedactionSafe(operation: unknown, extraOriginal = ""): void {
  const original: string[] = [extraOriginal];
  const written: string[] = [];
  splitLiveOperationText(operation, original, written);
  assertNoIntroducedRedaction(written.join("\n"), original.join("\n"), "office live edit");
}

type OfficeOperation =
  | { type: "replace_text"; find: string; replace: string }
  | { type: "set_cell"; sheet: string; cell: string; value: string | number | boolean | null };

export type OfficeLiveApplication = "word" | "excel" | "powerpoint";
export type WordLivePathOptions = { path?: string; read_only?: boolean; remove_stale_lock?: boolean };

export type WordFormatSpec = {
  fontName?: string;
  fontSize?: number;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  fontColorHex?: string;
  alignment?: "left" | "center" | "right" | "justify";
  firstLineIndentCm?: number;
  leftIndentCm?: number;
  rightIndentCm?: number;
  spaceBeforePt?: number;
  spaceAfterPt?: number;
  lineSpacingMultiple?: number;
  lineSpacingPt?: number;
  keepTogether?: boolean;
  keepWithNext?: boolean;
};

export type WordPageSetup = {
  topMarginCm?: number;
  bottomMarginCm?: number;
  leftMarginCm?: number;
  rightMarginCm?: number;
  headerDistanceCm?: number;
  footerDistanceCm?: number;
  orientation?: "portrait" | "landscape";
  paperSize?: "A4" | "LETTER";
};

export type ExcelFormatSpec = {
  fontName?: string;
  fontSize?: number;
  bold?: boolean;
  italic?: boolean;
  numberFormat?: string;
  horizontalAlignment?: "general" | "left" | "center" | "right" | "fill" | "justify" | "centerAcrossSelection" | "distributed";
  verticalAlignment?: "top" | "center" | "bottom" | "justify" | "distributed";
  wrapText?: boolean;
  autofitColumns?: boolean;
  autofitRows?: boolean;
};

export type PowerPointTextFormatSpec = {
  fontName?: string;
  fontSize?: number;
  bold?: boolean;
  italic?: boolean;
  alignment?: "left" | "center" | "right" | "justify";
};

export type WordInsertBlock = {
  text: string;
  format?: WordFormatSpec;
};

export type OfficeLiveOperation =
  | { type: "replace_selection"; text: string }
  | { type: "word_insert_at_cursor"; blocks: WordInsertBlock[]; cursorOffset?: number }
  | { type: "word_append"; blocks: WordInsertBlock[]; cursorOffset?: number }
  | { type: "word_format"; scope: "selection" | "paragraph" | "document"; format: WordFormatSpec }
  | { type: "word_format_paragraphs"; startParagraph: number; endParagraph?: number; format: WordFormatSpec }
  | { type: "word_replace_paragraph"; paragraph: number; text: string }
  | { type: "word_page_setup"; scope: "current_section" | "document"; page: WordPageSetup }
  | { type: "word_save" }
  | { type: "excel_set_range"; address?: string; values: Array<Array<string | number | boolean | null>> }
  | { type: "excel_set_formula"; address?: string; formula: string }
  | { type: "excel_format_range"; address?: string; format: ExcelFormatSpec }
  | { type: "excel_save" }
  | { type: "powerpoint_replace_selected_text"; text: string }
  | { type: "powerpoint_format_selected_text"; format: PowerPointTextFormatSpec }
  | { type: "powerpoint_set_selected_shape_geometry"; leftPt?: number; topPt?: number; widthPt?: number; heightPt?: number }
  | { type: "powerpoint_save" };

function normalizeText(value: unknown) {
  return String(value ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function decodeOfficeXml(value: string) {
  return value
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"").replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, code) => String.fromCodePoint(parseInt(code, 16)));
}
function officeXmlText(xml: string, prefix: "w" | "a" = "w") {
  const expression = prefix === "w" ? /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g : /<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g;
  return [...xml.matchAll(expression)].map((match) => decodeOfficeXml(match[1])).join("");
}
function docxTables(documentXml: string) {
  return [...documentXml.matchAll(/<w:tbl(?:\s[^>]*)?>[\s\S]*?<\/w:tbl>/g)].map((tableMatch, tableIndex) => ({
    table: tableIndex + 1,
    rows: [...tableMatch[0].matchAll(/<w:tr(?:\s[^>]*)?>[\s\S]*?<\/w:tr>/g)].map((rowMatch, rowIndex) => ({
      row: rowIndex + 1,
      cells: [...rowMatch[0].matchAll(/<w:tc(?:\s[^>]*)?>[\s\S]*?<\/w:tc>/g)].map((cellMatch, cellIndex) => ({ cell: cellIndex + 1, text: officeXmlText(cellMatch[0], "w") })),
    })),
  }));
}
function columnIndex(address: string) {
  const letters = address.match(/^([A-Z]+)/i)?.[1]?.toUpperCase() ?? "";
  let value = 0; for (const char of letters) value = value * 26 + (char.charCodeAt(0) - 64); return value;
}
async function xlsxXmlFallback(path: string) {
  const zip = await JSZip.loadAsync(readFileSync(path));
  const workbookXml = await zip.file("xl/workbook.xml")?.async("string");
  const relsXml = await zip.file("xl/_rels/workbook.xml.rels")?.async("string");
  if (!workbookXml || !relsXml) throw new Error("XLSX workbook metadata is missing.");
  const rels = new Map<string, string>();
  for (const match of relsXml.matchAll(/<Relationship\b([^>]*)\/>/g)) {
    const id = match[1].match(/\bId="([^"]+)"/)?.[1]; const target = match[1].match(/\bTarget="([^"]+)"/)?.[1];
    if (id && target) rels.set(id, target);
  }
  const sharedXml = await zip.file("xl/sharedStrings.xml")?.async("string");
  const shared = sharedXml ? [...sharedXml.matchAll(/<si(?:\s[^>]*)?>[\s\S]*?<\/si>/g)].map((match) => [...match[0].matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((item) => decodeOfficeXml(item[1])).join("")) : [];
  const sheets = [] as Array<{ name: string; rows: unknown[][] }>;
  for (const sheetMatch of workbookXml.matchAll(/<sheet\b([^>]*)\/>/g)) {
    const attrs = sheetMatch[1]; const name = decodeOfficeXml(attrs.match(/\bname="([^"]+)"/)?.[1] ?? "Sheet"); const relId = attrs.match(/\br:id="([^"]+)"/)?.[1]; if (!relId) continue;
    const target = rels.get(relId); if (!target) continue;
    const normalizedTarget = target.replace(/^\//, "").replace(/^\.\.\//, "");
    const sheetPath = normalizedTarget.startsWith("xl/") ? normalizedTarget : `xl/${normalizedTarget}`;
    const xml = await zip.file(sheetPath)?.async("string"); if (!xml) continue;
    const rows: unknown[][] = [];
    for (const cellMatch of xml.matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
      const cellAttrs = cellMatch[1]; const body = cellMatch[2]; const address = cellAttrs.match(/\br="([A-Z]+\d+)"/i)?.[1]; if (!address) continue;
      const rowNumber = Number(address.match(/(\d+)$/)?.[1] ?? 0); const colNumber = columnIndex(address); if (!rowNumber || rowNumber > 500 || !colNumber || colNumber > 200) continue;
      const type = cellAttrs.match(/\bt="([^"]+)"/)?.[1] ?? "n"; const rawValue = body.match(/<v>([\s\S]*?)<\/v>/)?.[1] ?? ""; const formula = body.match(/<f(?:\s[^>]*)?>([\s\S]*?)<\/f>/)?.[1];
      let value: unknown;
      if (type === "s") value = shared[Number(rawValue)] ?? rawValue;
      else if (type === "inlineStr") value = [...body.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((item) => decodeOfficeXml(item[1])).join("");
      else if (type === "b") value = rawValue === "1";
      else if (type === "str") value = decodeOfficeXml(rawValue);
      else { const numberValue = Number(rawValue); value = rawValue !== "" && Number.isFinite(numberValue) ? numberValue : decodeOfficeXml(rawValue); }
      if (formula) value = { formula: decodeOfficeXml(formula), result: value };
      const row = rows[rowNumber - 1] ?? []; rows[rowNumber - 1] = row; row[colNumber] = value;
    }
    sheets.push({ name, rows });
  }
  return sheets;
}
export const WORD_DIRECT_COMPAT_PREFIX = "NHD_WORD_DIRECT_V1:";

type WordDirectCompatibilityPayload = {
  mode: "append" | "insert_at_cursor";
  blocks: WordInsertBlock[];
  cursorOffset?: number;
};

export function encodeWordDirectCompatibilityEnvelope(payload: WordDirectCompatibilityPayload) {
  return WORD_DIRECT_COMPAT_PREFIX + Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

export function decodeWordDirectCompatibilityEnvelope(text: string): OfficeLiveOperation | null {
  if (!String(text ?? "").startsWith(WORD_DIRECT_COMPAT_PREFIX)) return null;
  const encoded = String(text).slice(WORD_DIRECT_COMPAT_PREFIX.length);
  if (!encoded || encoded.length > 19_500) throw new Error("Invalid Word Direct compatibility envelope.");
  let payload: WordDirectCompatibilityPayload;
  try { payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as WordDirectCompatibilityPayload; }
  catch { throw new Error("Invalid Word Direct compatibility envelope encoding."); }
  if (!payload || !["append", "insert_at_cursor"].includes(String(payload.mode))) throw new Error("Invalid Word Direct compatibility mode.");
  if (!Array.isArray(payload.blocks)) throw new Error("Word Direct compatibility blocks are required.");
  const operation: OfficeLiveOperation = payload.mode === "append"
    ? { type: "word_append", blocks: payload.blocks, cursorOffset: payload.cursorOffset }
    : { type: "word_insert_at_cursor", blocks: payload.blocks, cursorOffset: payload.cursorOffset };
  validateLiveOperation("word", operation);
  return operation;
}

function liveAction(application: OfficeLiveApplication, kind: "inspect" | "apply") {
  return `${application}_${kind}`;
}

export type OfficeQaLevel = "machine" | "structural" | "visual";
export type OfficeLiveOperationType = OfficeLiveOperation["type"];
export function qaLevelForOperationType(type: OfficeLiveOperationType, hasFormatting = false): OfficeQaLevel {
  if (["word_format","word_format_paragraphs","word_page_setup","excel_format_range","powerpoint_format_selected_text","powerpoint_set_selected_shape_geometry"].includes(type)) return "visual";
  if (type === "word_insert_at_cursor" || type === "word_append") return hasFormatting ? "visual" : "structural";
  if (["replace_selection","word_replace_paragraph","excel_set_range","excel_set_formula","powerpoint_replace_selected_text"].includes(type)) return "structural";
  return "machine";
}
export function qaLevelForOperation(operation: OfficeLiveOperation): OfficeQaLevel {
  if (operation.type === "word_insert_at_cursor" || operation.type === "word_append") {
    return qaLevelForOperationType(operation.type, operation.blocks.some((block) => block.format && Object.keys(block.format).length > 0));
  }
  return qaLevelForOperationType(operation.type);
}

function operationTarget(application: OfficeLiveApplication, operation: OfficeLiveOperation) {
  if (application === "word") {
    if (operation.type === "replace_selection") return { scope: "selection" };
    if (operation.type === "word_insert_at_cursor") return { scope: "cursor" };
    if (operation.type === "word_append") return { scope: "document_end" };
    if (operation.type === "word_format") return { scope: operation.scope };
    if (operation.type === "word_format_paragraphs") return { scope: "paragraphs", paragraphStart: operation.startParagraph, paragraphEnd: operation.endParagraph ?? operation.startParagraph };
    if (operation.type === "word_replace_paragraph") return { scope: "paragraphs", paragraphStart: operation.paragraph, paragraphEnd: operation.paragraph };
    if (operation.type === "word_page_setup") return { scope: operation.scope };
    return { scope: "document" };
  }
  if (application === "excel") {
    if (operation.type === "excel_set_range" || operation.type === "excel_set_formula" || operation.type === "excel_format_range") return { address: operation.address ?? null };
    return { address: null };
  }
  if (operation.type === "powerpoint_set_selected_shape_geometry") return { scope: "selection", geometry: true };
  return { scope: "selection" };
}

function validateLiveOperation(application: OfficeLiveApplication, operation: OfficeLiveOperation) {
  if (application === "word") {
    if (!["replace_selection", "word_insert_at_cursor", "word_append", "word_format", "word_format_paragraphs", "word_replace_paragraph", "word_page_setup", "word_save"].includes(operation.type)) throw new Error(`Operation ${operation.type} is not valid for Word.`);
    if (operation.type === "replace_selection" && operation.text.length > 20_000) throw new Error("Word live replacement is limited to 20,000 characters.");
    if (operation.type === "word_insert_at_cursor" || operation.type === "word_append") {
      if (!Array.isArray(operation.blocks) || operation.blocks.length < 1 || operation.blocks.length > 200) throw new Error("Word live insert requires 1-200 blocks.");
      const total = operation.blocks.reduce((sum, block) => sum + String(block.text ?? "").length, 0);
      if (total < 1 || total > 20_000) throw new Error("Word live insert is limited to 20,000 characters total.");
      if (operation.blocks.some((block) => !String(block.text ?? "").length)) throw new Error("Word live insert blocks cannot be empty.");
      if (operation.cursorOffset != null && (!Number.isInteger(operation.cursorOffset) || operation.cursorOffset < 0 || operation.cursorOffset > total)) throw new Error("Word live cursorOffset must be within the inserted text.");
    }
    if (operation.type === "word_replace_paragraph" && operation.text.length > 20_000) throw new Error("Word paragraph replacement is limited to 20,000 characters.");
    if (operation.type === "word_format_paragraphs") {
      const end = operation.endParagraph ?? operation.startParagraph;
      if (!Number.isInteger(operation.startParagraph) || !Number.isInteger(end) || operation.startParagraph < 1 || end < operation.startParagraph || end - operation.startParagraph > 500) throw new Error("Word paragraph range is invalid or too large.");
    }
    if (operation.type === "word_replace_paragraph" && (!Number.isInteger(operation.paragraph) || operation.paragraph < 1)) throw new Error("Word paragraph index must be a positive integer.");
    if (operation.type === "word_replace_paragraph" && /[\r\n]/.test(operation.text)) throw new Error("Word paragraph replacement cannot contain newline characters.");
    return;
  }
  if (application === "excel") {
    if (!["excel_set_range", "excel_set_formula", "excel_format_range", "excel_save"].includes(operation.type)) throw new Error(`Operation ${operation.type} is not valid for Excel.`);
    if (operation.type === "excel_set_range") {
      const rows = operation.values.length;
      const cols = rows ? Math.max(...operation.values.map((row) => row.length)) : 0;
      if (!rows || !cols) throw new Error("excel_set_range requires at least one value.");
      if (rows * cols > 2000) throw new Error("Excel live writes are limited to 2,000 cells per operation.");
      if (operation.values.some((row) => row.length !== cols)) throw new Error("Excel values must be a rectangular matrix.");
    }
    if (operation.type === "excel_set_formula" && operation.formula.length > 8000) throw new Error("Excel formula is too long.");
    return;
  }
  if (!["powerpoint_replace_selected_text", "powerpoint_format_selected_text", "powerpoint_set_selected_shape_geometry", "powerpoint_save"].includes(operation.type)) throw new Error(`Operation ${operation.type} is not valid for PowerPoint.`);
  if (operation.type === "powerpoint_replace_selected_text" && operation.text.length > 20_000) throw new Error("PowerPoint live replacement is limited to 20,000 characters.");
  if (operation.type === "powerpoint_set_selected_shape_geometry" && operation.leftPt == null && operation.topPt == null && operation.widthPt == null && operation.heightPt == null) throw new Error("PowerPoint geometry operation requires at least one geometry value.");
}

export class OfficeService {
  constructor(readonly config: AppConfig, readonly store: Store, readonly files: FileService) {}

  private liveResourceKeys(application: OfficeLiveApplication, livePath?: string, pathScoped = false): string[] {
    if (pathScoped && livePath) return [canonicalizeFilePathResource(livePath, this.config.roots)];
    const resources: string[] = [`office:live:${application}`];
    const trimmed = String(livePath ?? "").trim();
    if (trimmed && /^[A-Za-z]:[\\/]/.test(trimmed)) {
      try {
        resources.push(canonicalizeFilePathResource(trimmed));
      } catch {
        // Keep session-level resource guard if path is unsaved/non-filesystem.
      }
    }
    return resources;
  }

  async status() {
    try {
      const response = await fetch(`http://127.0.0.1:${this.config.officePort}/status`, { headers: { "x-workstation-companion-secret": this.config.companionSecret }, signal: AbortSignal.timeout(1500) });
      if (!response.ok) throw new Error(String(response.status));
      return { companion: true, ...(await response.json() as Record<string, unknown>) };
    } catch {
      return { companion: false, word: false, excel: false, powerpoint: false, outlook: false, offlineEditing: true, liveV2: false };
    }
  }

  async read(pathInput: string) {
    const path = this.files.resolvePath(pathInput);
    const ext = extname(path).toLowerCase();
    if (ext === ".docx") {
      const text = (await mammoth.extractRawText({ path })).value;
      let tables: ReturnType<typeof docxTables> = [];
      try { const zip = await JSZip.loadAsync(readFileSync(path)); const documentXml = await zip.file("word/document.xml")?.async("string"); if (documentXml) tables = docxTables(documentXml); } catch {}
      return { path, kind: "docx", text, paragraphCount: text.split(/\n+/).filter((item) => item.trim()).length, tables };
    }
    if (ext === ".xlsx" || ext === ".xlsm") {
      try {
        const workbook = new ExcelJS.Workbook();
        await workbook.xlsx.readFile(path);
        const sheets = workbook.worksheets.map((sheet) => ({ name: sheet.name, rows: sheet.getSheetValues().slice(1, 501) }));
        return { path, kind: "xlsx", parser: "exceljs", sheets };
      } catch (error) {
        const sheets = await xlsxXmlFallback(path);
        return { path, kind: "xlsx", parser: "xlsx-xml-fallback", parserWarning: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500), sheets };
      }
    }
    if (ext === ".pptx") {
      const zip = await JSZip.loadAsync(readFileSync(path));
      const slides: Array<{ slide: string; text: string }> = [];
      for (const name of Object.keys(zip.files).filter((item) => /^ppt\/slides\/slide\d+\.xml$/i.test(item)).sort((a,b) => Number(a.match(/slide(\d+)/i)?.[1] ?? 0) - Number(b.match(/slide(\d+)/i)?.[1] ?? 0))) {
        const xml = await zip.file(name)!.async("string");
        slides.push({ slide: name, text: officeXmlText(xml, "a") });
      }
      return { path, kind: "pptx", slides };
    }
    throw new Error("Supported Office formats: DOCX, XLSX, XLSM, PPTX.");
  }

  previewEdit(pathInput: string, operation: OfficeOperation, taskRunId?: string) {
    if (this.config.emergencyStop || !this.config.writeEnabled) throw new Error("Office writes are disabled.");
    const path = this.files.resolvePath(pathInput);
    if (operation.type === "replace_text") assertNoIntroducedRedaction(String(operation.replace ?? ""), String(operation.find ?? ""), "office_preview_edit");
    else if (operation.type === "set_cell") assertNoIntroducedRedaction(String(operation.value ?? ""), "", "office_preview_edit");
    const effectiveTaskRunId = resolveTaskRunId(taskRunId, operation as unknown as Record<string, unknown>);
    const actionId = this.store.allocatePendingId();
    const ephemeralOwnerId = effectiveTaskRunId ? undefined : createEphemeralOwnerId("pending", actionId);
    this.store.guardResources([canonicalizeFilePathResource(path, this.config.roots)], {
      mode: "write",
      taskRunId: effectiveTaskRunId,
      ephemeralOwnerId,
      ttlSeconds: 300,
      operation: "office_preview_edit",
    });
    const expectedHash = this.files.hashFile(path);
    const pending = this.store.createPending(
      "office:edit",
      {
        path,
        operation,
        ...(effectiveTaskRunId ? { taskRunId: effectiveTaskRunId } : {}),
        ...(ephemeralOwnerId ? { ephemeralOwnerId } : {}),
      },
      expectedHash,
      300,
      actionId,
    );
    this.store.audit("office_preview_edit", "pending", { path, operation: operation.type, actionId: pending.id, taskRunId: effectiveTaskRunId ?? ephemeralOwnerId ?? null });
    return { actionId: pending.id, confirmationToken: pending.confirmationToken, expiresAt: pending.expiresAt, expectedHash, path, operation };
  }

  async applyEdit(actionId: string, confirmationToken: string, taskRunId?: string) {
    if (this.config.emergencyStop || !this.config.writeEnabled) throw new Error("Office writes are disabled.");
    const previewPending = this.store.getPending(actionId, confirmationToken);
    if (previewPending.kind !== "office:edit") throw new Error("Pending action is not an Office edit.");
    const previewPath = this.files.resolvePath(String(previewPending.payload.path));
    const recordedTaskRunId = typeof previewPending.payload.taskRunId === "string" ? previewPending.payload.taskRunId.trim() : undefined;
    const recordedEphemeralOwnerId = typeof previewPending.payload.ephemeralOwnerId === "string" ? previewPending.payload.ephemeralOwnerId.trim() : undefined;
    const explicitTaskRunId = resolveTaskRunId(taskRunId);
    if (explicitTaskRunId && recordedTaskRunId && explicitTaskRunId !== recordedTaskRunId) {
      throw new Error(`Foreign pending Office edit denied: action belongs to task '${recordedTaskRunId}', not '${explicitTaskRunId}'.`);
    }
    if (explicitTaskRunId && !recordedTaskRunId && recordedEphemeralOwnerId) {
      throw new Error(`Foreign pending Office edit denied: anonymous preview cannot be applied by task '${explicitTaskRunId}'.`);
    }
    const effectiveTaskRunId = explicitTaskRunId ?? recordedTaskRunId;
    this.store.guardResources([canonicalizeFilePathResource(previewPath, this.config.roots)], {
      mode: "write",
      taskRunId: effectiveTaskRunId,
      ephemeralOwnerId: recordedEphemeralOwnerId,
      operation: "office_apply_edit",
    });

    try {
      const pending = this.store.consumePending(actionId, confirmationToken);
      const path = previewPath;
      if (!pending.expectedHash || this.files.hashFile(path) !== pending.expectedHash) throw new Error("Office file changed after preview.");
      const operation = pending.payload.operation as OfficeOperation;
      const backup = resolve(this.config.backupDir, `${Date.now()}-${sha256(path).slice(0, 12)}-${basename(path)}`);
      mkdirSync(dirname(backup), { recursive: true });
      copyFileSync(path, backup);
      const ext = extname(path).toLowerCase();
      if (operation.type === "set_cell") {
        if (ext !== ".xlsx" && ext !== ".xlsm") throw new Error("set_cell requires XLSX or XLSM.");
        const workbook = new ExcelJS.Workbook();
        await workbook.xlsx.readFile(path);
        const sheet = workbook.getWorksheet(operation.sheet);
        if (!sheet) throw new Error(`Unknown sheet: ${operation.sheet}`);
        sheet.getCell(operation.cell).value = operation.value;
        await workbook.xlsx.writeFile(path);
      } else {
        if (ext !== ".docx" && ext !== ".pptx") throw new Error("replace_text requires DOCX or PPTX.");
        const zip = await JSZip.loadAsync(readFileSync(path));
        const pattern = ext === ".docx" ? /^word\/(document|header\d+|footer\d+)\.xml$/i : /^ppt\/slides\/slide\d+\.xml$/i;
        let replacements = 0;
        for (const name of Object.keys(zip.files).filter((item) => pattern.test(item))) {
          const xml = await zip.file(name)!.async("string");
          const next = xml.split(operation.find).join(operation.replace);
          if (next !== xml) { replacements += xml.split(operation.find).length - 1; zip.file(name, next); }
        }
        if (!replacements) throw new Error("Text was not found in editable Office XML runs.");
        writeFileSync(path, await zip.generateAsync({ type: "nodebuffer" }));
      }
      this.store.audit("office_apply_edit", "success", { path, operation: operation.type, backup, actionId, taskRunId: effectiveTaskRunId ?? recordedEphemeralOwnerId ?? null });
      return { applied: true, path, operation: operation.type, backup, at: nowIso() };
    } finally {
      if (recordedEphemeralOwnerId) {
        this.store.releaseEphemeralOwnerResources(recordedEphemeralOwnerId, "office_apply_edit_completed");
      }
    }
  }

  previewExport(application: "word" | "excel" | "powerpoint", pathInput: string, outputInput: string, taskRunId?: string) {
    if (this.config.emergencyStop || !this.config.writeEnabled) throw new Error("Office exports are disabled.");
    const path = this.files.resolvePath(pathInput);
    const output = this.files.resolvePath(outputInput);
    const allowed = application === "word" ? [".docx"] : application === "excel" ? [".xlsx", ".xlsm"] : [".pptx"];
    if (!allowed.includes(extname(path).toLowerCase())) throw new Error(`Input file is not supported for ${application}.`);
    if (extname(output).toLowerCase() !== ".pdf") throw new Error("Office export output must be a PDF file.");
    const effectiveTaskRunId = resolveTaskRunId(taskRunId);
    const actionId = this.store.allocatePendingId();
    const ephemeralOwnerId = effectiveTaskRunId ? undefined : createEphemeralOwnerId("pending", actionId);
    this.store.guardResources(
      [canonicalizeFilePathResource(path, this.config.roots), canonicalizeFilePathResource(output, this.config.roots)],
      {
        mode: "write",
        taskRunId: effectiveTaskRunId,
        ephemeralOwnerId,
        ttlSeconds: 300,
        operation: "office_preview_export_pdf",
      },
    );
    const inputHash = this.files.hashFile(path);
    const outputHash = existsSync(output) ? this.files.hashFile(output) : null;
    const pending = this.store.createPending(
      "office:export_pdf",
      {
        application,
        path,
        output,
        inputHash,
        outputHash,
        ...(effectiveTaskRunId ? { taskRunId: effectiveTaskRunId } : {}),
        ...(ephemeralOwnerId ? { ephemeralOwnerId } : {}),
      },
      inputHash,
      300,
      actionId,
    );
    this.store.audit("office_preview_export_pdf", "pending", { application, path, output, actionId: pending.id, taskRunId: effectiveTaskRunId ?? ephemeralOwnerId ?? null });
    return { actionId: pending.id, confirmationToken: pending.confirmationToken, expiresAt: pending.expiresAt, application, path, output, inputHash, outputHash };
  }

  async applyExport(actionId: string, confirmationToken: string, taskRunId?: string) {
    if (this.config.emergencyStop || !this.config.writeEnabled) throw new Error("Office exports are disabled.");
    const previewPending = this.store.getPending(actionId, confirmationToken);
    if (previewPending.kind !== "office:export_pdf") throw new Error("Pending action is not an Office PDF export.");
    const previewPath = this.files.resolvePath(String(previewPending.payload.path));
    const previewOutput = this.files.resolvePath(String(previewPending.payload.output));
    const recordedTaskRunId = typeof previewPending.payload.taskRunId === "string" ? previewPending.payload.taskRunId.trim() : undefined;
    const recordedEphemeralOwnerId = typeof previewPending.payload.ephemeralOwnerId === "string" ? previewPending.payload.ephemeralOwnerId.trim() : undefined;
    const explicitTaskRunId = resolveTaskRunId(taskRunId);
    if (explicitTaskRunId && recordedTaskRunId && explicitTaskRunId !== recordedTaskRunId) {
      throw new Error(`Foreign pending Office export denied: action belongs to task '${recordedTaskRunId}', not '${explicitTaskRunId}'.`);
    }
    if (explicitTaskRunId && !recordedTaskRunId && recordedEphemeralOwnerId) {
      throw new Error(`Foreign pending Office export denied: anonymous preview cannot be applied by task '${explicitTaskRunId}'.`);
    }
    const effectiveTaskRunId = explicitTaskRunId ?? recordedTaskRunId;
    this.store.guardResources(
      [canonicalizeFilePathResource(previewPath, this.config.roots), canonicalizeFilePathResource(previewOutput, this.config.roots)],
      {
        mode: "write",
        taskRunId: effectiveTaskRunId,
        ephemeralOwnerId: recordedEphemeralOwnerId,
        operation: "office_apply_export_pdf",
      },
    );

    try {
      const pending = this.store.consumePending(actionId, confirmationToken);
      const application = String(pending.payload.application) as "word" | "excel" | "powerpoint";
      const path = previewPath;
      const output = previewOutput;
      if (this.files.hashFile(path) !== String(pending.payload.inputHash)) throw new Error("Office input changed after preview.");
      const expectedOutputHash = pending.payload.outputHash == null ? null : String(pending.payload.outputHash);
      if (expectedOutputHash === null && existsSync(output)) throw new Error("Office output appeared after preview.");
      if (expectedOutputHash !== null && (!existsSync(output) || this.files.hashFile(output) !== expectedOutputHash)) throw new Error("Office output changed after preview.");

      mkdirSync(dirname(output), { recursive: true });
      const temporaryOutput = this.files.resolvePath(resolve(dirname(output), `.workstation-export-${randomToken(8)}.pdf`));
      let backup: string | null = null;
      try {
        await this.live(`${application}_export_pdf`, { path, output: temporaryOutput });
        if (!existsSync(temporaryOutput)) throw new Error("Office Companion did not create the exported PDF.");
        if (existsSync(output)) {
          backup = resolve(this.config.backupDir, `${Date.now()}-${sha256(output).slice(0, 12)}-${basename(output)}`);
          mkdirSync(dirname(backup), { recursive: true });
          copyFileSync(output, backup);
        }
        copyFileSync(temporaryOutput, output);
      } finally {
        if (existsSync(temporaryOutput)) rmSync(temporaryOutput, { force: true });
      }
      this.store.audit("office_apply_export_pdf", "success", { application, path, output, backup, actionId, taskRunId: effectiveTaskRunId ?? recordedEphemeralOwnerId ?? null });
      return { applied: true, application, path, output, backup, at: nowIso() };
    } finally {
      if (recordedEphemeralOwnerId) {
        this.store.releaseEphemeralOwnerResources(recordedEphemeralOwnerId, "office_apply_export_pdf_completed");
      }
    }
  }

  async inspectLive(application: OfficeLiveApplication, options: { detail?: "summary" | "context" | "full"; contextChars?: number; target?: Record<string, unknown> } & WordLivePathOptions = {}) {
    const contextChars = Math.max(0, Math.min(20_000, options.contextChars ?? 4_000));
    if (options.path && application !== "word") throw new Error("Word Live path is supported only for application=word.");
    return this.live(liveAction(application, "inspect"), { detail: options.detail ?? "context", contextChars, target: options.target ?? {}, ...(options.path ? {path: options.path, read_only: options.read_only === true, remove_stale_lock: options.remove_stale_lock === true} : {}) });
  }

  async previewLiveEdit(application: OfficeLiveApplication, operation: OfficeLiveOperation, taskRunId?: string, pathOptions: WordLivePathOptions = {}) {
    if (pathOptions.path && application !== "word") throw new Error("Word Live path is supported only for application=word.");
    if (this.config.emergencyStop || !this.config.writeEnabled) throw new Error("Office live writes are disabled.");
    const effectiveTaskRunId = resolveTaskRunId(taskRunId, operation as unknown as Record<string, unknown>);

    let effectiveOperation: OfficeLiveOperation = operation;
    let compatibilityFastLane = false;
    if (application === "word" && operation.type === "replace_selection") {
      const compatibilityOperation = decodeWordDirectCompatibilityEnvelope(operation.text);
      if (compatibilityOperation) {
        effectiveOperation = compatibilityOperation;
        compatibilityFastLane = true;
      }
    }
    validateLiveOperation(application, effectiveOperation);
    const legacySelectionReplace = application === "word" && operation.type === "replace_selection" && !compatibilityFastLane && !pathOptions.path;
    if (!legacySelectionReplace) assertLiveOperationRedactionSafe(effectiveOperation);

    // Preserve the original v0.5 Word selection transaction contract for existing clients/tests.
    // Only an exact NHD_WORD_DIRECT_V1 envelope bypasses legacy selection replacement; it is
    // decoded into the same V2 word_append / word_insert_at_cursor operation used by new clients.
    if (application === "word" && operation.type === "replace_selection" && !compatibilityFastLane && !pathOptions.path) {
      const current = await this.live("word_selection_read", {});
      if (!current.open || !current.selection || typeof current.selection !== "object") throw new Error("Word has no active document selection.");
      const selection = current.selection as Record<string, unknown>;
      const start = Number(selection.start ?? -1);
      const end = Number(selection.end ?? -1);
      const text = String(selection.text ?? "");
      if (!(end > start) || !text) throw new Error("Select non-empty Word text before previewing a live edit.");
      assertLiveOperationRedactionSafe(effectiveOperation, text);
      const baseline = { path: String(current.path ?? ""), name: String(current.name ?? ""), start, end, text };
      const actionId = this.store.allocatePendingId();
      const ephemeralOwnerId = effectiveTaskRunId ? undefined : createEphemeralOwnerId("pending", actionId);
      this.store.guardResources(this.liveResourceKeys(application, baseline.path, !!pathOptions.path), {
        mode: "write",
        taskRunId: effectiveTaskRunId,
        ephemeralOwnerId,
        ttlSeconds: 300,
        operation: "office_live_preview_edit",
      });
      const expectedHash = sha256(JSON.stringify(baseline));
      const pending = this.store.createPending(
        "office:live_edit",
        {
          application,
          operation,
          baseline,
          ...(effectiveTaskRunId ? { taskRunId: effectiveTaskRunId } : {}),
          ...(ephemeralOwnerId ? { ephemeralOwnerId } : {}),
        },
        expectedHash,
        300,
        actionId,
      );
      this.store.audit("office_live_preview_edit", "pending", { application, actionId: pending.id, path: baseline.path, start, end, operation: operation.type, legacyCompatible: true, taskRunId: effectiveTaskRunId ?? ephemeralOwnerId ?? null });
      return { actionId: pending.id, confirmationToken: pending.confirmationToken, expiresAt: pending.expiresAt, application, operation, baseline, expectedHash };
    }

    const target = operationTarget(application, effectiveOperation);
    const current = await this.inspectLive(application, { detail: "summary", contextChars: 0, target, ...pathOptions });
    if (!current.open) throw new Error(`${application} has no active document/workbook/presentation.`);
    const fingerprint = String(current.fingerprint ?? "");
    if (!fingerprint) throw new Error("Office Live V2 inspect did not return a stable fingerprint.");
    const baseline = {
      application,
      path: String(current.path ?? ""),
      name: String(current.name ?? ""),
      fingerprint,
      target,
    };
    const actionId = this.store.allocatePendingId();
    const ephemeralOwnerId = effectiveTaskRunId ? undefined : createEphemeralOwnerId("pending", actionId);
    this.store.guardResources(this.liveResourceKeys(application, baseline.path, !!pathOptions.path), {
      mode: "write",
      taskRunId: effectiveTaskRunId,
      ephemeralOwnerId,
      ttlSeconds: 300,
      operation: "office_live_preview_edit",
    });
    const expectedHash = sha256(JSON.stringify(baseline));
    const pending = this.store.createPending(
      "office:live_edit_v2",
      {
        application,
        operation: effectiveOperation,
        baseline,
        compatibilityFastLane,
        ...(pathOptions.path ? { pathOptions } : {}),
        ...(effectiveTaskRunId ? { taskRunId: effectiveTaskRunId } : {}),
        ...(ephemeralOwnerId ? { ephemeralOwnerId } : {}),
      },
      expectedHash,
      300,
      actionId,
    );
    this.store.audit("office_live_preview_edit", "pending", { application, actionId: pending.id, path: baseline.path, operation: effectiveOperation.type, target, compatibilityFastLane, taskRunId: effectiveTaskRunId ?? ephemeralOwnerId ?? null });
    return { actionId: pending.id, confirmationToken: pending.confirmationToken, expiresAt: pending.expiresAt, application, operation: effectiveOperation, baseline, expectedHash, compatibilityFastLane };
  }

  async applyLiveEdit(actionId: string, confirmationToken: string, taskRunId?: string, requestedPath?: string) {
    if (this.config.emergencyStop || !this.config.writeEnabled) throw new Error("Office live writes are disabled.");
    const previewPending = this.store.getPending(actionId, confirmationToken);
    if (!["office:live_edit", "office:live_edit_v2"].includes(previewPending.kind)) throw new Error("Pending action is not an Office live edit.");
    const previewApp = String(previewPending.payload.application) as OfficeLiveApplication;
    const previewBaseline = (previewPending.payload.baseline ?? {}) as Record<string, unknown>;
    const originalPathOptions = (previewPending.payload.pathOptions ?? {}) as WordLivePathOptions;
    if (requestedPath && String(requestedPath).toLowerCase() !== String(originalPathOptions.path ?? "").toLowerCase()) {
      throw new Error("WORD_LIVE_PATH_MISMATCH: apply path differs from preview.");
    }
    const recordedTaskRunId = typeof previewPending.payload.taskRunId === "string" ? previewPending.payload.taskRunId.trim() : undefined;
    const recordedEphemeralOwnerId = typeof previewPending.payload.ephemeralOwnerId === "string" ? previewPending.payload.ephemeralOwnerId.trim() : undefined;
    const explicitTaskRunId = resolveTaskRunId(taskRunId);
    if (explicitTaskRunId && recordedTaskRunId && explicitTaskRunId !== recordedTaskRunId) {
      throw new Error(`Foreign pending Office live edit denied: action belongs to task '${recordedTaskRunId}', not '${explicitTaskRunId}'.`);
    }
    if (explicitTaskRunId && !recordedTaskRunId && recordedEphemeralOwnerId) {
      throw new Error(`Foreign pending Office live edit denied: anonymous preview cannot be applied by task '${explicitTaskRunId}'.`);
    }
    const effectiveTaskRunId = explicitTaskRunId ?? recordedTaskRunId;
    this.store.guardResources(this.liveResourceKeys(previewApp, String(previewBaseline.path ?? ""), !!originalPathOptions.path), {
      mode: "write",
      taskRunId: effectiveTaskRunId,
      ephemeralOwnerId: recordedEphemeralOwnerId,
      operation: "office_live_apply_edit",
    });

    try {
      const pending = this.store.consumePending(actionId, confirmationToken);

      // Backward compatibility for v0.5 selection-replacement pending actions.
      if (pending.kind === "office:live_edit") {
        const operation = pending.payload.operation as { type: string; text: string };
        const baseline = pending.payload.baseline as Record<string, unknown>;
        if (String(pending.payload.application) !== "word" || operation.type !== "replace_selection") throw new Error("Unsupported legacy Office live edit operation.");
        const current = await this.live("word_selection_read", {});
        const selection = current.selection && typeof current.selection === "object" ? current.selection as Record<string, unknown> : {};
        const currentBaseline = { path: String(current.path ?? ""), name: String(current.name ?? ""), start: Number(selection.start ?? -1), end: Number(selection.end ?? -1), text: String(selection.text ?? "") };
        if (!pending.expectedHash || sha256(JSON.stringify(currentBaseline)) !== pending.expectedHash) throw new Error("Word selection changed after preview; inspect and preview again.");
        await this.live("word_selection_replace", { text: operation.text });
        const verified = await this.live("word_selection_read", {});
        const verifiedSelection = verified.selection && typeof verified.selection === "object" ? verified.selection as Record<string, unknown> : {};
        if (normalizeText(verifiedSelection.text) !== normalizeText(operation.text)) throw new Error("Word live edit verification failed after apply.");
        this.store.audit("office_live_apply_edit", "success", { application: "word", actionId, path: baseline.path, operation: operation.type, legacy: true, taskRunId: effectiveTaskRunId ?? recordedEphemeralOwnerId ?? null });
        return { applied: true, application: "word", operation: operation.type, path: String(verified.path ?? baseline.path ?? ""), state: verified, verified: true, machineVerified: true, qaLevel: "structural", visualReviewRequired: false, completionState: "verified", at: nowIso() };
      }

      const application = String(pending.payload.application) as OfficeLiveApplication;
      const operation = pending.payload.operation as OfficeLiveOperation;
      const baseline = pending.payload.baseline as Record<string, unknown>;
      validateLiveOperation(application, operation);
      const target = operationTarget(application, operation);
      const pathOptions = (pending.payload.pathOptions ?? {}) as WordLivePathOptions;
      const current = await this.inspectLive(application, { detail: "summary", contextChars: 0, target, ...pathOptions });
      const currentBaseline = {
        application,
        path: String(current.path ?? ""),
        name: String(current.name ?? ""),
        fingerprint: String(current.fingerprint ?? ""),
        target,
      };
      if (!pending.expectedHash || sha256(JSON.stringify(currentBaseline)) !== pending.expectedHash) throw new Error("Office live target changed after preview; inspect and preview again.");

      const bridgeResult = await this.live(liveAction(application, "apply"), { operation, ...(pathOptions.path ? {path:pathOptions.path, read_only:pathOptions.read_only === true, remove_stale_lock:pathOptions.remove_stale_lock === true} : {}) });
      if (bridgeResult.verified !== true) throw new Error(String(bridgeResult.error ?? "Office Live V2 verification failed after apply."));
      const after = await this.inspectLive(application, { detail: "context", contextChars: 2_000, target, ...pathOptions });
      this.store.audit("office_live_apply_edit", "success", { application, actionId, path: baseline.path, operation: operation.type, target, verified: true, taskRunId: effectiveTaskRunId ?? recordedEphemeralOwnerId ?? null });
      const qaLevel = qaLevelForOperation(operation);
      return { applied: true, application, operation: operation.type, path: String(after.path ?? baseline.path ?? ""), state: after, receipt: bridgeResult.receipt ?? null, verified: true, machineVerified: true, qaLevel, visualReviewRequired: !pathOptions.path && qaLevel === "visual", completionState: pathOptions.path ? "verified_hidden_no_visual" : qaLevel === "visual" ? "awaiting_visual_review" : "verified", at: nowIso() };
    } finally {
      if (recordedEphemeralOwnerId) {
        this.store.releaseEphemeralOwnerResources(recordedEphemeralOwnerId, "office_live_apply_edit_completed");
      }
    }
  }

  async runLiveTransaction(application: OfficeLiveApplication, operations: OfficeLiveOperation[], taskRunId?: string, pathOptions: WordLivePathOptions = {}) {
    if (!Array.isArray(operations) || operations.length < 1 || operations.length > 20) throw new Error("Office live transaction requires 1-20 operations.");
    const effectiveTaskRunId = resolveTaskRunId(taskRunId);
    const startedAt = nowIso(); const receipts: unknown[] = []; let visualRequired = false;
    for (const operation of operations) {
      validateLiveOperation(application, operation);
      if (qaLevelForOperation(operation) === "visual") visualRequired = true;
      const previewed = await this.previewLiveEdit(application, operation, effectiveTaskRunId, pathOptions);
      receipts.push(await this.applyLiveEdit(previewed.actionId, previewed.confirmationToken, effectiveTaskRunId, pathOptions.path));
    }
    const state = await this.inspectLive(application, { detail: "context", contextChars: 2000, ...pathOptions });
    return { applied:true, application, operations:operations.map((item)=>item.type), operationCount:operations.length, receipts, state, verified:true, machineVerified:true, qaLevel:visualRequired?"visual":"structural", visualReviewRequired:!pathOptions.path&&visualRequired, completionState:pathOptions.path?"verified_hidden_no_visual":visualRequired?"awaiting_visual_review":"verified", startedAt, completedAt:nowIso() };
  }

  async closeWordLive(path: string) { return this.live("word_close", { path }); }
  async listWordLiveSessions() { return this.live("word_sessions", {}); }

  async live(action: string, input: Record<string, unknown>) {
    if (action.startsWith("outlook_") && !["outlook_search", "outlook_read"].includes(action)) throw new Error("Outlook is read-only.");
    let response: Response;
    try {
      response = await fetch(`http://127.0.0.1:${this.config.officePort}/action`, { method:"POST", headers:{"content-type":"application/json","x-workstation-companion-secret":this.config.companionSecret}, body:JSON.stringify({action,input}), signal:AbortSignal.timeout(120000) });
    } catch (error) { throw new Error(`Office Companion is unavailable: ${error instanceof Error ? error.message : String(error)}`); }
    const body = await response.json() as Record<string, unknown>;
    if (!response.ok) throw new Error(String(body.error ?? response.statusText));
    this.store.audit(`office_live_${action}`, "success", { action, keys:Object.keys(input) });
    return body;
  }

}

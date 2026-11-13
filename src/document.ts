import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, resolve } from "node:path";
import JSZip from "jszip";
import { AppConfig } from "./config.js";
import { Store } from "./db.js";
import { FileService } from "./files.js";
import { DocumentNode, EdgeType, ProjectService } from "./project.js";
import { OfficeService } from "./office.js";
import { canonicalizeFilePathResource, canonicalizeProjectResource, createEphemeralOwnerId, resolveTaskRunId } from "./resource-guard.js";
import { assertNoIntroducedRedaction, nowIso, randomToken, sha256 } from "./security.js";

export type ContentBlock = { type: "heading" | "article" | "clause" | "subClause" | "paragraph" | "note"; text: string; number?: string; level?: string };
type Paragraph = { index: number; raw: string; paraId: string | null; text: string; pPr: string; rPr: string; fingerprint: string };

const textOf = (xml: string) => [...xml.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)].map((match) => match[1].replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")).join("");
const normalized = (text: string) => text.normalize("NFC").replace(/\s+/g, " ").trim().toLocaleLowerCase("vi");
const xml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function paragraphs(documentXml: string): Paragraph[] {
  const result: Paragraph[] = []; const expression = /<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g; let match: RegExpExecArray | null; let index = 0;
  while ((match = expression.exec(documentXml))) {
    const raw = match[0]; const start = raw.match(/\bw14:paraId="([^"]+)"/); const pPr = raw.match(/<w:pPr>[\s\S]*?<\/w:pPr>/)?.[0] ?? ""; const rPr = raw.match(/<w:rPr>[\s\S]*?<\/w:rPr>/)?.[0] ?? ""; const text = textOf(raw);
    result.push({ index: index++, raw, paraId: start?.[1] ?? null, text, pPr, rPr, fingerprint: sha256(normalized(text)).slice(0, 20) });
  }
  return result;
}

function headingKind(text: string) {
  if (/^CHƯƠNG\s+[IVXLCDM]+\.?/iu.test(text.trim())) return "chapter";
  if (/^Điều\s+\d+\.?/iu.test(text.trim())) return "article";
  return null;
}
function headingId(text: string, fallback: number) {
  const chapter = text.match(/^CHƯƠNG\s+([IVXLCDM]+)/iu); if (chapter) return `chapter:${chapter[1].toUpperCase()}`;
  const article = text.match(/^Điều\s+(\d+)/iu); if (article) return `article:${article[1]}`;
  return `section:${fallback}`;
}
const clauseNumber = (text: string) => text.match(/^\s*(\d+)\.[\s\u00A0]+/u)?.[1] ?? null;

export class DocumentService {
  /** Test-only failure hook used to prove a failed map commit restores the original file. */
  failBeforeMapCommit = false;
  constructor(readonly config: AppConfig, readonly store: Store, readonly files: FileService, readonly projects: ProjectService, readonly office?: OfficeService) {}

  async index(root: string, pathInput: string, documentId?: string, taskRunId?: string) {
    const path = this.files.resolvePath(pathInput); if (extname(path).toLowerCase() !== ".docx") throw new Error("Structured document indexing currently supports DOCX only.");
    const status = this.projects.status(root);
    const effectiveTaskRunId = resolveTaskRunId(taskRunId);
    const ephemeralOwnerId = effectiveTaskRunId ? undefined : createEphemeralOwnerId("op");
    this.store.guardResources([canonicalizeFilePathResource(path, this.config.roots)], {
      mode: "read",
      taskRunId: effectiveTaskRunId,
      ephemeralOwnerId,
      operation: "document_index_read",
    });
    this.store.guardResources([canonicalizeProjectResource(status.root, "document_map")], {
      mode: "write",
      taskRunId: effectiveTaskRunId,
      ephemeralOwnerId,
      operation: "document_index",
    });
    try {
      const { document, nodes, edges } = await this.buildMap(path, documentId);
      const saved = this.projects.replaceDocumentMap(root, document, nodes, edges);
      this.store.audit("document_index", "success", { path, root, ...saved });
      return { summary: `Indexed ${nodes.length} logical nodes`, document, ...saved };
    } finally {
      if (ephemeralOwnerId) {
        this.store.releaseEphemeralOwnerResources(ephemeralOwnerId, "document_index_completed");
      }
    }
  }

  async previewReplace(root: string, documentId: string, nodeId: string, blocks: ContentBlock[], formattingStrategy: "inherit_adjacent" | "preserve_source" = "inherit_adjacent", editSessionId?: string, taskRunId?: string) {
    if (this.config.emergencyStop || !this.config.writeEnabled) throw new Error("Document writes are disabled.");
    if (!blocks.length || blocks.some((block) => !block.text.trim())) throw new Error("Structured content must contain non-empty blocks.");
    const status = this.projects.status(root); const node = this.projects.getNode(root, documentId, nodeId); const path = this.documentPath(root, documentId);
    assertNoIntroducedRedaction(blocks.map((block) => block.text).join("\n"), JSON.stringify(node ?? ""), "document_edit_preview");
    const effectiveTaskRunId = resolveTaskRunId(taskRunId);
    const actionId = this.store.allocatePendingId();
    const ephemeralOwnerId = effectiveTaskRunId ? undefined : createEphemeralOwnerId("pending", actionId);
    this.store.guardResources(
      [canonicalizeFilePathResource(path, this.config.roots), canonicalizeProjectResource(status.root, "document_map")],
      {
        mode: "write",
        taskRunId: effectiveTaskRunId,
        ephemeralOwnerId,
        ttlSeconds: 300,
        operation: "document_preview_replace",
      },
    );
    await this.assertWordIsNotEditing(path); const expectedHash = this.files.hashFile(path);
    const pending = this.store.createPending(
      "document:replace",
      {
        root,
        documentId,
        nodeId,
        path,
        blocks,
        formattingStrategy,
        editSessionId: editSessionId ?? null,
        ...(effectiveTaskRunId ? { taskRunId: effectiveTaskRunId } : {}),
        ...(ephemeralOwnerId ? { ephemeralOwnerId } : {}),
      },
      expectedHash,
      300,
      actionId,
    );
    this.store.audit("document_preview_replace", "pending", { projectId: status.projectId, documentId, nodeId, actionId: pending.id, blocks: blocks.length, formattingStrategy, taskRunId: effectiveTaskRunId ?? ephemeralOwnerId ?? null });
    return { actionId: pending.id, confirmationToken: pending.confirmationToken, expiresAt: pending.expiresAt, expectedHash, target: { id: node.id, title: node.title }, blocks: blocks.map((block) => ({ type: block.type, characters: block.text.length })), formattingStrategy };
  }

  async applyReplace(actionId: string, confirmationToken: string, taskRunId?: string) {
    if (this.config.emergencyStop || !this.config.writeEnabled) throw new Error("Document writes are disabled.");
    const previewPending = this.store.getPending(actionId, confirmationToken);
    if (previewPending.kind !== "document:replace") throw new Error("Pending action is not a semantic document edit.");
    const previewPath = this.files.resolvePath(String(previewPending.payload.path));
    const previewRoot = String(previewPending.payload.root);
    const status = this.projects.status(previewRoot);
    const recordedTaskRunId = typeof previewPending.payload.taskRunId === "string" ? previewPending.payload.taskRunId.trim() : undefined;
    const recordedEphemeralOwnerId = typeof previewPending.payload.ephemeralOwnerId === "string" ? previewPending.payload.ephemeralOwnerId.trim() : undefined;
    const explicitTaskRunId = resolveTaskRunId(taskRunId);
    if (explicitTaskRunId && recordedTaskRunId && explicitTaskRunId !== recordedTaskRunId) {
      throw new Error(`Foreign pending document action denied: action belongs to task '${recordedTaskRunId}', not '${explicitTaskRunId}'.`);
    }
    if (explicitTaskRunId && !recordedTaskRunId && recordedEphemeralOwnerId) {
      throw new Error(`Foreign pending document action denied: anonymous preview cannot be applied by task '${explicitTaskRunId}'.`);
    }
    const effectiveTaskRunId = explicitTaskRunId ?? recordedTaskRunId;
    this.store.guardResources(
      [canonicalizeFilePathResource(previewPath, this.config.roots), canonicalizeProjectResource(status.root, "document_map")],
      {
        mode: "write",
        taskRunId: effectiveTaskRunId,
        ephemeralOwnerId: recordedEphemeralOwnerId,
        operation: "document_apply_replace",
      },
    );
    try {
      const pending = this.store.consumePending(actionId, confirmationToken);
      const path = previewPath; await this.assertWordIsNotEditing(path); if (this.files.hashFile(path) !== pending.expectedHash) throw new Error("Document changed after preview.");
      const root = previewRoot; const documentId = String(pending.payload.documentId); const nodeId = String(pending.payload.nodeId); const node = this.projects.getNode(root, documentId, nodeId);
      const zip = await JSZip.loadAsync(readFileSync(path)); const docXml = await zip.file("word/document.xml")?.async("string"); if (!docXml) throw new Error("DOCX document.xml is missing."); const para = paragraphs(docXml); const range = this.resolveRange(para, node);
      const structured = this.renderBlocks(para, range.start, range.end, pending.payload.blocks as ContentBlock[], String(pending.payload.formattingStrategy)); const prefix = para[range.start].raw; const startOffset = docXml.indexOf(prefix); const endOffset = docXml.indexOf(para[range.end].raw) + para[range.end].raw.length; if (startOffset < 0 || endOffset < startOffset) throw new Error("Document anchor could not be resolved safely.");
      const nextXml = `${docXml.slice(0, startOffset)}${structured}${docXml.slice(endOffset)}`; zip.file("word/document.xml", nextXml); const temp = resolve(dirname(path), `.nhd-edit-${randomToken(8)}.docx`); const backup = resolve(this.config.backupDir, `${Date.now()}-${sha256(path).slice(0, 12)}-${basename(path)}`); let replaced = false;
      try {
        writeFileSync(temp, await zip.generateAsync({ type: "nodebuffer" }));
        const rebuilt = await this.buildMap(temp, documentId, path);
        if (this.failBeforeMapCommit) throw new Error("Injected failure before document map commit.");
        mkdirSync(dirname(backup), { recursive: true }); copyFileSync(path, backup);
        renameSync(temp, path); replaced = true;
        if (effectiveTaskRunId) {
          this.store.guardResources([canonicalizeFilePathResource(path, this.config.roots)], {
            mode: "write",
            taskRunId: effectiveTaskRunId,
            operation: "document_apply_replace_post_rename",
          });
        }
        try { this.projects.replaceDocumentMap(root, rebuilt.document, rebuilt.nodes, rebuilt.edges); }
        catch (error) { copyFileSync(backup, path); replaced = false; throw error; }
        if (pending.payload.editSessionId) this.projects.addPass(root, String(pending.payload.editSessionId), "semantic-edit", `Applied ${nodeId}`, "completed", [nodeId], effectiveTaskRunId);
        const resultHash = this.files.hashFile(path); this.projects.appendEditLog(root, { action: "document_replace", documentId, nodeId, backup, actionId, baselineHash: pending.expectedHash, resultHash }); this.store.audit("document_apply_replace", "success", { path, documentId, nodeId, backup, actionId, taskRunId: effectiveTaskRunId ?? recordedEphemeralOwnerId ?? null }); return { applied: true, path, documentId, nodeId, backup, indexedAt: rebuilt.document.indexedAt };
      } catch (error) {
        if (replaced && existsSync(backup)) copyFileSync(backup, path);
        throw error;
      } finally { if (existsSync(temp)) rmSync(temp, { force: true }); }
    } finally {
      if (recordedEphemeralOwnerId) {
        this.store.releaseEphemeralOwnerResources(recordedEphemeralOwnerId, "document_apply_replace_completed");
      }
    }
  }

  consistency(root: string, documentId: string) {
    const status = this.projects.status(root); const mapPath = resolve(status.stateDir, "document-map.json"); const map = JSON.parse(readFileSync(mapPath, "utf8")) as { nodes: Array<DocumentNode> }; const nodes = map.nodes.filter((node) => node.documentId === documentId); const findings: Array<Record<string, unknown>> = [];
    const values = new Map<string, DocumentNode[]>(); for (const node of nodes) for (const match of node.text.matchAll(/\b\d{1,3}(?:[.,]\d+)?\s*(?:tháng|năm|triệu|tỷ|%|đồng)\b/giu)) { const key = match[0].replace(/\s+/g, " "); values.set(key, [...(values.get(key) ?? []), node]); }
    for (const [value, locations] of values) if (locations.length === 1 && /(?:tháng|năm|triệu|tỷ|%|đồng)/iu.test(value)) findings.push({ severity: "info", locationA: locations[0].id, reason: `Value '${value}' appears once; verify if a cross-reference is expected.` });
    const articles = nodes.filter((node) => node.kind === "article");
    const clauses = nodes.filter((node) => node.kind === "clause");
    const duplicate = (kind: "article" | "clause") => {
      const pool = kind === "article" ? articles : clauses; const groups = new Map<string, DocumentNode[]>();
      for (const node of pool) { const logical = node.id.replace(/#\d+$/u, ""); const key = kind === "article" ? logical : `${node.parentId}:${logical.split(":").at(-1)}`; groups.set(key, [...(groups.get(key) ?? []), node]); }
      for (const [key, items] of groups) if (items.length > 1) findings.push({ severity: "warning", locationA: items.map((item) => item.id), reason: `Duplicate ${kind} identifier '${key}'.` });
    };
    duplicate("article"); duplicate("clause");
    const sequence = (items: DocumentNode[], label: string) => {
      const numbers = items.map((node) => Number(node.id.match(/(\d+)(?:#\d+)?$/u)?.[1])).filter(Number.isFinite).sort((a, b) => a - b);
      for (let i = 1; i < numbers.length; i++) if (numbers[i] > numbers[i - 1] + 1) findings.push({ severity: "warning", locationA: label, reason: `Missing ${label} sequence value(s) between ${numbers[i - 1]} and ${numbers[i]}.` });
    };
    sequence(articles, "Article");
    for (const article of articles) sequence(clauses.filter((clause) => clause.parentId === article.id), `Clause in ${article.id}`);
    for (const node of nodes) {
      for (const reference of node.text.matchAll(/Điều\s+(\d+)(?:\s*,?\s*Khoản\s+(\d+))?(?:\s*,?\s*Điểm\s+([a-zđ]))?/giu)) {
        const articleId = `article:${reference[1]}`; const article = articles.find((candidate) => candidate.id === articleId);
        if (!article) { findings.push({ severity: "warning", locationA: node.id, reason: `Referenced Article ${reference[1]} is not present in this document map.` }); continue; }
        if (reference[2] && !clauses.some((candidate) => candidate.id === `${articleId}:clause:${reference[2]}`)) findings.push({ severity: "warning", locationA: node.id, reason: `Referenced Clause ${reference[2]} of Article ${reference[1]} is not present.` });
        if (reference[3]) findings.push({ severity: "info", locationA: node.id, reason: `Point reference '${reference[3]}' requires manual review because point nodes are not parsed by the current document mapper.` });
      }
    }
    this.projects.recordQa(root, documentId, findings.some((item) => item.severity === "warning") ? "warnings" : "passed", findings); return { summary: `Consistency check found ${findings.length} finding(s).`, findings };
  }

  private async buildMap(path: string, documentId?: string, displayPath = path) {
    const sourceHash = this.files.hashFile(path); const zip = await JSZip.loadAsync(readFileSync(path)); const documentXml = await zip.file("word/document.xml")?.async("string"); if (!documentXml) throw new Error("DOCX document.xml is missing.");
    const paras = paragraphs(documentXml); const headings = paras.filter((para) => headingKind(para.text)); const id = documentId?.trim() || basename(displayPath, ".docx").replace(/[^\w-]+/g, "-").toLowerCase(); const nodes: DocumentNode[] = [];
    for (let i = 0; i < headings.length; i++) {
      const heading = headings[i]; const next = headings[i + 1]; const kind = headingKind(heading.text)!; const nodeId = this.uniqueNodeId(nodes, headingId(heading.text, i + 1)); const start = heading.index; const end = (next?.index ?? paras.length) - 1;
      const parent = kind === "article" ? [...nodes].reverse().find((node) => node.kind === "chapter")?.id ?? null : null; const body = paras.slice(start, end + 1).map((para) => para.text).filter(Boolean).join("\n");
      nodes.push({ id: nodeId, documentId: id, kind, title: heading.text, text: body, parentId: parent, startParagraph: start, endParagraph: end, anchor: { paraId: heading.paraId, normalizedHeading: normalized(heading.text), surroundingBefore: paras[start - 1]?.fingerprint ?? null, surroundingAfter: paras[end + 1]?.fingerprint ?? null }, formatting: { heading: { pPr: heading.pPr, rPr: heading.rPr }, body: this.bodyFormat(paras, start, end) }, fingerprint: sha256(normalized(body)).slice(0, 32) });
      if (kind === "article") for (const para of paras.slice(start + 1, end + 1)) {
        const number = clauseNumber(para.text); if (!number) continue;
        const clauseId = this.uniqueNodeId(nodes, `${nodeId}:clause:${number}`);
        nodes.push({ id: clauseId, documentId: id, kind: "clause", title: `Khoản ${number} (${nodeId})`, text: para.text, parentId: nodeId, startParagraph: para.index, endParagraph: para.index, anchor: { paraId: para.paraId, normalizedText: normalized(para.text).slice(0, 240), fingerprint: para.fingerprint }, formatting: { pPr: para.pPr, rPr: para.rPr }, fingerprint: para.fingerprint });
      }
    }
    for (const para of paras) {
      if (!para.text.trim() || headingKind(para.text) || clauseNumber(para.text)) continue;
      const parent = [...nodes].filter((node) => node.kind === "article" && node.startParagraph < para.index && node.endParagraph >= para.index).at(-1)?.id ?? [...nodes].filter((node) => node.kind === "chapter" && node.startParagraph < para.index && node.endParagraph >= para.index).at(-1)?.id ?? null;
      const nodeId = this.uniqueNodeId(nodes, `paragraph:${para.paraId ?? `${para.index}-${para.fingerprint}`}`);
      nodes.push({ id: nodeId, documentId: id, kind: "paragraph", title: `Paragraph ${para.index + 1}`, text: para.text, parentId: parent, startParagraph: para.index, endParagraph: para.index, anchor: { paraId: para.paraId, normalizedText: normalized(para.text).slice(0, 240), fingerprint: para.fingerprint }, formatting: { pPr: para.pPr, rPr: para.rPr }, fingerprint: para.fingerprint });
    }
    const edges = this.edges(nodes); const document = { id, path: displayPath, hash: sourceHash, title: basename(displayPath), indexedAt: nowIso(), paragraphCount: paras.length, formatProfile: this.formatProfile(paras, nodes) };
    return { document, nodes, edges };
  }
  private documentPath(root: string, documentId: string) { const status = this.projects.status(root); const map = JSON.parse(readFileSync(resolve(status.stateDir, "document-map.json"), "utf8")) as { documents: Array<{ id: string; path: string }> }; const document = map.documents.find((item) => item.id === documentId); if (!document) throw new Error("Document is not indexed."); return this.files.resolvePath(document.path); }
  private async assertWordIsNotEditing(path: string) { if (!this.office) return; const status = await this.office.status(); if (!status.companion || !status.word) return; const active = await this.office.live("word_document_status", {}); if (active.open && String(active.path ?? "").toLocaleLowerCase() === path.toLocaleLowerCase()) throw new Error(active.saved === false ? "CONFLICT: the target document is open in Word with unsaved changes." : "CONFLICT: the target document is currently open in Word. Close it before offline semantic editing."); }
  private bodyFormat(paras: Paragraph[], start: number, end: number) { const body = paras.slice(start + 1, end + 1).find((item) => item.text.trim()); return { pPr: body?.pPr ?? "", rPr: body?.rPr ?? "" }; }
  private formatProfile(paras: Paragraph[], nodes: DocumentNode[]) { const article = nodes.find((node) => node.kind === "article"); const chapter = nodes.find((node) => node.kind === "chapter"); return { chapter: chapter?.formatting ?? {}, article: article?.formatting ?? {}, body: this.bodyFormat(paras, article?.startParagraph ?? 0, article?.endParagraph ?? 0) }; }
  private edges(nodes: DocumentNode[]) { const edges: Array<{ from: string; to: string; type: EdgeType; evidence?: string }> = []; const articles = nodes.filter((node) => node.kind === "article"); for (const node of articles) for (const match of node.text.matchAll(/Điều\s+(\d+)/giu)) { const target = `article:${match[1]}`; if (target !== node.id && articles.some((article) => article.id === target)) edges.push({ from: node.id, to: target, type: "references", evidence: match[0] }); }
    const capital = articles.filter((node) => /vốn|góp vốn|vốn điều lệ/iu.test(node.text)); for (const from of capital) for (const to of capital) if (from.id < to.id) edges.push({ from: from.id, to: to.id, type: "financial_dependency", evidence: "capital terminology" }); return edges; }
  private resolveRange(paras: Paragraph[], node: DocumentNode) {
    const anchorId = typeof node.anchor.paraId === "string" ? node.anchor.paraId : null; const normalizedAnchor = String(node.anchor.normalizedHeading ?? node.anchor.normalizedText ?? ""); const fingerprint = String(node.anchor.fingerprint ?? "");
    let start = anchorId ? paras.findIndex((para) => para.paraId === anchorId) : -1;
    if (start < 0 && normalizedAnchor) start = paras.findIndex((para) => normalized(para.text) === normalizedAnchor);
    if (start < 0 && fingerprint) start = paras.findIndex((para) => para.fingerprint === fingerprint);
    if (start < 0) throw new Error("Document anchor no longer resolves. Re-index the document before editing.");
    if (node.kind === "paragraph") return { start, end: start };
    for (let index = start + 1; index < paras.length; index++) {
      const kind = headingKind(paras[index].text);
      if (node.kind === "clause" && (clauseNumber(paras[index].text) || kind)) return { start, end: index - 1 };
      if (node.kind === "article" && (kind === "article" || kind === "chapter")) return { start, end: index - 1 };
      if (node.kind === "chapter" && kind === "chapter") return { start, end: index - 1 };
    }
    return { start, end: paras.length - 1 };
  }
  private renderBlocks(paras: Paragraph[], start: number, end: number, blocks: ContentBlock[], strategy: string) { const target = paras[start]; const body = paras.slice(start + 1, end + 1).find((item) => item.text.trim()) ?? target; return blocks.map((block, index) => { const source = block.type === "heading" || block.type === "article" ? target : body; const pPr = strategy === "preserve_source" && index === 0 ? target.pPr : source.pPr; const rPr = source.rPr; return `<w:p>${pPr}<w:r>${rPr}<w:t xml:space="preserve">${xml(block.text)}</w:t></w:r></w:p>`; }).join(""); }
  private uniqueNodeId(nodes: DocumentNode[], base: string) { let id = base; let suffix = 2; while (nodes.some((node) => node.id === id)) id = `${base}#${suffix++}`; return id; }
}

import { basename } from "node:path";
import { AppConfig } from "./config.js";
import { DesktopControl, DesktopService, DesktopWindow } from "./desktop.js";
import { Store } from "./db.js";
import { IntakeFile, IntakeService } from "./intake.js";
import { PdfService } from "./pdf.js";

type IntakeRequest = {
  application: string;
  conversation: string;
  attachmentType: "pdf";
  selection: "latest";
  task: "locate" | "read";
  maxChars?: number;
};

export class DesktopIntakeWorkflow {
  constructor(readonly config: AppConfig, readonly store: Store, readonly desktop: DesktopService, readonly intake: IntakeService, readonly pdf: PdfService) {}

  async run(request: IntakeRequest) {
    const startedAt = new Date().toISOString();
    const trace: Array<Record<string, unknown>> = [];
    const application = request.application.trim();
    const conversation = request.conversation.trim();
    if (!application || !conversation) throw new Error("Application and conversation are required.");
    let window = await this.findWindow(application, trace);
    await this.desktop.action({ action: "activate", windowId: window.windowId });
    trace.push({ stage: "activate", window: window.title, ok: true });
    await this.desktop.action({ action: "wait", milliseconds: 800 });

    let controls = (await this.desktop.inspect(window.windowId, { limit: 1400, maxDepth: 18 })).controls;
    const search = this.findSearchControl(controls);
    if (!search) return this.incomplete(startedAt, trace, "SEARCH_CONTROL_NOT_FOUND", "Could not identify a safe search field in the application window.", { window, controls: this.relevantControls(controls, [application, conversation, "search", "tìm"]) });
    await this.desktop.action({ action: "set_text", selectorId: search.selectorId, text: conversation });
    trace.push({ stage: "search", control: this.summary(search), query: conversation, ok: true });
    await this.desktop.action({ action: "wait", milliseconds: 1200 });

    controls = (await this.desktop.inspect(window.windowId, { limit: 1600, maxDepth: 20 })).controls;
    const conversationControl = this.bestNamedControl(controls, conversation, ["Edit", "Document"]);
    if (!conversationControl) return this.incomplete(startedAt, trace, "CONVERSATION_NOT_FOUND", `Conversation '${conversation}' was not found after search.`, { window, controls: this.relevantControls(controls, [conversation]) });
    await this.desktop.action({ action: "invoke", selectorId: conversationControl.selectorId });
    trace.push({ stage: "open_conversation", control: this.summary(conversationControl), ok: true });
    await this.desktop.action({ action: "wait", milliseconds: 1400 });

    controls = (await this.desktop.inspect(window.windowId, { limit: 2000, maxDepth: 24 })).controls;
    const attachments = controls.filter((control) => /\.pdf(?:\b|$)|\bpdf\b/i.test(control.name) && control.enabled && !control.offscreen);
    const attachment = attachments.sort((a, b) => (b.bounds?.y ?? 0) - (a.bounds?.y ?? 0))[0];
    if (!attachment) return this.incomplete(startedAt, trace, "PDF_ATTACHMENT_NOT_FOUND", "No visible PDF attachment was exposed by Windows UI Automation in the selected conversation.", { window, controls: this.relevantControls(controls, ["pdf", "file", "tệp"]) });
    const attachmentName = this.pdfName(attachment.name);
    await this.desktop.action({ action: "invoke", selectorId: attachment.selectorId });
    trace.push({ stage: "open_attachment", control: this.summary(attachment), attachmentName, ok: true });

    let file: IntakeFile | undefined;
    try { file = await this.intake.waitForFile({ extension: "pdf", since: startedAt, timeoutSeconds: 20 }); }
    catch {
      const recent = this.intake.listRecent({ extension: "pdf", limit: 100 });
      file = attachmentName ? recent.find((item) => basename(item.path).toLocaleLowerCase("vi") === attachmentName.toLocaleLowerCase("vi")) : undefined;
    }
    if (!file) return this.incomplete(startedAt, trace, "DOWNLOAD_NOT_DETECTED", "The PDF was opened in the UI, but no matching completed file appeared in an approved intake folder.", { attachmentName, intake: this.intake.status() });
    trace.push({ stage: "intake", path: file.path, hash: file.hash, size: file.size, ok: true });
    if (request.task === "locate") return { status: "completed", startedAt, completedAt: new Date().toISOString(), file, trace };

    const inspection = await this.pdf.inspect(file.path);
    const content = await this.pdf.read(file.path, 1, undefined, request.maxChars ?? 120_000);
    trace.push({ stage: "pdf_read", pages: inspection.pages, textCharacters: inspection.textCharacters, scannedPages: inspection.scannedPages, ok: true });
    const result = { status: "completed", startedAt, completedAt: new Date().toISOString(), file, inspection, content, trace, security: "UI navigation and document intake were read-only. No message was sent and no source file was changed." };
    this.store.audit("desktop_document_intake", "success", { application, conversation, path: file.path, hash: file.hash, pages: inspection.pages });
    return result;
  }

  private async findWindow(application: string, trace: Array<Record<string, unknown>>): Promise<DesktopWindow> {
    const windows = (await this.desktop.windows()).windows;
    const needle = application.toLocaleLowerCase("vi");
    let window = windows.find((item) => `${item.title} ${item.className}`.toLocaleLowerCase("vi").includes(needle));
    if (window) { trace.push({ stage: "find_window", strategy: "title", window: window.title, ok: true }); return window; }
    for (const candidate of windows.slice(0, 12)) {
      const controls = (await this.desktop.inspect(candidate.windowId, { query: application, limit: 500, maxDepth: 10 })).controls;
      if (controls.length) { window = candidate; trace.push({ stage: "find_window", strategy: "contained_control", window: window.title, matched: this.summary(controls[0]), ok: true }); return window; }
    }
    throw new Error(`No window or visible control matching '${application}' was found.`);
  }

  private findSearchControl(controls: DesktopControl[]) {
    const edits = controls.filter((control) => control.controlType === "Edit" && control.enabled && !control.offscreen && !control.password);
    return edits.find((control) => /search|find|filter|tìm|tra cứu/i.test(`${control.name} ${control.automationId} ${control.className}`))
      ?? edits.find((control) => !/message|chat|soạn|nhập tin|nội dung/i.test(`${control.name} ${control.automationId}`));
  }

  private bestNamedControl(controls: DesktopControl[], name: string, excludedTypes: string[] = []) {
    const needle = name.toLocaleLowerCase("vi");
    return controls.filter((control) => control.enabled && !control.offscreen && !excludedTypes.includes(control.controlType) && control.name.toLocaleLowerCase("vi").includes(needle))
      .sort((a, b) => Number(a.name.toLocaleLowerCase("vi") !== needle) - Number(b.name.toLocaleLowerCase("vi") !== needle))[0];
  }

  private relevantControls(controls: DesktopControl[], queries: string[]) {
    const needles = queries.map((query) => query.toLocaleLowerCase("vi"));
    return controls.filter((control) => needles.some((needle) => `${control.name} ${control.automationId} ${control.controlType}`.toLocaleLowerCase("vi").includes(needle))).slice(0, 40).map((control) => this.summary(control));
  }

  private summary(control: DesktopControl) { return { selectorId: control.selectorId, name: control.name, controlType: control.controlType, bounds: control.bounds }; }
  private pdfName(value: string) { return value.match(/[^\\/:*?"<>|\r\n]+\.pdf\b/i)?.[0] ?? null; }
  private incomplete(startedAt: string, trace: Array<Record<string, unknown>>, code: string, message: string, diagnostics: Record<string, unknown>) {
    this.store.audit("desktop_document_intake", "incomplete", { code, message, trace });
    return { status: "needs_attention", code, message, startedAt, trace, diagnostics, nextStep: "Inspect the reported window with desktop_inspect, then continue with desktop_action or retry the high-level workflow after the UI is visible." };
  }
}

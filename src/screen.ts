import { AppConfig } from "./config.js";
import { Store } from "./db.js";
import { nowIso } from "./security.js";

export type ScreenSource = {
  id: string;
  name: string;
  kind: "screen" | "window";
  displayId: string | null;
};

type CaptureResponse = {
  source: ScreenSource;
  width: number;
  height: number;
  mimeType: "image/png";
  data: string;
};

export class ScreenService {
  private lastAutomaticCaptureAt = 0;

  constructor(readonly config: AppConfig, readonly store: Store) {}

  private async request(path: string, init: RequestInit = {}) {
    const response = await fetch(`http://127.0.0.1:${this.config.screenPort}${path}`, {
      ...init,
      headers: { "x-workstation-companion-secret": this.config.companionSecret, ...(init.headers ?? {}) },
      signal: AbortSignal.timeout(20_000),
    });
    const body = await response.json() as Record<string, unknown>;
    if (!response.ok) throw new Error(String(body.error ?? response.statusText));
    return body;
  }

  async status() {
    if (!this.config.screenEnabled) return { enabled: false, companion: false, sourceCount: 0, windowCount: 0, displayCount: 0 };
    try {
      return { enabled: true, companion: true, ...(await this.request("/status")) };
    } catch {
      return { enabled: true, companion: false, sourceCount: 0, windowCount: 0, displayCount: 0 };
    }
  }

  async list(): Promise<{ sources: ScreenSource[] }> {
    if (this.config.emergencyStop || !this.config.screenEnabled) throw new Error("Screen access is disabled.");
    const body = await this.request("/sources");
    const sources = Array.isArray(body.sources) ? body.sources as ScreenSource[] : [];
    this.store.audit("screen_list", "success", { sources: sources.length });
    return { sources };
  }

  async previewCapture(sourceId: string, maxWidth = 1600, maxHeight = 1000) {
    if (this.config.emergencyStop || !this.config.screenEnabled) throw new Error("Screen access is disabled.");
    const width = Math.min(Math.max(Math.trunc(maxWidth), 320), 2560);
    const height = Math.min(Math.max(Math.trunc(maxHeight), 240), 1440);
    const source = (await this.list()).sources.find((item) => item.id === sourceId);
    if (!source) throw new Error("Screen or window source was not found.");
    const pending = this.store.createPending("screen:capture", { sourceId, sourceName: source.name, kind: source.kind, maxWidth: width, maxHeight: height }, null);
    this.store.audit("screen_preview_capture", "pending", { sourceId, sourceName: source.name, kind: source.kind, actionId: pending.id, maxWidth: width, maxHeight: height });
    return { actionId: pending.id, confirmationToken: pending.confirmationToken, expiresAt: pending.expiresAt, source, maxWidth: width, maxHeight: height, privacyNotice: "The confirmed capture may contain sensitive information visible in this window or display." };
  }

  async capture(sourceId?: string, maxWidth = 1600, maxHeight = 1000): Promise<CaptureResponse> {
    if (this.config.emergencyStop || !this.config.screenEnabled) throw new Error("Automatic screen access is disabled by the owner.");
    if (Date.now() - this.lastAutomaticCaptureAt < 500) throw new Error("Screen capture rate limit exceeded. Wait briefly before capturing again.");
    const width = Math.min(Math.max(Math.trunc(maxWidth), 320), 2560);
    const height = Math.min(Math.max(Math.trunc(maxHeight), 240), 1440);
    const sources = (await this.list()).sources;
    const source = sourceId ? sources.find((item) => item.id === sourceId) : sources.find((item) => item.kind === "screen") ?? sources[0];
    if (!source) throw new Error("Screen or window source was not found.");
    this.lastAutomaticCaptureAt = Date.now();
    const capture = await this.captureSource(source.id, width, height);
    this.store.audit("screen_capture", "success", { sourceId: capture.source.id, sourceName: capture.source.name, kind: capture.source.kind, width: capture.width, height: capture.height, automatic: true, at: nowIso() });
    return capture;
  }

  async applyCapture(actionId: string, confirmationToken: string): Promise<CaptureResponse> {
    if (this.config.emergencyStop || !this.config.screenEnabled) throw new Error("Screen access is disabled.");
    const pending = this.store.consumePending(actionId, confirmationToken);
    if (pending.kind !== "screen:capture") throw new Error("Pending action is not a screen capture.");
    const body = await this.captureSource(String(pending.payload.sourceId), Number(pending.payload.maxWidth), Number(pending.payload.maxHeight));
    this.store.audit("screen_apply_capture", "success", { actionId, sourceId: body.source.id, sourceName: body.source.name, kind: body.source.kind, width: body.width, height: body.height, at: nowIso() });
    return body;
  }

  private async captureSource(sourceId: string, maxWidth: number, maxHeight: number): Promise<CaptureResponse> {
    const body = await this.request("/capture", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sourceId, maxWidth, maxHeight }),
    }) as CaptureResponse;
    if (body.mimeType !== "image/png" || typeof body.data !== "string" || !body.data.length) throw new Error("Screen Companion returned an invalid capture.");
    if (Buffer.byteLength(body.data, "base64") > 12 * 1024 * 1024) throw new Error("Captured image exceeds the 12 MB safety limit.");
    return body;
  }
}

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const execFileAsync = promisify(execFile);

export type WinAppUiElement = {
  selector: string;
  name: string;
  automationId: string;
  className: string;
  controlType: string;
  enabled: boolean;
  offscreen: boolean;
  invokable: boolean;
  inSidebar: boolean;
  bounds: { x: number; y: number; width: number; height: number } | null;
};

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function flattenWinAppUi(raw: unknown, maxItems = 800): WinAppUiElement[] {
  const windows = object(raw).windows;
  if (!Array.isArray(windows) || windows.length !== 1) throw new Error("WinApp inspection must identify exactly one window.");
  const win = object(windows[0]);
  const result: WinAppUiElement[] = [];
  const queue = Array.isArray(win.elements) ? win.elements.map((node) => ({ node, inSidebar: false })) : [];
  while (queue.length && result.length < maxItems) {
    const position = object(queue.shift());
    const entry = object(position.node);
    const inSidebar = position.inSidebar === true;
    const selector = String(entry.selector ?? "");
    const rect = ["x", "y", "width", "height"].map((k) => Number(entry[k]));
    const isRect = rect.every(Number.isFinite) && rect[2] > 0 && rect[3] > 0;
    if (selector && selector.length <= 256) {
      result.push({
        selector,
        name: String(entry.name ?? "").slice(0, 400),
        automationId: String(entry.automationId ?? "").slice(0, 256),
        className: String(entry.className ?? "").slice(0, 160),
        controlType: String(entry.type ?? "Unknown").slice(0, 80),
        enabled: entry.isEnabled === true,
        offscreen: entry.isOffscreen === true,
        invokable: entry.isInvokable === true,
        inSidebar,
        bounds: isRect ? { x: rect[0], y: rect[1], width: rect[2], height: rect[3] } : null,
      });
    }
    if (Array.isArray(entry.children)) {
      const childSidebar = inSidebar || /^(sidebarNav|conversationList|conversationListId)$/i.test(selector);
      queue.push(...entry.children.map((node) => ({ node, inSidebar: childSidebar })));
    }
    if (queue.length > maxItems * 8) throw new Error("WinApp inspection exceeds bounded element limit.");
  }
  return result;
}

export interface WinAppExecutor {
  inspect(windowId: string, maxDepth?: number, limit?: number): Promise<WinAppUiElement[]>;
  invoke(windowId: string, selector: string): Promise<unknown>;
  setValue(windowId: string, selector: string, value: string): Promise<unknown>;
}

/**
 * Accessible-selector-only WinApp adapter for an opaque Electron UIA tree.
 * NO coordinate clicks, synthetic mouse, arbitrary shell or JavaScript commands.
 * Caller must enforce task authorization, app binding and capability leases.
 */
export class NativeWinAppExecutor implements WinAppExecutor {
  private readonly exe: string;
  constructor(root = process.cwd()) {
    const arch = process.arch === "arm64" ? "win-arm64" : "win-x64";
    this.exe = resolve(root, "node_modules", "@microsoft", "winappcli", "bin", arch, "winapp.exe");
  }
  available(): boolean { return process.platform === "win32" && existsSync(this.exe); }
  private async execute(args: string[]): Promise<unknown> {
    if (!this.available()) throw new Error("WinApp native UIA adapter is not available.");
    const { stdout } = await execFileAsync(this.exe, ["ui", ...args, "--json"], {
      windowsHide: true, timeout: 30_000, maxBuffer: 3 * 1024 * 1024,
      env: { ...process.env, WINAPP_CLI_TELEMETRY_OPTOUT: "1", WINAPP_UI_WORKFLOW_ID: "nhd-accessibility-fallback" },
    });
    const start = stdout.indexOf("{");
    if (start < 0) throw new Error("WinApp returned no structured result.");
    return JSON.parse(stdout.slice(start));
  }
  async inspect(windowId: string, maxDepth = 10, limit = 800): Promise<WinAppUiElement[]> {
    if (!/^\d+$/.test(windowId)) throw new Error("WinApp requires a numeric HWND.");
    const raw = await this.execute(["inspect", "-w", windowId, "--depth", String(Math.max(1, Math.min(12, maxDepth)))]);
    const elements = flattenWinAppUi(raw, Math.max(20, Math.min(limit, 1000)));
    if (!elements.length) throw new Error("WinApp returned no accessible controls.");
    return elements;
  }
  async invoke(windowId: string, selector: string): Promise<unknown> {
    if (!/^\d+$/.test(windowId) || !/^[\w.-]{1,256}$/.test(selector)) throw new Error("Invalid WinApp selector.");
    return this.execute(["invoke", selector, "-w", windowId]);
  }
  async setValue(windowId: string, selector: string, value: string): Promise<unknown> {
    if (!/^\d+$/.test(windowId) || !/^[\w.-]{1,256}$/.test(selector)) throw new Error("Invalid WinApp selector.");
    if (value.length > 2000 || /[\r\n]/.test(value)) throw new Error("WinApp text edit exceeds bounded single-line input.");
    return this.execute(["set-value", selector, value, "-w", windowId]);
  }
}

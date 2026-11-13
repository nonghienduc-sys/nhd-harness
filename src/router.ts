import { capabilitiesFromRuntime, type CapabilitySnapshot, type RuntimeCapabilityInput } from "./capability-registry.js";
export { capabilitiesFromRuntime };
export type { CapabilitySnapshot, RuntimeCapabilityInput };

export type RouteId =
  | "files.read"
  | "files.write-confirmed"
  | "office.offline.read"
  | "office.offline.write-confirmed"
  | "office.live.read"
  | "office.live.write-confirmed"
  | "browser.read"
  | "browser.navigate-safe"
  | "desktop.read"
  | "desktop.navigate-safe"
  | "desktop.visual-verified"
  | "terminal.preview-confirmed"
  | "intake.read"
  | "pdf.read";

export type TaskDomain = "auto" | "files" | "office" | "browser" | "desktop" | "terminal" | "intake" | "pdf";
export type TaskOperation = "read" | "search" | "inspect" | "navigate" | "edit" | "write" | "execute" | "capture";
export type OfficeApplication = "word" | "excel" | "powerpoint" | "outlook";
export type ExternalSideEffect = "send" | "upload" | "login" | "credentials" | "payment" | "transfer" | "purchase" | "call";
export type BrowserTarget = "coc-coc" | "dedicated-chromium" | "isolated-browser";
export type BrowserWorkload = "auto" | "user-session" | "automation" | "scraping" | "testing";

export type TaskIntent = {
  domain?: TaskDomain;
  operation: TaskOperation;
  target?: string;
  application?: OfficeApplication;
  live?: boolean;
  externalSideEffect?: ExternalSideEffect;
  allowVisualFallback?: boolean;
  description?: string;
  requiresUserSession?: boolean;
  browserWorkload?: BrowserWorkload;
  preferIsolatedBrowser?: boolean;
};

export type VerificationContract = {
  kind: "hash" | "office-selection" | "dom" | "uia" | "visual" | "terminal-exit" | "read-observation";
  required: string[];
  boundedWaitMs: number;
  onAmbiguous: "fail" | "reobserve";
};

export type RecoveryPlan = {
  maxAutomaticRetries: number;
  strategy: "none" | "reobserve" | "reinspect-dom" | "refresh-live-state" | "prune-stale-and-retry-read";
  neverRepeatAfterAmbiguousExecution: boolean;
};

export type RoutePlan = {
  route: RouteId;
  reason: string;
  requiresConfirmation: boolean;
  readOnly: boolean;
  observations: string[];
  verification: VerificationContract;
  recovery: RecoveryPlan;
  browserTarget?: BrowserTarget;
};

export class RouterError extends Error {
  constructor(readonly code: "BLOCKED_SIDE_EFFECT" | "NO_SAFE_ROUTE" | "UNSUPPORTED_OFFICE_APP", message: string) {
    super(message);
    this.name = "RouterError";
  }
}

const OFFICE_EXTENSIONS = /\.(?:docx?|xlsx?|xlsm|pptx?)$/i;
const PDF_EXTENSION = /\.pdf$/i;
const HTTP_URL = /^https?:\/\//i;

function isWrite(operation: TaskOperation) {
  return operation === "edit" || operation === "write" || operation === "execute";
}

function domainFor(intent: TaskIntent): Exclude<TaskDomain, "auto"> {
  if (intent.domain && intent.domain !== "auto") return intent.domain;
  if (intent.application) return "office";
  const target = String(intent.target ?? "");
  if (PDF_EXTENSION.test(target)) return "pdf";
  if (OFFICE_EXTENSIONS.test(target)) return "office";
  if (HTTP_URL.test(target)) return "browser";
  if (intent.operation === "execute") return "terminal";
  return "files";
}

function readVerification(kind: VerificationContract["kind"], ...required: string[]): VerificationContract {
  return { kind, required, boundedWaitMs: 3000, onAmbiguous: "reobserve" };
}

function writeVerification(kind: VerificationContract["kind"], ...required: string[]): VerificationContract {
  return { kind, required, boundedWaitMs: 5000, onAmbiguous: "fail" };
}

function readRecovery(strategy: RecoveryPlan["strategy"]): RecoveryPlan {
  return { maxAutomaticRetries: 1, strategy, neverRepeatAfterAmbiguousExecution: false };
}

function writeRecovery(strategy: RecoveryPlan["strategy"] = "none"): RecoveryPlan {
  return { maxAutomaticRetries: strategy === "none" ? 0 : 1, strategy, neverRepeatAfterAmbiguousExecution: true };
}

export class WorkstationRouter {
  plan(intent: TaskIntent, capabilities: CapabilitySnapshot): RoutePlan {
    if (intent.externalSideEffect) {
      throw new RouterError("BLOCKED_SIDE_EFFECT", `External side effect '${intent.externalSideEffect}' is not routable in the current workstation safety model.`);
    }

    const domain = domainFor(intent);
    if (domain === "files") return this.files(intent, capabilities);
    if (domain === "office") return this.office(intent, capabilities);
    if (domain === "browser") return this.browser(intent, capabilities);
    if (domain === "desktop") return this.desktop(intent, capabilities);
    if (domain === "terminal") return this.terminal(intent, capabilities);
    if (domain === "intake") return this.intake(intent, capabilities);
    return this.pdf(intent, capabilities);
  }

  private files(intent: TaskIntent, capabilities: CapabilitySnapshot): RoutePlan {
    if (isWrite(intent.operation)) {
      if (!capabilities.files.write) throw this.noRoute("File write capability is disabled.");
      return {
        route: "files.write-confirmed",
        reason: "Structured filesystem write is safer and more deterministic than UI automation.",
        requiresConfirmation: true,
        readOnly: false,
        observations: ["resolve target inside configured roots", "capture baseline path/hash when applicable"],
        verification: writeVerification("hash", "target exists at expected path", "post-write hash/state matches previewed change"),
        recovery: writeRecovery(),
      };
    }
    if (!capabilities.files.read) throw this.noRoute("File read capability is disabled.");
    return {
      route: "files.read",
      reason: "Structured filesystem read is the highest-fidelity available path.",
      requiresConfirmation: false,
      readOnly: true,
      observations: ["resolve target inside configured roots"],
      verification: readVerification("read-observation", "requested file/range returned"),
      recovery: readRecovery("reobserve"),
    };
  }

  private office(intent: TaskIntent, capabilities: CapabilitySnapshot): RoutePlan {
    if (intent.application && capabilities.office.applications?.[intent.application] === false) {
      throw new RouterError("UNSUPPORTED_OFFICE_APP", `${intent.application} is unavailable in the current Office session.`);
    }
    const live = intent.live === true;
    const write = isWrite(intent.operation);
    if (live && write) {
      if (!capabilities.office.liveWrite) throw this.noRoute("Office Live Write is unavailable.");
      if (intent.application && capabilities.office.liveWriteApplications?.[intent.application] === false) throw this.noRoute(`Office Live Write is not available for ${intent.application}.`);
      return {
        route: "office.live.write-confirmed",
        reason: "The task targets live Office state; use the authenticated live companion with an internal preview/token transaction. Routine reversible edits do not require an extra user confirmation turn.",
        requiresConfirmation: false,
        readOnly: false,
        observations: ["read the active Office file and exact live target", "capture the target-specific stable fingerprint"],
        verification: writeVerification("office-selection", "active Office file identity unchanged", "live target fingerprint unchanged before apply", "post-apply live state satisfies the operation-specific verification contract", "visually inspect the actual Office window after the final mutation and correct any visible mismatch before reporting completion"),
        recovery: writeRecovery("refresh-live-state"),
      };
    }
    if (live) {
      if (!capabilities.office.liveRead) throw this.noRoute("Office Live Read is unavailable.");
      return {
        route: "office.live.read",
        reason: "Live Office state is available through a structured authenticated companion.",
        requiresConfirmation: false,
        readOnly: true,
        observations: ["read active document/sheet/slide and current selection"],
        verification: readVerification("read-observation", "live application state returned"),
        recovery: readRecovery("refresh-live-state"),
      };
    }
    if (write) {
      if (!capabilities.office.offlineWrite) throw this.noRoute("Offline Office write capability is unavailable.");
      return {
        route: "office.offline.write-confirmed",
        reason: "Structured offline Office editing preserves document semantics and avoids UI automation.",
        requiresConfirmation: true,
        readOnly: false,
        observations: ["read document structure", "capture baseline file hash"],
        verification: writeVerification("hash", "baseline hash still matches before apply", "output file opens/validates", "post-write hash differs as expected"),
        recovery: writeRecovery(),
      };
    }
    if (!capabilities.office.offlineRead) throw this.noRoute("Offline Office read capability is unavailable.");
    return {
      route: "office.offline.read",
      reason: "Structured offline Office parsing is preferred over opening the desktop application.",
      requiresConfirmation: false,
      readOnly: true,
      observations: ["parse document/workbook/presentation structure"],
      verification: readVerification("read-observation", "requested Office structure returned"),
      recovery: readRecovery("reobserve"),
    };
  }

  private browser(intent: TaskIntent, capabilities: CapabilitySnapshot): RoutePlan {
    const dedicatedChromium = capabilities.browser.dedicatedChromium ?? (capabilities.browser.enabled && capabilities.browser.dom);
    const cocCocConnected = Boolean(capabilities.browser.cocCocConnected);
    const isolatedBrowser = Boolean(capabilities.browser.isolatedBrowser);
    const workload: BrowserWorkload = intent.browserWorkload ?? "auto";
    const description = String(intent.description ?? "").toLowerCase();
    const requiresUserSession = intent.requiresUserSession === true
      || workload === "user-session"
      || /(?:logged[- ]?in|existing session|login session|account session|cookies?|profile|đăng nhập|phiên đăng nhập|tài khoản của tôi|session thật)/i.test(description);
    const automationWorkload = workload === "automation" || workload === "scraping" || workload === "testing";

    let browserTarget: BrowserTarget | null = null;
    if (requiresUserSession) {
      if (!cocCocConnected) throw this.noRoute("This browser task requires the user's real logged-in session, but the Cốc Cốc extension bridge is not connected. Do not copy credentials or silently switch to a clean automation profile.");
      browserTarget = "coc-coc";
    } else if (intent.preferIsolatedBrowser && isolatedBrowser) {
      browserTarget = "isolated-browser";
    } else if (automationWorkload) {
      if (dedicatedChromium) browserTarget = "dedicated-chromium";
      else if (isolatedBrowser) browserTarget = "isolated-browser";
      else throw this.noRoute("Automation/scraping/testing should not consume the user's personal Cốc Cốc session when no dedicated or isolated browser is available.");
    } else if (dedicatedChromium) {
      browserTarget = "dedicated-chromium";
    } else if (isolatedBrowser) {
      browserTarget = "isolated-browser";
    } else if (cocCocConnected) {
      browserTarget = "coc-coc";
    }

    if (browserTarget) {
      const navigating = intent.operation === "navigate" || intent.operation === "write" || intent.operation === "edit";
      const targetReason = browserTarget === "coc-coc"
        ? "The task needs the user's existing Cốc Cốc session/login state, so use the extension bridge without exporting credentials or cookies."
        : browserTarget === "isolated-browser"
          ? "The task is better isolated from the user's personal browser/session, so use the sandboxed browser."
          : "The task does not require the user's personal login state; use the dedicated Chromium automation profile for deterministic DOM automation.";
      const observations = browserTarget === "coc-coc"
        ? ["select an already connected Cốc Cốc tab/session", "observe current URL/title", "inspect fresh DOM controls before interaction"]
        : browserTarget === "isolated-browser"
          ? ["verify isolated agent/browser is online", "observe current URL/title", "inspect fresh guest DOM controls before interaction"]
          : ["observe dedicated Chromium URL/title", "inspect fresh DOM controls before interaction"];
      return {
        route: navigating ? "browser.navigate-safe" : "browser.read",
        browserTarget,
        reason: targetReason,
        requiresConfirmation: false,
        readOnly: !navigating,
        observations,
        verification: navigating
          ? writeVerification("dom", "reinspect DOM after action", "verify expected URL/title/value/DOM condition")
          : readVerification("dom", "requested DOM evidence returned"),
        recovery: navigating ? { maxAutomaticRetries: 1, strategy: "reinspect-dom", neverRepeatAfterAmbiguousExecution: true } : readRecovery("reinspect-dom"),
      };
    }
    if (capabilities.desktop.enabled && capabilities.desktop.uia) {
      return {
        route: intent.operation === "read" || intent.operation === "search" || intent.operation === "inspect" ? "desktop.read" : "desktop.navigate-safe",
        reason: "No browser DOM target is available; Windows UI Automation is the next structured interaction layer.",
        requiresConfirmation: false,
        readOnly: intent.operation === "read" || intent.operation === "search" || intent.operation === "inspect",
        observations: ["identify browser window", "inspect accessibility tree", "obtain fresh selector"],
        verification: readVerification("uia", "reinspect target window after action"),
        recovery: readRecovery("reobserve"),
      };
    }
    if (intent.allowVisualFallback && capabilities.desktop.enabled && capabilities.desktop.visual) {
      return this.visualFallback("Browser DOM and UI Automation are unavailable; verified visual navigation is the last permitted fallback.");
    }
    throw this.noRoute("No safe Browser/desktop route is currently available.");
  }

  private desktop(intent: TaskIntent, capabilities: CapabilitySnapshot): RoutePlan {
    if (capabilities.desktop.enabled && capabilities.desktop.uia) {
      const readOnly = intent.operation === "read" || intent.operation === "search" || intent.operation === "inspect" || intent.operation === "capture";
      return {
        route: readOnly ? "desktop.read" : "desktop.navigate-safe",
        reason: "Windows UI Automation provides structured controls and hit-tested navigation.",
        requiresConfirmation: false,
        readOnly,
        observations: ["list target window", "inspect accessibility tree", "obtain short-lived selector"],
        verification: readVerification("uia", "mandatory post-action accessibility observation"),
        recovery: readRecovery("reobserve"),
      };
    }
    if (intent.allowVisualFallback && capabilities.desktop.enabled && capabilities.desktop.visual) {
      return this.visualFallback("UI Automation is unavailable; owner-enabled visual fallback is permitted with post-action verification.");
    }
    throw this.noRoute("Desktop automation is unavailable.");
  }

  private terminal(_intent: TaskIntent, capabilities: CapabilitySnapshot): RoutePlan {
    if (!capabilities.terminal.enabled) throw this.noRoute("Terminal capability is disabled.");
    return {
      route: "terminal.preview-confirmed",
      reason: "Terminal execution preserves exact command preview/hash; whether another user confirmation turn is required is decided dynamically by terminal_preview riskScore and confirmationMode.",
      requiresConfirmation: false,
      readOnly: false,
      observations: ["preview exact command/cwd", "risk classify", "capture command hash"],
      verification: writeVerification("terminal-exit", "launcher completed", "exit code/output captured", "stale launcher state reconciled"),
      recovery: writeRecovery("prune-stale-and-retry-read"),
    };
  }

  private intake(_intent: TaskIntent, capabilities: CapabilitySnapshot): RoutePlan {
    if (!capabilities.intake.enabled) throw this.noRoute("Document Intake is disabled.");
    return {
      route: "intake.read",
      reason: "Approved intake roots provide a bounded read-only path for newly received documents.",
      requiresConfirmation: false,
      readOnly: true,
      observations: ["resolve file only inside approved intake roots", "verify stable completed file"],
      verification: readVerification("read-observation", "stable file metadata/content returned"),
      recovery: readRecovery("reobserve"),
    };
  }

  private pdf(_intent: TaskIntent, capabilities: CapabilitySnapshot): RoutePlan {
    if (!capabilities.pdf.enabled) throw this.noRoute("PDF service is disabled.");
    return {
      route: "pdf.read",
      reason: "Native PDF extraction/search/render is preferred over opening a desktop viewer.",
      requiresConfirmation: false,
      readOnly: true,
      observations: ["inspect PDF metadata", "prefer native text before OCR"],
      verification: readVerification("read-observation", "requested pages/search/render evidence returned"),
      recovery: readRecovery("reobserve"),
    };
  }

  private visualFallback(reason: string): RoutePlan {
    return {
      route: "desktop.visual-verified",
      reason,
      requiresConfirmation: false,
      readOnly: false,
      observations: ["capture screenshot", "constrain point to target top-level window", "hit-test point before click"],
      verification: writeVerification("visual", "mandatory post-action screenshot/accessibility observation"),
      recovery: { maxAutomaticRetries: 0, strategy: "reobserve", neverRepeatAfterAmbiguousExecution: true },
    };
  }

  private noRoute(message: string): RouterError {
    return new RouterError("NO_SAFE_ROUTE", message);
  }
}

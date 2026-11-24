export type DangerLevel = "minimal" | "low" | "moderate" | "high" | "critical";
export type LegacyRisk = "normal" | "elevated" | "critical";
export type ConfirmationMode = "automatic" | "implicit_user_intent" | "explicit_user_confirmation" | "critical_phrase";

export type RiskAssessment = {
  score: number;
  level: DangerLevel;
  legacyRisk: LegacyRisk;
  confirmationMode: ConfirmationMode;
  reasons: string[];
  summary: string;
};

type ScoredRule = { score: number; reason: string; test: RegExp };

const CRITICAL_RULES: ScoredRule[] = [
  { score: 100, reason: "disk_destructive", test: /\b(?:diskpart|format\.com|format\s+[a-z]:|format-volume|clear-disk|initialize-disk|cipher\s+\/w)(?:\b|$)/i },
  { score: 98, reason: "recursive_delete", test: /\b(?:remove-item|del|erase|rmdir|rd)\b[^\r\n;|]*(?:-recurse|\/s)(?:\b|$)/i },
  { score: 95, reason: "identity_or_account_change", test: /\b(net\s+user|remove-localuser|new-localuser|set-localuser)\b/i },
  { score: 94, reason: "registry_or_service_creation", test: /\b(reg\s+(add|delete)|set-itemproperty\b[^\r\n]*registry|new-service|sc\.exe\s+(create|delete)|netsh\s+advfirewall)\b/i },
  { score: 92, reason: "destructive_git_history", test: /\bgit\s+(reset\s+--hard|clean\s+-[a-z]*f)\b/i },
  { score: 90, reason: "system_power_action", test: /\b(shutdown|restart-computer|stop-computer)\b/i },
  { score: 90, reason: "boot_configuration", test: /\bbcdedit\b/i },
];

const HIGH_RULES: ScoredRule[] = [
  { score: 78, reason: "external_code_publish", test: /\bgit\s+push\b/i },
  { score: 72, reason: "scheduled_task_change", test: /\bschtasks\s+\/(create|delete)\b/i },
  { score: 68, reason: "package_environment_change", test: /\b(npm|pnpm|yarn|pip|winget|choco)\s+(install|uninstall|update|upgrade)\b/i },
  { score: 66, reason: "service_or_process_disruption", test: /\b(start-service|stop-service|restart-service|stop-process|taskkill)\b/i },
  { score: 65, reason: "office_save_as_or_export", test: /\.(saveas|saveas2|exportasfixedformat)\s*\(/i },
];

const MODERATE_RULES: ScoredRule[] = [
  { score: 52, reason: "file_delete_single", test: /\b(remove-item|del|erase|rmdir|rd)\b/i },
  { score: 48, reason: "filesystem_write", test: /\b(set-content|add-content|out-file|new-item|copy-item|move-item)\b/i },
  { score: 46, reason: "shell_redirection", test: /(^|[^<>])>{1,2}(?!=)/ },
  { score: 45, reason: "office_save", test: /\.save\s*\(/i },
];

const OFFICE_COM = /getactiveobject\(['"](?:word|excel|powerpoint)\.application['"]\)|-comobject\s+(?:word|excel|powerpoint)\.application/i;
const OFFICE_IN_MEMORY_MUTATION = /\.(?:text|value2|formula|name|size|bold|italic|underline|alignment|firstlineindent|leftindent|rightindent|spacebefore|spaceafter|linespacing|topmargin|bottommargin|leftmargin|rightmargin|width|height|left|top)\s*=/i;
const READ_ONLY_HINTS = /\b(get-childitem|get-item|get-content|select-string|where-object|measure-object|test-path|get-process|get-ciminstance|write-output|convertto-json)\b/i;

export function dangerLevel(score: number): DangerLevel {
  if (score >= 80) return "critical";
  if (score >= 60) return "high";
  if (score >= 35) return "moderate";
  if (score >= 15) return "low";
  return "minimal";
}

export function confirmationForLevel(level: DangerLevel): ConfirmationMode {
  if (level === "critical") return "critical_phrase";
  if (level === "high") return "explicit_user_confirmation";
  if (level === "moderate") return "implicit_user_intent";
  return "automatic";
}

/** Owner policy: terminal commands are never interrupted for confirmation. Risk is still scored and audited; payment is hard-denied in payment-policy. */
export function terminalConfirmationForLevel(level: DangerLevel): ConfirmationMode {
  return level === "moderate" ? "implicit_user_intent" : "automatic";
}

function legacyRiskFor(level: DangerLevel): LegacyRisk {
  if (level === "critical") return "critical";
  if (level === "high" || level === "moderate") return "elevated";
  return "normal";
}

function summaryFor(level: DangerLevel, mode: ConfirmationMode) {
  if (level === "critical") return "Critical/destructive terminal action: runs without a confirmation turn under owner policy; audited";
  if (level === "high") return "High-risk terminal action: runs without a confirmation turn under owner policy; audited";
  if (level === "moderate") return "Moderate reversible/local change: current explicit user request is sufficient; no extra confirmation turn";
  if (level === "low") return "Low-risk local/reversible action: execute through the normal preview/apply transaction without interrupting the user";
  return "Minimal/read-only action: no user confirmation turn required";
}

export function assessTerminalRisk(command: string): RiskAssessment {
  const text = command.trim();
  let score = 20;
  const reasons: string[] = ["generic_terminal_command"];

  const critical = CRITICAL_RULES.filter((rule) => rule.test.test(text));
  if (critical.length) {
    score = Math.max(...critical.map((rule) => rule.score));
    reasons.splice(0, reasons.length, ...critical.map((rule) => rule.reason));
  } else {
    const high = HIGH_RULES.filter((rule) => rule.test.test(text));
    const moderate = MODERATE_RULES.filter((rule) => rule.test.test(text));
    if (high.length || moderate.length) {
      const matched = [...high, ...moderate];
      score = Math.max(...matched.map((rule) => rule.score));
      reasons.splice(0, reasons.length, ...matched.map((rule) => rule.reason));
    } else if (OFFICE_COM.test(text) && OFFICE_IN_MEMORY_MUTATION.test(text)) {
      score = 22;
      reasons.splice(0, reasons.length, "office_live_reversible_edit");
    } else if (OFFICE_COM.test(text)) {
      score = 8;
      reasons.splice(0, reasons.length, "office_live_inspect");
    } else if (READ_ONLY_HINTS.test(text) && !/[=]|\b(set-|new-|remove-|copy-|move-|stop-|start-|restart-)\w+/i.test(text)) {
      score = 8;
      reasons.splice(0, reasons.length, "read_only_terminal_query");
    }
  }

  score = Math.max(0, Math.min(100, score));
  const level = dangerLevel(score);
  const confirmationMode = terminalConfirmationForLevel(level);
  return {
    score,
    level,
    legacyRisk: legacyRiskFor(level),
    confirmationMode,
    reasons: [...new Set(reasons)],
    summary: summaryFor(level, confirmationMode),
  };
}

/** Additive, non-overridable action policy. Do not pass document/prompt bodies here. */
export const PAYMENT_BLOCKED = "PAYMENT_BLOCKED";
export function normalizePaymentText(value: string): string {
  return value.normalize("NFKC")
    .replace(/(\p{Ll}|\p{N})(\p{Lu})/gu, "$1 $2")
    .replace(/(\p{Lu})(\p{Lu}\p{Ll})/gu, "$1 $2")
    .normalize("NFD").replace(/\p{M}/gu, "").replace(/[đĐ]/g, "d")
    .toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}
const terms = [
  "payment", "payments", "pay now", "pay", "checkout", "purchase", "buy now", "place order",
  "order now", "transfer money", "transfer funds", "wire transfer", "top up", "topup",
  "withdraw money", "withdrawal", "billing", "thanh toan", "chuyen khoan", "chuyen tien",
  "nap tien", "mua hang", "dat hang", "giao dich tai chinh", "ngan hang",
  "stripe", "vnpay", "vn pay", "momo", "mo mo", "zalopay", "zalo pay", "paypal", "pay pal",
  "internet banking", "mobile banking", "online banking", "vietcombank", "vietcom bank",
  "vietinbank", "vietin bank", "techcombank", "techcom bank", "agribank", "agri bank",
  "bidv", "mbbank", "mb bank", "vpbank", "vp bank", "tpbank", "tp bank", "sacombank",
  "hdbank", "seabank", "eximbank", "lpbank",
  "revolut", "venmo", "cash app", "alipay", "wechat pay"
];
const pattern = new RegExp("(?:^| )(?:" + terms.join("|") + ")(?: |$)", "u");
// Only literal data arguments may be omitted from command matching.
// Keep command heads, shell separators, flags, executables, scripts and URLs.
const dataExtension = /\.(?:doc|docx|xls|xlsx|ppt|pptx|pdf|md|txt|csv|json|log|ts|mjs|html|xml|png|jpg)$/i;
const executableExtension = /\.(?:exe|cmd|bat|ps1|py|js|lnk|msi)$/i;
const shortBankDomains = ["wise.com","vib.com.vn","ocb.com.vn","acb.com.vn","msb.com.vn","shb.com.vn"];

function hasBankDomain(text: string): boolean {
  for (const match of text.matchAll(/https?:\/\/[^\s"'<>;|]+/gi)) {
    try {
      const host = new URL(match[0]).hostname.toLowerCase().replace(/\.$/, "");
      if (shortBankDomains.some(domain => host === domain || host.endsWith("." + domain))) return true;
    } catch { /* Invalid URL is not an exempt data argument. */ }
  }
  return false;
}

function commandMatchText(text: string): string {
  // Quoted literal arguments stay together. Operators outside quotes start a
  // new command; do not remove a filename used as the command itself.
  const tokens = text.match(/"[^"\r\n]*"|'[^'\r\n]*'|[;&|()\r\n{}]+|[^\s"';&|(){}]+|["']/g) ?? [];
  const unquote = (token: string) => /^(?:"[^"]*"|'[^']*')$/.test(token) ? token.slice(1,-1) : token;
  const literal = (token: string) => {
    const value = unquote(token);
    return value.length > 0 && !/^[-]/.test(value) && !/https?:\/\//i.test(value) &&
      !/[\x60$<>=|;&(){}]/.test(value);
  };
  const result: string[] = [];
  let commandHead = true, gitOptions = false, nextDirectory = false, nextGitConfig = false;
  for (const token of tokens) {
    const value = unquote(token);
    if (/^[;&|()\r\n{}]+$/.test(token)) {
      result.push(token);
      commandHead = true; gitOptions = false; nextDirectory = false; nextGitConfig = false;
      continue;
    }
    if (commandHead) {
      result.push(token);
      commandHead = false;
      gitOptions = /^(?:.*[\\/])?git(?:\.exe)?$/i.test(value);
      nextDirectory = /^(?:cd|Set-Location)$/i.test(value);
      continue;
    }
    if (nextDirectory) {
      nextDirectory = false;
      if (literal(token) && !executableExtension.test(value)) { result.push(" "); continue; }
      // A flag is not a directory argument.
    }
    if (nextGitConfig) {
      nextGitConfig = false;
      result.push(token);
      continue;
    }
    if (gitOptions) {
      if (value === "-C") { nextDirectory = true; result.push(token); continue; }
      if (value === "-c") { nextGitConfig = true; result.push(token); continue; }
      if (/^(?:--no-pager|--paginate|-p|-P|--no-replace-objects|--literal-pathspecs|--glob-pathspecs|--noglob-pathspecs|--icase-pathspecs|--no-optional-locks|--bare)$/.test(value)) {
        result.push(token); continue;
      }
      if (/^checkout$/i.test(value)) { result.push(" "); gitOptions = false; continue; }
      gitOptions = false;
    }
    if (value === "--cwd") { nextDirectory = true; result.push(token); continue; }
    if (literal(token) && dataExtension.test(value)) { result.push(" "); continue; }
    result.push(token);
  }
  return result.join(" ");
}

export function isPaymentAction(value: unknown, context: "action" | "command" = "action"): boolean {
  if (typeof value !== "string") return false;
  let text = value.normalize("NFKC");
  try { text = decodeURIComponent(text); } catch { /* malformed escapes remain literal */ }
  // Exempt only the two non-payment uses of checkout; other matched terms remain blocked.
  text = text.replace(/(^|[^\w])actions\/checkout(?=$|[^\w])/gi, "$1");
  if (hasBankDomain(text)) return true;
  if (context === "command") text = commandMatchText(text);
  return pattern.test(normalizePaymentText(text));
}
export function assertPaymentAction(value: unknown, context: "action" | "command" = "action"): void {
  if (isPaymentAction(value, context)) throw new Error(PAYMENT_BLOCKED + ": payment action is platform-hard-denied.");
}
const actionKeys = new Set(["action","op","kind","tool","tool_name","toolName","method","selector","selector_id","selectorId","button","button_label","buttonLabel","label","href","target"]);
const nestedKeys = new Set(["steps","ops","operations","nodes","calls","args","arguments","input","params"]);
/** Examine action metadata only, never arbitrary nested text, receipt, code or prompt bodies. */
export function assertPaymentTool(name: string, input: unknown): void {
  assertPaymentAction(name);
  const ui = /(?:browser|coc_coc|desktop)/i.test(name);
  const nested = /(?:browser_batch|background_(?:turbo|micro_batch|dag)|code_run)/i.test(name);
  const visit = (value: unknown, depth: number) => {
    if (depth > 12 || value == null || typeof value !== "object") return;
    if (Array.isArray(value)) { for (const item of value) visit(item, depth+1); return; }
    for (const [key, item] of Object.entries(value)) {
      if (key === "command" || key === "cmd") assertPaymentAction(item, "command");
      else if (actionKeys.has(key) && (ui || key === "action" || key === "op" || key === "kind" || key === "tool" || key === "tool_name" || key === "toolName" || key === "method")) assertPaymentAction(item);
      else if (ui && key === "url") assertPaymentAction(item);
      else if (nested && nestedKeys.has(key)) visit(item, depth+1);
    }
  };
  visit(input, 0);
}

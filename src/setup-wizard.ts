import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import type { AppConfig } from "./config.js";

export type CloudflareSetupInput = { domain: string; subdomain?: string; confirmed: boolean };
const DOMAIN_RE = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const LABEL_RE = /^[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const UUID_RE = /[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/i;

export function cloudflareSetupPlan(input: Pick<CloudflareSetupInput, "domain" | "subdomain">) {
  const domain = String(input.domain ?? "").trim().toLowerCase();
  const subdomain = String(input.subdomain ?? "mcp").trim().toLowerCase();
  if (!DOMAIN_RE.test(domain) || /\.\.|--/.test(domain)) throw new Error("Tên miền không hợp lệ; nhập domain đã có trong Cloudflare, ví dụ example.com.");
  if (!LABEL_RE.test(subdomain)) throw new Error("Subdomain không hợp lệ. Dùng chữ cái, số hoặc dấu gạch ngang, bắt đầu bằng chữ.");
  const hostname = subdomain + "." + domain;
  const tunnelName = "nhd-" + createHash("sha256").update(hostname).digest("hex").slice(0,12);
  return { domain, subdomain, hostname, tunnelName, mcpUrl: "https://" + hostname + "/mcp", authorization: "OAuth qua ChatGPT Plugins", requiresCloudflareDns: true };
}

export function cloudflareConfigYml(uuid: string, credentialsFile: string, hostname: string, port = 39100) {
  if (!UUID_RE.test(uuid) || uuid.match(UUID_RE)?.[0] !== uuid) throw new Error("Invalid Cloudflare tunnel UUID.");
  if (!DOMAIN_RE.test(hostname) || !Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Invalid hostname or loopback port.");
  const quote = (value: string) => "'" + value.replaceAll("'", "''") + "'";
  return "tunnel: " + uuid + "\ncredentials-file: " + quote(credentialsFile) + "\ningress:\n  - hostname: " + quote(hostname) + "\n    service: http://127.0.0.1:" + port + "\n  - service: http_status:404\n";
}

type ExecResult = { stdout: string; stderr: string };
export function runCloudflared(binary: string, args: string[], timeoutMs = 45000): Promise<ExecResult> {
  return new Promise((done, fail) => execFile(binary, args, { windowsHide: true, timeout: timeoutMs, maxBuffer: 512 * 1024, shell: false }, (error, stdout, stderr) => {
    if (error) return fail(new Error("cloudflared: " + String(stderr || error.message).slice(-1500)));
    done({ stdout: String(stdout), stderr: String(stderr) });
  }));
}

export class FirstRunCloudflare {
  constructor(private readonly config: AppConfig, private readonly persist: () => void) {}
  get certPath() { return resolve(homedir(), ".cloudflared", "cert.pem"); }
  status() {
    return { cloudflaredReady: existsSync(this.config.cloudflaredPath), loggedIn: existsSync(this.certPath),
      tunnelMode: this.config.tunnelMode, hostname: this.config.publicHostname || null,
      namedConfigReady: existsSync(this.config.namedTunnelConfig),
      tunnelEnabled: this.config.tunnelEnabled, port: this.config.port,
      mcpUrl: this.config.publicHostname ? "https://" + this.config.publicHostname + "/mcp" : null };
  }
  login() {
    if (!existsSync(this.config.cloudflaredPath)) throw new Error("cloudflared.exe chưa có; hãy cài NHD Lite đầy đủ.");
    const child = spawn(this.config.cloudflaredPath, ["tunnel", "login"], { windowsHide: false, shell: false, detached: true, stdio: "ignore" });
    child.on("error", () => {}); // surfaced via follow-up status; never log credentials
    child.unref();
    return { initiated: true, pid: child.pid || null, message: "Trình duyệt Cloudflare sẽ mở. Đăng nhập, chọn tên miền, rồi quay lại kiểm tra." };
  }
  async provision(input: CloudflareSetupInput) {
    const plan = cloudflareSetupPlan(input);
    if (input.confirmed !== true) throw new Error("Cần xác nhận tạo Cloudflare Tunnel và DNS cho hostname đã chọn.");
    if (this.config.emergencyStop) throw new Error("Emergency Stop đang bật.");
    if (this.config.tunnelEnabled) throw new Error("Hãy dừng tunnel đang chạy trước khi thay đổi kết nối.");
    if (!existsSync(this.config.cloudflaredPath)) throw new Error("Không tìm thấy cloudflared.exe.");
    if (!existsSync(this.certPath)) throw new Error("Bạn cần đăng nhập Cloudflare và chọn zone trước.");
    const created = await runCloudflared(this.config.cloudflaredPath, ["tunnel","create",plan.tunnelName]);
    const id = (created.stdout + "\n" + created.stderr).match(UUID_RE)?.[0];
    if (!id) throw new Error("Cloudflare tạo tunnel nhưng chưa trả về ID hợp lệ; kiểm tra trong dashboard, không tự tạo lại để tránh trùng.");
    const credentials = resolve(homedir(),".cloudflared",id+".json");
    if (!existsSync(credentials)) throw new Error("Không tìm thấy tunnel credentials sau khi tạo. Tunnel ID: "+id);
    try { await runCloudflared(this.config.cloudflaredPath,["tunnel","route","dns",id,plan.hostname]); }
    catch (error) { throw new Error("Cloudflare DNS chưa hoàn tất. Tunnel "+id+" đã được tạo, hãy kiểm tra DNS để tránh trùng. "+String(error)); }
    const configPath = resolve(this.config.dataDir,"cloudflare","config.yml");
    mkdirSync(dirname(configPath),{ recursive:true });
    writeFileSync(configPath,cloudflareConfigYml(id,credentials,plan.hostname,this.config.port),{ encoding:"utf8",mode:0o600 });
    this.config.tunnelMode = "named";
    this.config.namedTunnelName = plan.tunnelName;
    this.config.namedTunnelConfig = configPath;
    this.config.publicHostname = plan.hostname;
    this.config.tunnelEnabled = false;
    this.persist();
    return { ok:true, hostname:plan.hostname, tunnelId:id, mcpUrl:plan.mcpUrl, restartRequired:false,
      next:"NHD sẽ tự bật tunnel. Kiểm tra HTTPS/OAuth rồi thêm URL MCP vào ChatGPT." };
  }
  async verify() {
    if (!this.config.publicHostname) return { ok:false, error:"Chưa có tên miền MCP." };
    const base = "https://"+this.config.publicHostname;
    try {
      const response = await fetch(base+"/.well-known/oauth-protected-resource", { signal:AbortSignal.timeout(7500),redirect:"error" });
      const body = await response.json() as Record<string,unknown>;
      const resource = body?.resource;
      return {ok:response.ok && resource === base+"/mcp",httpStatus:response.status,resource,mcpUrl:base+"/mcp"};
    } catch(error) { return {ok:false,error:error instanceof Error?error.message:String(error),mcpUrl:base+"/mcp"}; }
  }
}

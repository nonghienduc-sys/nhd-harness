import { Router } from "express";
import { Store } from "./db.js";
import { AppConfig } from "./config.js";
import { randomToken, sha256 } from "./security.js";

function escapeHtml(value: unknown): string {
  return String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character]!));
}

function form(title: string, action: string, fields: string, message = ""): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(title)}</title><style>body{font:16px system-ui;background:#f4f6f5;color:#18221f;margin:0;padding:40px}.box{max-width:520px;margin:auto;background:white;border:1px solid #cad3cf;padding:28px}input,button{box-sizing:border-box;width:100%;padding:11px;margin-top:9px;font:inherit}button{background:#176b55;color:white;border:0}.msg{color:#9d342b}</style></head><body><div class="box"><h1>${escapeHtml(title)}</h1><p class="msg">${escapeHtml(message)}</p><form method="post" action="${escapeHtml(action)}">${fields}<label>Pairing code<input name="pairing_code" autocomplete="one-time-code" required></label><button>Authorize this ChatGPT connection</button></form></div></body></html>`;
}

export function createOAuthRouter(config: AppConfig, store: Store, publicBase: () => string): Router {
  const router = Router();
  router.use(Router().use((request, _response, next) => { store.audit("oauth_request", "received", { method: request.method, path: request.path }); next(); }));

  router.post("/register", (request, response) => {
    const redirects = Array.isArray(request.body?.redirect_uris) ? request.body.redirect_uris.map(String) : [];
    if (!redirects.length || redirects.some((uri: string) => !/^https:\/\//i.test(uri))) return response.status(400).json({ error: "invalid_redirect_uri" });
    const clientId = randomToken(24);
    store.db.prepare("INSERT INTO oauth_clients(client_id,redirect_uris,created_at) VALUES(?,?,?)").run(clientId, JSON.stringify(redirects), new Date().toISOString());
    response.status(201).json({ client_id: clientId, client_name: String(request.body?.client_name ?? "ChatGPT"), redirect_uris: redirects, token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] });
  });

  router.get("/authorize", (request, response) => {
    const fields = ["client_id", "redirect_uri", "code_challenge", "code_challenge_method", "state", "response_type", "scope"]
      .map((name) => `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(request.query[name] ?? "")}">`).join("");
    response.type("html").send(form("Workstation MCP authorization", "/oauth/authorize", fields));
  });

  router.post("/authorize", (request, response) => {
    const { client_id, redirect_uri, code_challenge, code_challenge_method, state, pairing_code } = request.body ?? {};
    const client = store.db.prepare("SELECT redirect_uris FROM oauth_clients WHERE client_id=?").get(String(client_id)) as { redirect_uris: string } | undefined;
    const validRedirect = client && (JSON.parse(client.redirect_uris) as string[]).includes(String(redirect_uri));
    if (!client || !validRedirect || String(code_challenge_method) !== "S256" || String(pairing_code).toUpperCase() !== config.pairingCode.toUpperCase()) {
      return response.status(403).type("html").send(form("Authorization denied", "/oauth/authorize", "", "Invalid pairing code or OAuth request."));
    }
    const code = randomToken(32);
    store.db.prepare("INSERT INTO oauth_codes(code_hash,client_id,redirect_uri,challenge,expires_at,used) VALUES(?,?,?,?,?,0)")
      .run(sha256(code), String(client_id), String(redirect_uri), String(code_challenge), new Date(Date.now() + 5 * 60_000).toISOString());
    const url = new URL(String(redirect_uri));
    url.searchParams.set("code", code);
    if (state) url.searchParams.set("state", String(state));
    response.redirect(url.toString());
  });

  router.post("/token", (request, response) => {
    if (request.body?.grant_type === "refresh_token") {
      const refreshHash = sha256(String(request.body.refresh_token ?? ""));
      const token = store.db.prepare("SELECT client_id,expires_at,revoked FROM oauth_tokens WHERE token_hash=? AND type='refresh'").get(refreshHash) as Record<string, unknown> | undefined;
      if (!token || Number(token.revoked) || Date.parse(String(token.expires_at)) < Date.now()) return response.status(400).json({ error: "invalid_grant" });
      store.db.prepare("UPDATE oauth_tokens SET revoked=1 WHERE token_hash=?").run(refreshHash);
      return response.json(issueTokens(store, String(token.client_id)));
    }
    const codeHash = sha256(String(request.body?.code ?? ""));
    const row = store.db.prepare("SELECT * FROM oauth_codes WHERE code_hash=?").get(codeHash) as Record<string, unknown> | undefined;
    if (!row || Number(row.used) || Date.parse(String(row.expires_at)) < Date.now()) return response.status(400).json({ error: "invalid_grant" });
    if (String(row.client_id) !== String(request.body.client_id) || String(row.redirect_uri) !== String(request.body.redirect_uri)) return response.status(400).json({ error: "invalid_grant" });
    const verifier = String(request.body.code_verifier ?? "");
    const challenge = Buffer.from(Buffer.from(sha256(verifier), "hex")).toString("base64url");
    if (challenge !== String(row.challenge)) return response.status(400).json({ error: "invalid_grant" });
    store.db.prepare("UPDATE oauth_codes SET used=1 WHERE code_hash=?").run(codeHash);
    response.json(issueTokens(store, String(row.client_id)));
  });

  router.post("/revoke", (request, response) => {
    store.db.prepare("UPDATE oauth_tokens SET revoked=1 WHERE token_hash=?").run(sha256(String(request.body?.token ?? "")));
    response.status(200).end();
  });

  router.get("/metadata", (_request, response) => response.json({ issuer: publicBase(), authorization_endpoint: `${publicBase()}/oauth/authorize`, token_endpoint: `${publicBase()}/oauth/token`, registration_endpoint: `${publicBase()}/oauth/register`, revocation_endpoint: `${publicBase()}/oauth/revoke`, code_challenge_methods_supported: ["S256"], response_types_supported: ["code"], grant_types_supported: ["authorization_code", "refresh_token"], scopes_supported: ["mcp", "offline_access"], token_endpoint_auth_methods_supported: ["none"] }));
  return router;
}

function issueTokens(store: Store, clientId: string) {
  const access = randomToken(32);
  const refresh = randomToken(40);
  const accessExpiry = new Date(Date.now() + 60 * 60_000).toISOString();
  const refreshExpiry = new Date(Date.now() + 30 * 24 * 60 * 60_000).toISOString();
  store.db.prepare("INSERT INTO oauth_tokens(token_hash,type,client_id,expires_at,revoked,created_at) VALUES(?,?,?,?,0,?)").run(sha256(access), "access", clientId, accessExpiry, new Date().toISOString());
  store.db.prepare("INSERT INTO oauth_tokens(token_hash,type,client_id,expires_at,revoked,created_at) VALUES(?,?,?,?,0,?)").run(sha256(refresh), "refresh", clientId, refreshExpiry, new Date().toISOString());
  return { access_token: access, token_type: "Bearer", expires_in: 3600, refresh_token: refresh, scope: "mcp offline_access" };
}

export function validateBearer(store: Store, authorization: string | undefined): boolean {
  const match = authorization?.match(/^Bearer\s+(.+)$/i);
  if (!match) return false;
  const row = store.db.prepare("SELECT expires_at,revoked FROM oauth_tokens WHERE token_hash=? AND type='access'").get(sha256(match[1])) as Record<string, unknown> | undefined;
  return Boolean(row && !Number(row.revoked) && Date.parse(String(row.expires_at)) > Date.now());
}

import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { FileService } from "../dist/files.js";
import { validateRoots } from "../dist/roots-config.js";

const repo = resolve(".");
const temp = mkdtempSync(join(tmpdir(), "nhd-roots-config-"));
const data = join(temp, "data");
const oldRoot = join(temp, "old");
const addedRoot = join(temp, "added");
const outside = join(temp, "outside");
for (const dir of [data, oldRoot, addedRoot, outside]) mkdirSync(dir, { recursive: true });
writeFileSync(join(addedRoot, "allowed.txt"), "ROOTS_READ_SUCCESS\n", "utf8");
writeFileSync(join(outside, "blocked.txt"), "NOT_ALLOWED\n", "utf8");
writeFileSync(join(data, "config.json"), JSON.stringify({
  roots: [oldRoot], projectWorkspaceRoot: oldRoot, localHarnessEnabled: false,
  openAiSecureTunnelEnabled: false, tunnelEnabled: false,
}), "utf8");

const port = await new Promise((resolvePort, reject) => {
  const socket = createServer();
  socket.once("error", reject);
  socket.listen(0, "127.0.0.1", () => {
    const allocated = socket.address().port;
    socket.close(() => resolvePort(allocated));
  });
});
const base = "http://127.0.0.1:" + port;
const worker = spawn(process.execPath, ["dist/server.js"], {
  cwd: repo, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  env: {
    ...process.env,
    WORKSTATION_MCP_DATA_DIR: data,
    WORKSTATION_MCP_PORT: String(port),
    WORKSTATION_MCP_LOCAL_ENABLED: "0",
    WORKSTATION_OPENAI_TUNNEL_ENABLED: "0",
    NHD_SBCE_MODE: "off",
    NHD_RESULT_PAYLOAD_GATEWAY: "0",
  },
});
let output = "";
worker.stderr.on("data", (chunk) => { output += String(chunk).slice(0, 3000); });
worker.stdout.on("data", (chunk) => { output += String(chunk).slice(0, 3000); });
test.after(async () => {
  if (worker.exitCode === null) {
    worker.kill();
    await Promise.race([new Promise((resolveExit) => worker.once("exit", resolveExit)), delay(4000)]);
  }
  try { rmSync(temp, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }); }
  catch (error) {
    if (error.code !== "EPERM") throw error; // Windows may still release SQLite handles asynchronously.
  }
});
async function api(path, options = {}) {
  const response = await fetch(base + path, options);
  const payload = await response.json().catch(() => ({}));
  return { status: response.status, payload };
}
let ready = false;
for (let i = 0; i < 160; i++) {
  if (worker.exitCode !== null) break;
  try { const result = await api("/api/health/live"); if (result.status === 200) { ready = true; break; } }
  catch {}
  await delay(125);
}
assert.ok(ready, "Temporary server failed to start: " + output.slice(-1500));
const json = (roots, extraHeaders = {}) => ({
  method: "PUT",
  headers: { "Content-Type": "application/json", ...extraHeaders },
  body: JSON.stringify({ roots }),
});
const order = { concurrency: false };

test("GET trả về roots, drives và defaults", order, async () => {
  const { status, payload } = await api("/api/roots");
  assert.equal(status, 200);
  assert.deepEqual(payload.roots, [oldRoot]);
  assert.ok(Array.isArray(payload.drives));
  assert.ok(payload.drives.every((d) => /^[A-Z]:\\$/.test(d.path)));
  assert.ok(Array.isArray(payload.defaults) && payload.defaults.length >= 1);
});

test("PUT lưu config tạm, files dùng root mới ngay, ngoài roots bị chặn", order, async () => {
  const { status, payload } = await api("/api/roots", json([addedRoot]));
  assert.equal(status, 200);
  assert.deepEqual(payload.roots, [addedRoot]);
  const saved = JSON.parse(readFileSync(join(data, "config.json"), "utf8"));
  assert.deepEqual(saved.roots, [addedRoot]);
  const indexNew = await api("/api/index", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ root: addedRoot, maxFiles: 1 }),
  });
  assert.equal(indexNew.status, 200, JSON.stringify(indexNew.payload));
  const indexOutside = await api("/api/index", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ root: outside, maxFiles: 1 }),
  });
  assert.equal(indexOutside.status, 400);
  assert.match(indexOutside.payload.error, /outside configured roots/i);
  const files = new FileService({ roots: payload.roots }, { audit() {} });
  assert.match(files.read(join(addedRoot, "allowed.txt")), /ROOTS_READ_SUCCESS/);
  assert.throws(() => files.read(join(outside, "blocked.txt")), /outside configured roots/i);
});

test("PUT rỗng và hơn 20 mục: 400", order, async () => {
  assert.equal((await api("/api/roots", json([]))).status, 400);
  assert.equal((await api("/api/roots", json(Array(21).fill(addedRoot)))).status, 400);
});

test("PUT đường dẫn không tồn tại, không tuyệt đối, tệp: 400", order, async () => {
  for (const path of [join(temp, "missing"), "relative-dir", join(addedRoot, "allowed.txt")]) {
    assert.equal((await api("/api/roots", json([path]))).status, 400);
  }
});

test("PUT UNC và device path: 400", order, async () => {
  for (const path of ["\\\\server\\share", "\\\\?\\C:\\", "\\\\.\\C:\\"]) {
    assert.equal((await api("/api/roots", json([path]))).status, 400);
  }
});

test("Origin lạ: 403, cùng dashboard: hợp lệ, Content-Type bắt buộc", order, async () => {
  const bad = await api("/api/roots", json([addedRoot], { Origin: "https://example.org" }));
  assert.equal(bad.status, 403);
  assert.equal((await api("/api/roots", {
    method: "PUT", headers: { "Content-Type": "text/plain" },
    body: JSON.stringify({ roots: [addedRoot] }),
  })).status, 415);
  assert.equal((await api("/api/roots", json([addedRoot], { Origin: base }))).status, 200);
});

test("Chuẩn hóa bỏ trùng và bỏ thư mục con", order, async () => {
  const nested = join(addedRoot, "child");
  mkdirSync(nested, { recursive: true });
  const { status, payload } = await api("/api/roots", json([nested, addedRoot, addedRoot.toUpperCase(), nested]));
  assert.equal(status, 200);
  assert.deepEqual(payload.roots, [addedRoot]);
});

test("Không tồn tại tool MCP sửa roots", order, () => {
  const catalog = JSON.parse(readFileSync(join(repo, "docs/generated/capability-catalog.json"), "utf8"));
  assert.ok(Array.isArray(catalog.tools));
  assert.ok(!catalog.tools.some((tool) => /(?:roots?[_-]?(?:set|update|write|change)|(?:set|update|write|change)[_-]?roots?)/i.test(tool.name)));
  const mcp = readFileSync(join(repo, "src/mcp.ts"), "utf8");
  assert.doesNotMatch(mcp, /registerTool\(\s*["'](?:set|update|change)_roots/i);
});

test("Giao diện có đủ điều khiển và cảnh báo", order, () => {
  const html = readFileSync(join(repo, "dashboard/index.html"), "utf8");
  for (const id of ["rootsCard", "rootsDrives", "rootsFolders", "rootsAdd", "rootsSave", "rootsDefault", "rootsSystemWarning", "rootsFeedback"])
    assert.ok(html.includes('id="' + id + '"'));
  assert.match(html, /ChatGPT sẽ đọc\/ghi được mọi tệp trong ổ này/);
});

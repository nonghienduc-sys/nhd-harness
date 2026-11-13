"use strict";
// NHD Lite update trust boundary: fixed public GitHub repo, exact installer name, SHA-256 digest,
// no redirects to unapproved hosts, no automatic execution and no source/user-data upload.
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { createHash, randomUUID } = require("node:crypto");
const { Readable, Transform } = require("node:stream");
const { pipeline } = require("node:stream/promises");

const OWNER = "nonghienduc-sys";
const REPO = "nhd-harness-downloads";
const API = "https://api.github.com/repos/" + OWNER + "/" + REPO + "/releases";
const EXE = "NHD-Harness-Lite-Setup.exe";
const MAX_BYTES = 512 * 1024 * 1024;
const APPROVED_HOSTS = new Set(["github.com", "api.github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com", "github-releases.githubusercontent.com"]);
const headers = { "User-Agent": "NHD-Harness-Lite-Updater", Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };

function versionParts(value) {
  const v = String(value || "").trim().replace(/^v/, "");
  if (!/^\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(v)) throw Error("Invalid release version");
  const bits = v.split(".").map(Number);
  if (bits.some(n => !Number.isSafeInteger(n) || n < 0 || n > 9999)) throw Error("Unsupported release version");
  return bits;
}
function compareVersions(left, right) {
  const a = versionParts(left), b = versionParts(right);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return Math.sign(a[i] - b[i]);
  return 0;
}
function safeUrl(input, { asset = false } = {}) {
  const url = new URL(input);
  if (url.protocol !== "https:" || url.username || url.password || url.port || !APPROVED_HOSTS.has(url.hostname)) {
    throw Error("Untrusted update URL");
  }
  if (asset && url.hostname === "github.com" &&
      !url.pathname.startsWith("/" + OWNER + "/" + REPO + "/releases/download/")) {
    throw Error("Asset points to another repository");
  }
  return url;
}
function parseRelease(data) {
  if (!data || typeof data !== "object" || data.draft || data.prerelease) throw Error("Only published stable GitHub releases are allowed");
  const version = String(data.tag_name || "").match(/^lite-v(\d{1,4}\.\d{1,4}\.\d{1,4})$/)?.[1];
  if (!version) throw Error("Not a stable NHD Lite tag");
  versionParts(version);
  const assets = Array.isArray(data.assets) ? data.assets : [];
  const exact = assets.filter(a => a && a.name === EXE);
  if (exact.length !== 1) throw Error("Release must have exactly one expected installer");
  const a = exact[0];
  const digest = String(a.digest || "");
  if (!/^sha256:[a-f0-9]{64}$/.test(digest)) throw Error("GitHub SHA-256 digest required");
  if (!Number.isSafeInteger(a.size) || a.size < 1_000_000 || a.size > MAX_BYTES) throw Error("Invalid installer size");
  const downloadUrl = String(a.browser_download_url || "");
  const u = safeUrl(downloadUrl, { asset: true });
  if (u.hostname !== "github.com" || u.pathname !== "/" + OWNER + "/" + REPO + "/releases/download/" + data.tag_name + "/" + EXE) {
    throw Error("Installer URL/tag mismatch");
  }
  return Object.freeze({ version, tag: data.tag_name, sha256: digest.slice(7), size: a.size, url: u.toString() });
}
function pathUnder(parent, target) {
  const rel = path.relative(path.resolve(parent), path.resolve(target));
  return rel && !rel.startsWith("..") && !path.isAbsolute(rel);
}
function safeTarget(base, filename) {
  if (!/^[a-zA-Z0-9._-]{1,120}$/.test(filename)) throw Error("Unsafe update filename");
  const out = path.resolve(base, filename);
  if (!pathUnder(base, out)) throw Error("File escapes update cache");
  return out;
}
function atomicJson(file, obj) {
  const parent = path.dirname(file);
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  const temp = file + "." + randomUUID() + ".tmp";
  fs.writeFileSync(temp, JSON.stringify(obj, null, 2), { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temp, file);
}
function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}
async function fetchChecked(uri, { maxRedirects = 5, timeoutMs = 18000, fetchImpl = fetch } = {}) {
  let current = safeUrl(uri);
  for (let i = 0; i <= maxRedirects; i++) {
    const res = await fetchImpl(current.toString(), {
      headers, redirect: "manual", signal: AbortSignal.timeout(timeoutMs)
    });
    if ([301,302,303,307,308].includes(res.status)) {
      const loc = res.headers.get("location");
      if (!loc) throw Error("GitHub response missing redirect target");
      try { await res.body?.cancel(); } catch {}
      current = safeUrl(new URL(loc, current).toString(), { asset: true });
      continue;
    }
    if (!res.ok) throw Error("GitHub download failed (HTTP " + res.status + ")");
    return res;
  }
  throw Error("Too many update download redirects");
}
async function releaseFromApi(tag = null, options = {}) {
  if (tag !== null && !/^lite-v\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(tag)) throw Error("Invalid release tag");
  const url = API + (tag ? "/tags/" + tag : "/latest");
  const res = await fetchChecked(url, options);
  const len = Number(res.headers.get("content-length") || 0);
  if (len > 1_000_000) throw Error("GitHub release metadata too large");
  const text = await res.text();
  if (Buffer.byteLength(text) > 1_000_000) throw Error("GitHub release metadata too large");
  return parseRelease(JSON.parse(text));
}
async function sha256File(file) {
  const hash = createHash("sha256");
  const input = fs.createReadStream(file);
  for await (const chunk of input) hash.update(chunk);
  return hash.digest("hex");
}
async function downloadVerified(info, folder, { fetchImpl = fetch, onProgress = () => {} } = {}) {
  fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
  const destination = safeTarget(folder, info.tag + "-" + EXE);
  if (fs.existsSync(destination)) {
    if (fs.statSync(destination).size === info.size && await sha256File(destination) === info.sha256) return destination;
    await fsp.rm(destination, { force: true });
  }
  const temp = destination + "." + randomUUID() + ".partial";
  let bytes = 0;
  try {
    const res = await fetchChecked(info.url, { fetchImpl, timeoutMs: 120_000 });
    const advertised = Number(res.headers.get("content-length") || 0);
    if (advertised && advertised !== info.size) throw Error("Release asset Content-Length differs from GitHub API");
    if (!res.body) throw Error("Empty update response");
    const hasher = createHash("sha256");
    const meter = new Transform({
      transform(chunk, encoding, cb) {
        bytes += chunk.length;
        if (bytes > MAX_BYTES || bytes > info.size) return cb(Error("Installer is larger than advertised"));
        hasher.update(chunk); onProgress(bytes, info.size); cb(null, chunk);
      }
    });
    await pipeline(Readable.fromWeb(res.body), meter, fs.createWriteStream(temp, { flags: "wx", mode: 0o600 }));
    if (bytes !== info.size || hasher.digest("hex") !== info.sha256) throw Error("Installer SHA-256 or size mismatch");
    await fsp.rename(temp, destination);
    return destination;
  } catch (e) {
    await fsp.rm(temp, { force: true }).catch(() => {});
    throw e;
  }
}
function backupConfig(userData, targetFolder) {
  if (!path.isAbsolute(userData) || !path.isAbsolute(targetFolder)) throw Error("Absolute user-data paths required");
  const data = path.join(userData, "bridge-data");
  fs.mkdirSync(targetFolder, { recursive: true, mode: 0o700 });
  const allowed = ["config.json", "setup-complete.json", path.join("cloudflare", "config.yml")];
  const files = [];
  for (const rel of allowed) {
    const source = path.join(data, rel);
    if (!fs.existsSync(source)) continue;
    const stat = fs.lstatSync(source);
    if (!stat.isFile() || stat.isSymbolicLink()) throw Error("Unsafe configuration source");
    const destination = path.join(targetFolder, rel);
    fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
    fs.copyFileSync(source, destination);
    fs.chmodSync(destination, 0o600);
    files.push({ relativePath: rel.replace(/\\/g, "/"), bytes: stat.size,
      sha256: createHash("sha256").update(fs.readFileSync(destination)).digest("hex") });
  }
  const manifest = { schemaVersion: 1, createdAt: new Date().toISOString(), files };
  atomicJson(path.join(targetFolder, "backup-manifest.json"), manifest);
  return manifest;
}
module.exports = { OWNER, REPO, API, EXE, MAX_BYTES, compareVersions, safeUrl, parseRelease,
  pathUnder, safeTarget, atomicJson, readJson, fetchChecked, releaseFromApi, sha256File,
  downloadVerified, backupConfig };

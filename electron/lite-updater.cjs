"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const core = require("./lite-update-core.cjs");

function createLiteUpdater({ app, currentVersion = () => app.getVersion(), fetchLatest = core.releaseFromApi,
  download = core.downloadVerified, execPath = () => process.execPath, spawnGuardian = spawn,
  healthFetch = fetch, healthRequiredSamples = 5, report = () => {}, stateRoot = path.join(app.getPath("userData"), "nhd-updates") } = {}) {
  const stateFile = path.join(stateRoot, "state.json");
  let lastCheck = null, busy = false, interval = null;
  function state() { return core.readJson(stateFile) || { schemaVersion: 1, phase: "idle" }; }
  function setState(payload) {
    core.atomicJson(stateFile, { ...payload, schemaVersion: 1, updatedAt: new Date().toISOString() });
  }
  function safeSummary() {
    const s = state(), guardian = s.transactionDir ? core.readJson(path.join(s.transactionDir, "guardian-receipt.json")) : null;
    return { available: app.isPackaged && process.platform === "win32",
      installedVersion: currentVersion(), phase: guardian?.phase || s.phase,
      latestVersion: lastCheck?.version || null, targetVersion: s.targetVersion || null,
      lastCheckAt: lastCheck?.checkedAt || null, recoveryDetail: guardian?.detail || null };
  }
  async function check() {
    if (!app.isPackaged || process.platform !== "win32") return { ...safeSummary(), reason: "Windows packaged app required" };
    const r = await fetchLatest(null);
    const isNewer = core.compareVersions(r.version, currentVersion()) > 0;
    lastCheck = { ...r, checkedAt: new Date().toISOString() };
    report("checked", { latestVersion: r.version, isNewer });
    return { ...safeSummary(), isNewer, latestVersion: r.version, sha256: r.sha256, size: r.size };
  }
  async function prepare() {
    if (busy) throw Error("Update is already in progress");
    busy = true;
    try {
      if (!app.isPackaged || process.platform !== "win32") throw Error("Update requires installed Windows application");
      const previous = state();
      const pastReceipt = previous.transactionDir ? core.readJson(path.join(previous.transactionDir, "guardian-receipt.json")) : null;
      if (previous.phase === "installing" && !["success", "rolled-back"].includes(pastReceipt?.phase)) {
        throw Error("Previous installation is unresolved; inspect recovery receipt first");
      }
      const current = String(currentVersion());
      const latest = await fetchLatest(null); // always revalidate; never trust cached UI or stale release data
      if (core.compareVersions(latest.version, current) <= 0) throw Error("No newer stable release");
      const oldRelease = await fetchLatest("lite-v" + current);
      if (oldRelease.version !== current) throw Error("Rollback version could not be verified");
      const id = randomUUID(), transactionDir = path.join(stateRoot, "transactions", id);
      const cacheDir = path.join(stateRoot, "cache");
      fs.mkdirSync(transactionDir, { recursive: true, mode: 0o700 });
      const oldInstaller = await download(oldRelease, cacheDir);
      const newInstaller = await download(latest, cacheDir, { onProgress: (bytes, total) =>
        report("progress", { bytes, total, targetVersion: latest.version }) });
      if (await core.sha256File(oldInstaller) !== oldRelease.sha256 ||
          await core.sha256File(newInstaller) !== latest.sha256) throw Error("Staged installer hash mismatch");
      const backupDir = path.join(transactionDir, "backup");
      const manifest = core.backupConfig(app.getPath("userData"), backupDir);
      setState({ id, phase: "ready", previousVersion: current, targetVersion: latest.version,
        previousSha256: oldRelease.sha256, targetSha256: latest.sha256, previousSize: oldRelease.size,
        targetSize: latest.size, oldInstaller, newInstaller, transactionDir, backupCount: manifest.files.length });
      report("ready", { current, target: latest.version, backupCount: manifest.files.length });
      return { ...safeSummary(), verified: true, backupCount: manifest.files.length };
    } finally { busy = false; }
  }
  async function install() {
    if (busy) throw Error("Another update action is in progress");
    busy = true;
    try {
      const s = state();
      if (!app.isPackaged || process.platform !== "win32" || s.phase !== "ready") throw Error("No approved verified update ready to install");
      if (s.previousVersion !== currentVersion()) throw Error("Application version changed after staging");
      if (!core.pathUnder(stateRoot, s.transactionDir) ||
          !core.pathUnder(stateRoot, s.oldInstaller) || !core.pathUnder(stateRoot, s.newInstaller)) throw Error("Update cache path validation failed");
      const latest = await fetchLatest(null);
      if (latest.version !== s.targetVersion || latest.sha256 !== s.targetSha256 || latest.size !== s.targetSize)
        throw Error("GitHub latest release changed; must re-stage before installing");
      const oldRelease = await fetchLatest("lite-v" + s.previousVersion);
      if (oldRelease.sha256 !== s.previousSha256) throw Error("Rollback release changed; refusing install");
      for (const item of [{ path: s.oldInstaller, hash: s.previousSha256, bytes: s.previousSize },
                         { path: s.newInstaller, hash: s.targetSha256, bytes: s.targetSize }]) {
        if (!fs.existsSync(item.path) || fs.statSync(item.path).size !== item.bytes ||
            await core.sha256File(item.path) !== item.hash) throw Error("Cached installer changed; no installation performed");
      }
      const manifest = core.readJson(path.join(s.transactionDir, "backup", "backup-manifest.json"));
      if (!manifest || manifest.schemaVersion !== 1) throw Error("Configuration backup missing; refusing update");
      const guardianSource = path.join(__dirname, "lite-update-guardian.ps1");
      const guardian = path.join(stateRoot, "guardian-" + s.id + ".ps1");
      fs.mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
      fs.copyFileSync(guardianSource, guardian);
      const payload = {
        id: s.id, previousVersion: s.previousVersion, targetVersion: s.targetVersion,
        newInstaller: s.newInstaller, oldInstaller: s.oldInstaller,
        newSha256: s.targetSha256, oldSha256: s.previousSha256,
        userData: app.getPath("userData"), updaterRoot: stateRoot, transactionDir: s.transactionDir,
        parentPid: process.pid, executablePath: execPath()
      };
      const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
      const child = spawnGuardian("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive",
        "-ExecutionPolicy", "Bypass", "-File", guardian, "-PayloadB64", encoded],
        { detached: true, windowsHide: true, stdio: "ignore" });
      if (!child || !Number.isInteger(child.pid) || child.pid <= 0) throw Error("Recovery guardian failed to start");
      child.unref?.();
      // Fail closed: do not close a healthy NHD instance unless the detached guardian
      // has actually started and written its first durable recovery receipt.
      let guardianReady = false;
      const receiptPath = path.join(s.transactionDir, "guardian-receipt.json");
      for (let i = 0; i < 60; i++) {
        const receipt = core.readJson(receiptPath);
        if (receipt?.id === s.id && receipt?.phase === "waiting-for-exit") { guardianReady = true; break; }
        await new Promise(resolve => setTimeout(resolve, 200));
      }
      if (!guardianReady) {
        child.kill?.();
        throw Error("Rollback guardian not ready; NHD stays running and update is refused");
      }
      setState({ ...s, phase: "installing", guardianPid: child.pid });
      report("installing", { id: s.id, target: s.targetVersion, guardianPid: child.pid });
      return { started: true, targetVersion: s.targetVersion, guardianPid: child.pid };
    } finally { busy = false; }
  }
  async function confirmHealthy() {
    const s = state();
    if (!app.isPackaged || process.platform !== "win32" || s.phase !== "installing" ||
        s.targetVersion !== currentVersion() || !core.pathUnder(stateRoot, s.transactionDir)) return false;
    const marker = path.join(s.transactionDir, "health-ok.json");
    let healthySamples = 0;
    for (let attempt = 0; attempt < 75; attempt++) {
      try {
        const response = await healthFetch("http://127.0.0.1:39100/api/setup/status",
          { signal: AbortSignal.timeout(2500) });
        if (response.ok && (await response.json()).version === currentVersion()) {
          healthySamples += 1;
          if (healthySamples >= healthRequiredSamples) {
            core.atomicJson(marker, { id: s.id, version: s.targetVersion,
              backendVersion: s.targetVersion, checkedAt: new Date().toISOString(),
              consecutiveSamples: healthySamples });
            report("healthy", { id: s.id, version: s.targetVersion });
            return true;
          }
        } else healthySamples = 0;
      } catch { healthySamples = 0; }
      await new Promise(r => setTimeout(r, 1500));
    }
    return false;
  }
  function startPeriodic(onUpdate) {
    if (interval || !app.isPackaged || process.platform !== "win32") return;
    let notified = null;
    const tick = async () => {
      try {
        const result = await check();
        if (result.isNewer && result.latestVersion !== notified) {
          notified = result.latestVersion;
          await onUpdate(result);
        }
      } catch (e) { report("check-error", { message: e.message }); }
    };
    const startup = setTimeout(() => { void tick(); }, 90_000);
    interval = setInterval(() => { void tick(); }, 12 * 60 * 60 * 1000);
    interval.unref?.(); startup.unref?.();
  }
  function stopPeriodic() { if (interval) clearInterval(interval); interval = null; }
  return { status: safeSummary, check, prepare, install, confirmHealthy, startPeriodic, stopPeriodic };
}
module.exports = { createLiteUpdater };

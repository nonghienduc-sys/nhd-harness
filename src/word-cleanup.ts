import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type WordProcessInfo = {
  pid: number;
  parentPid: number | null;
  startedAt: number;
  mainWindowTitle: string;
};
export type WordCleanupResult = { enabled: boolean; killed: number[]; kept: number[]; errors: string[] };
export type WordProcessProvider = {
  list(notBeforeMs?: number, baseline?: WordProcessInfo[]): Promise<WordProcessInfo[]>;
  kill(pid: number): Promise<void>;
  sleep(ms: number): Promise<void>;
};
export type WordRunSnapshot = {
  before: WordProcessInfo[];
  commandPid?: number;
  startedAt: number;
  endedAt: number;
};

// tasklist is fast enough for a PID-only preflight. Only PIDs not present in
// the pre-command inventory need slower WMI details (start, parent and title).
// This avoids a PowerShell/CIM launch per terminal command, which previously
// caused unrelated terminal tests to time out under high parallel load.
function tasklistPids(output: string): number[] {
  return [...output.matchAll(/"WINWORD[.]EXE"\s*,\s*"(\d+)"/gi)]
    .map((match) => Number(match[1]))
    .filter((pid) => Number.isInteger(pid) && pid > 0);
}

async function detailedWordProcess(pid: number): Promise<WordProcessInfo | null> {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const command = [
    "$ErrorActionPreference='SilentlyContinue'",
    "$p=Get-Process -Id " + pid + " -ErrorAction SilentlyContinue",
    "if($p){",
    "$c=Get-CimInstance Win32_Process -Filter ('ProcessId='+$p.Id) -ErrorAction SilentlyContinue",
    "$parent=if($c){[int]$c.ParentProcessId}else{0}",
    "[pscustomobject]@{pid=[int]$p.Id;parentPid=$parent;startedAt=$p.StartTime.ToUniversalTime().ToString('o');mainWindowTitle=[string]$p.MainWindowTitle} | ConvertTo-Json -Compress",
    "}"
  ].join(";");
  const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], {
    windowsHide: true, timeout: 15000, maxBuffer: 128000
  });
  if (!stdout.trim()) return null;
  const item: any = JSON.parse(stdout.trim());
  const startedAt = Date.parse(String(item?.startedAt ?? ""));
  if (!Number.isFinite(startedAt) || Number(item.pid) !== pid) return null;
  return { pid, parentPid: Number(item.parentPid) || null, startedAt, mainWindowTitle: String(item.mainWindowTitle ?? "") };
}

export const nativeWordProcessProvider: WordProcessProvider = {
  async list(notBeforeMs = 0, baseline: WordProcessInfo[] = []) {
    if (process.platform !== "win32") return [];
    const { stdout } = await execFileAsync("tasklist.exe", ["/FI", "IMAGENAME eq WINWORD.EXE", "/FO", "CSV", "/NH"], {
      windowsHide: true, timeout: 12000, maxBuffer: 128000
    });
    const old = new Set(baseline.map((item) => item.pid));
    const entries: WordProcessInfo[] = [];
    for (const pid of tasklistPids(stdout)) {
      // On the first scan the caller needs PIDs only. On later scans,
      // inspect only new PIDs; previous PIDs are never eligible for cleanup.
      const isNew = notBeforeMs > 0 && !old.has(pid);
      if (isNew) {
        try {
          const details = await detailedWordProcess(pid);
          if (details) entries.push(details);
        } catch { /* inspection failure never authorizes PID termination */ }
      } else entries.push({ pid, parentPid: null, startedAt: 0, mainWindowTitle: "" });
    }
    return entries;
  },
  async kill(pid) { process.kill(pid); },
  async sleep(ms) { await new Promise<void>((resolve) => setTimeout(resolve, ms)); }
};

export function wordCleanupEnabled(env: NodeJS.ProcessEnv = process.env, platform = process.platform) {
  return platform === "win32" && !/^(0|false|off)$/i.test(String(env.NHD_WORD_CLEANUP ?? "1"));
}

/** Pure predicate; old PIDs and every visible Word window are untouchable. */
export function selectNewHiddenWordProcesses(before: WordProcessInfo[], after: WordProcessInfo[], startedAt: number, endedAt: number, commandPid?: number) {
  const old = new Set(before.map((item) => item.pid));
  const byPid = new Map(after.map((item) => [item.pid, item]));
  const isDescendant = (item: WordProcessInfo) => {
    const seen = new Set<number>();
    let parent = item.parentPid;
    while (parent && !seen.has(parent)) {
      if (parent === commandPid) return true;
      seen.add(parent);
      parent = byPid.get(parent)?.parentPid ?? null;
    }
    return false;
  };
  return after.filter((item) => !old.has(item.pid) && !item.mainWindowTitle.trim() &&
    (Number.isFinite(item.startedAt) && item.startedAt >= startedAt && (isDescendant(item) || item.startedAt <= endedAt + 1500)));
}

/** Await the command's own hidden Word instances; never kill an old or visible PID. */
export async function cleanWordProcesses(snapshot: WordRunSnapshot, provider: WordProcessProvider = nativeWordProcessProvider, graceMs = 10000): Promise<WordCleanupResult> {
  const outcome: WordCleanupResult = { enabled: true, killed: [], kept: [], errors: [] };
  try {
    const after = await provider.list(snapshot.endedAt, snapshot.before);
    const candidates = selectNewHiddenWordProcesses(snapshot.before, after, snapshot.startedAt, snapshot.endedAt, snapshot.commandPid);
    const protectedPids = new Set(snapshot.before.map((item) => item.pid));
    const candidateIds = new Set(candidates.map((item) => item.pid));
    outcome.kept = after.filter((item) => !candidateIds.has(item.pid)).map((item) => item.pid);
    if (!candidates.length) return outcome;
    await provider.sleep(Math.min(Math.max(graceMs, 0), 10000));
    const current = await provider.list(Date.now(), snapshot.before);
    for (const item of current) {
      if (!candidateIds.has(item.pid) || protectedPids.has(item.pid) || item.mainWindowTitle.trim()) {
        if (candidateIds.has(item.pid)) outcome.kept.push(item.pid);
        continue;
      }
      // PID reuse guard: do not kill a process that is not the originally observed instance.
      const original = candidates.find((entry) => entry.pid === item.pid);
      if (!original || original.startedAt !== item.startedAt) { outcome.kept.push(item.pid); continue; }
      try { await provider.kill(item.pid); outcome.killed.push(item.pid); }
      catch (error) { outcome.errors.push("PID " + item.pid + ": " + String(error)); }
    }
  } catch (error) { outcome.errors.push("Word snapshot failed: " + String(error)); }
  outcome.killed.sort((a,b)=>a-b);
  outcome.kept = [...new Set(outcome.kept)].sort((a,b)=>a-b);
  return outcome;
}

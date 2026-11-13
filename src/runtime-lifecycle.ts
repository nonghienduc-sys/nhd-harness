import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

type LifecycleRecord = {
  schemaVersion: 1;
  generation: number;
  state: "running" | "stopped";
  pid: number;
  startedAt: string;
  startReason: string;
  exitReason?: string | null;
  exitAt?: string | null;
  version: string;
};

function readRecord(path: string): LifecycleRecord | null {
  if (!existsSync(path)) return null;
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as LifecycleRecord;
    return value && value.schemaVersion === 1 ? value : null;
  } catch {
    return null;
  }
}

export class RuntimeLifecycleService {
  private readonly path: string;
  private readonly startedAt = new Date();
  private readonly previous: LifecycleRecord | null;
  private readonly generation: number;
  private readonly startReason: string;
  private stopped = false;

  constructor(dataDir: string, readonly version: string) {
    this.path = resolve(dataDir, "runtime-lifecycle.json");
    this.previous = readRecord(this.path);
    this.generation = Math.max(1, Number(this.previous?.generation ?? 0) + 1);
    const explicit = process.env.WORKSTATION_RESTART_REASON?.trim();
    this.startReason = explicit
      || (this.previous?.state === "running"
        ? "recovered-after-unclean-exit"
        : this.previous?.exitReason
          ? `restart-after-${this.previous.exitReason}`
          : "process-start");
    this.persist("running", null);
  }

  private persist(state: "running" | "stopped", exitReason: string | null) {
    mkdirSync(dirname(this.path), { recursive: true });
    const record: LifecycleRecord = {
      schemaVersion: 1,
      generation: this.generation,
      state,
      pid: process.pid,
      startedAt: this.startedAt.toISOString(),
      startReason: this.startReason,
      exitReason,
      exitAt: state === "stopped" ? new Date().toISOString() : null,
      version: this.version,
    };
    writeFileSync(this.path, JSON.stringify(record, null, 2), { encoding: "utf8", mode: 0o600 });
  }

  markExit(reason: string) {
    if (this.stopped) return;
    this.stopped = true;
    try { this.persist("stopped", String(reason || "process-exit").slice(0, 200)); } catch {}
  }

  status() {
    const previousExitReason = this.previous
      ? (this.previous.state === "running" ? "unclean-or-forced-exit" : this.previous.exitReason ?? null)
      : null;
    return {
      schemaVersion: 1,
      pid: process.pid,
      parentPid: process.ppid,
      generation: this.generation,
      version: this.version,
      startedAt: this.startedAt.toISOString(),
      uptimeMs: Math.max(0, Date.now() - this.startedAt.getTime()),
      startReason: this.startReason,
      previousPid: this.previous?.pid ?? null,
      previousStartedAt: this.previous?.startedAt ?? null,
      previousExitReason,
      previousExitAt: this.previous?.exitAt ?? null,
      state: this.stopped ? "stopping" : "running",
    };
  }
}

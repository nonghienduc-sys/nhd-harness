export type HealthSnapshotState = "warming" | "healthy" | "degraded" | "stale";

export type HealthSnapshotView<T extends Record<string, unknown> = Record<string, unknown>> = {
  available: boolean;
  mode: "background-health-snapshot-v1";
  state: HealthSnapshotState;
  collectedAt: string | null;
  ageMs: number | null;
  refreshIntervalMs: number;
  staleAfterMs: number;
  deepHealthRequired: boolean;
  deepHealthReason: string | null;
  refreshInFlight: boolean;
  refreshCount: number;
  failureCount: number;
  lastError: string | null;
  collectorLatencyMs: { last: number | null; p50: number | null; p95: number | null; max: number | null; samples: number };
  data: T | null;
};

export class HealthSnapshotService<T extends Record<string, unknown> = Record<string, unknown>> {
  private latest: { at: number; data: T } | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private inflight: Promise<HealthSnapshotView<T>> | null = null;
  private refreshCount = 0;
  private failureCount = 0;
  private lastError: string | null = null;
  private latencySamples: number[] = [];

  constructor(
    readonly collector: () => Promise<T>,
    readonly options: { refreshIntervalMs?: number; staleAfterMs?: number; isDegraded?: (data: T) => string | null } = {},
  ) {}

  get refreshIntervalMs() { return Math.max(2_000, Math.min(this.options.refreshIntervalMs ?? 15_000, 300_000)); }
  get staleAfterMs() { return Math.max(this.refreshIntervalMs, Math.min(this.options.staleAfterMs ?? this.refreshIntervalMs * 3, 900_000)); }

  start() {
    if (this.timer) return;
    void this.refresh().catch(() => {});
    this.timer = setInterval(() => { void this.refresh().catch(() => {}); }, this.refreshIntervalMs);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async refresh(): Promise<HealthSnapshotView<T>> {
    if (this.inflight) return this.inflight;
    this.inflight = (async () => {
      const startedAt = Date.now();
      try {
        const data = await this.collector();
        this.latest = { at: Date.now(), data };
        this.refreshCount += 1;
        this.lastError = null;
      } catch (error) {
        this.failureCount += 1;
        this.lastError = error instanceof Error ? error.message : String(error);
        throw error;
      } finally {
        this.recordLatency(Date.now() - startedAt);
        this.inflight = null;
      }
      return this.snapshot();
    })();
    return this.inflight;
  }

  private recordLatency(value: number) {
    const bounded = Math.max(0, Math.min(Number(value) || 0, 3_600_000));
    this.latencySamples.push(bounded);
    if (this.latencySamples.length > 64) this.latencySamples.shift();
  }

  private latencyStats() {
    if (!this.latencySamples.length) return { last:null, p50:null, p95:null, max:null, samples:0 };
    const sorted=[...this.latencySamples].sort((a,b)=>a-b);
    const pick=(q:number)=>sorted[Math.min(sorted.length-1,Math.max(0,Math.ceil(sorted.length*q)-1))];
    return { last:this.latencySamples[this.latencySamples.length-1] ?? null, p50:pick(0.50) ?? null, p95:pick(0.95) ?? null, max:sorted[sorted.length-1] ?? null, samples:sorted.length };
  }

  snapshot(): HealthSnapshotView<T> {
    const now = Date.now();
    const ageMs = this.latest ? Math.max(0, now - this.latest.at) : null;
    const degradedReason = this.latest && this.options.isDegraded ? this.options.isDegraded(this.latest.data) : null;
    const stale = ageMs != null && ageMs > this.staleAfterMs;
    const state: HealthSnapshotState = !this.latest ? "warming" : stale ? "stale" : degradedReason ? "degraded" : "healthy";
    const deepHealthReason = !this.latest ? "No background snapshot is available yet." : stale ? `Background health snapshot is stale (${ageMs} ms old).` : degradedReason;
    return {
      available: Boolean(this.latest),
      mode: "background-health-snapshot-v1",
      state,
      collectedAt: this.latest ? new Date(this.latest.at).toISOString() : null,
      ageMs,
      refreshIntervalMs: this.refreshIntervalMs,
      staleAfterMs: this.staleAfterMs,
      deepHealthRequired: state !== "healthy",
      deepHealthReason: deepHealthReason ?? null,
      refreshInFlight: Boolean(this.inflight),
      refreshCount: this.refreshCount,
      failureCount: this.failureCount,
      lastError: this.lastError,
      collectorLatencyMs: this.latencyStats(),
      data: this.latest?.data ?? null,
    };
  }
}

/**
 * Per-process NHD video subprocess governor.
 * Restricts concurrent ffmpeg/yt-dlp/ASR children so a burst of video
 * requests cannot monopolize RAM/CPU while the user's browser is active.
 * Does not modify browser extensions, tabs, media files or OS affinities.
 */
export type VideoProcessGateStatus = {
  limit: number;
  active: number;
  queued: number;
  queueLimit: number;
  maxWaitMs: number;
};

export class VideoProcessGate {
  private active = 0;
  private waiters: Array<{ resolve: (release: () => void) => void; reject: (err: Error) => void; timer: ReturnType<typeof setTimeout> }> = [];

  constructor(
    readonly limit = 2,
    readonly queueLimit = 16,
    readonly maxWaitMs = 5 * 60 * 1000
  ) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 8) throw new Error("Invalid video process concurrency limit.");
    if (!Number.isInteger(queueLimit) || queueLimit < 0 || queueLimit > 1024) throw new Error("Invalid video process queue limit.");
    if (!Number.isFinite(maxWaitMs) || maxWaitMs < 1) throw new Error("Invalid video queue wait timeout.");
  }

  status(): VideoProcessGateStatus {
    return { limit: this.limit, active: this.active, queued: this.waiters.length, queueLimit: this.queueLimit, maxWaitMs: this.maxWaitMs };
  }

  private release(): void {
    this.active -= 1;
    const next = this.waiters.shift();
    if (next) {
      clearTimeout(next.timer);
      this.active += 1;
      next.resolve(() => this.release());
    }
  }

  private acquire(): Promise<() => void> {
    if (this.active < this.limit) {
      this.active += 1;
      return Promise.resolve(() => this.release());
    }
    if (this.waiters.length >= this.queueLimit) {
      return Promise.reject(new Error("Video processing is busy; bounded task queue is full."));
    }
    return new Promise((resolve, reject) => {
      const entry = {
        resolve,
        reject,
        timer: undefined as unknown as ReturnType<typeof setTimeout>
      };
      entry.timer = setTimeout(() => {
        const index = this.waiters.indexOf(entry);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new Error("Video processing slot wait timed out; no subprocess was started."));
      }, this.maxWaitMs);
      entry.timer.unref?.();
      this.waiters.push(entry);
    });
  }

  async withSlot<T>(work: () => Promise<T>): Promise<T> {
    const release = await this.acquire();
    try {
      return await work();
    } finally {
      release();
    }
  }
}

const requested = Number(process.env.NHD_VIDEO_MAX_CHILDREN || 2);
const cap = Number.isFinite(requested) ? Math.max(1, Math.min(4, Math.floor(requested))) : 2;
export const videoProcessGate = new VideoProcessGate(cap);

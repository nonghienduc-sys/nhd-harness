import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync, unlinkSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { videoProcessGate } from "./video-process-gate.js";
import { basename, extname, resolve, sep } from "node:path";
import { AppConfig } from "./config.js";
import { Store } from "./db.js";

import { resolveNhdPython } from "./python-runtime.js";
export type VideoMode = "fast" | "smart" | "deep";
export type TranscriptSegment = { start: number; end: number; text: string };
export type VideoKeyframe = { id: string; at: number; path: string; source: "scene" | "uniform" | "cover" | "ondemand" };
export type VideoTimelineChunk = { start: number; end: number; text: string; keyframeIds: string[] };

type ProcessResult = { stdout: string; stderr: string; code: number };
type VideoManifest = {
  schemaVersion: 1;
  videoId: string;
  source: string;
  sourceType: "local" | "url";
  fingerprint: string;
  mode: VideoMode;
  title: string | null;
  duration: number | null;
  width: number | null;
  height: number | null;
  transcriptSource: "embedded-subtitle" | "remote-caption" | "local-asr" | "none";
  transcriptLanguage: string | null;
  transcript: TranscriptSegment[];
  keyframes: VideoKeyframe[];
  timeline: VideoTimelineChunk[];
  visualSource: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
};

const VIDEO_EXTENSIONS = new Set([".mp4", ".mkv", ".mov", ".m4v", ".webm", ".avi", ".wmv", ".ts", ".mts", ".m2ts", ".mpg", ".mpeg"]);
const AUDIO_EXTENSIONS = new Set([".m4a", ".mp3", ".wav", ".aac", ".flac", ".ogg", ".opus", ".webm"]);
const TEXT_SUBTITLE_CODECS = new Set(["subrip", "srt", "ass", "ssa", "webvtt", "mov_text", "text"]);
const MODE_RANK: Record<VideoMode, number> = { fast: 1, smart: 2, deep: 3 };

function sha256(value: string | Buffer) {
  return createHash("sha256").update(value).digest("hex");
}

function clipText(value: string, max = 30_000) {
  return value.length <= max ? value : value.slice(0, max) + "\n...[truncated]";
}

function numeric(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function formatSeconds(value: number) {
  return Math.max(0, Math.round(value * 1000) / 1000);
}

function parseTimestamp(value: string): number | null {
  const normalized = value.trim().replace(",", ".");
  const parts = normalized.split(":").map(Number);
  if (!parts.length || parts.some((part) => !Number.isFinite(part))) return null;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parts[0];
}

function cleanCaptionText(value: string) {
  return value
    .replace(/<\d{2}:\d{2}:\d{2}[.,]\d{3}>/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

export function parseVtt(content: string): TranscriptSegment[] {
  const normalized = content.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  const blocks = normalized.split(/\n{2,}/);
  const segments: TranscriptSegment[] = [];
  for (const block of blocks) {
    const lines = block.split("\n").map((line) => line.trim()).filter(Boolean);
    const timeIndex = lines.findIndex((line) => line.includes("-->"));
    if (timeIndex < 0) continue;
    const match = lines[timeIndex].match(/^([^ ]+)\s+-->\s+([^ ]+)/);
    if (!match) continue;
    const start = parseTimestamp(match[1]);
    const end = parseTimestamp(match[2]);
    if (start == null || end == null || end < start) continue;
    const text = cleanCaptionText(lines.slice(timeIndex + 1).join(" "));
    if (!text) continue;
    const previous = segments.at(-1);
    if (previous && previous.text === text && Math.abs(previous.end - start) < 1.5) {
      previous.end = Math.max(previous.end, end);
      continue;
    }
    segments.push({ start: formatSeconds(start), end: formatSeconds(end), text });
  }
  return segments;
}

export function buildTimeline(transcript: TranscriptSegment[], keyframes: VideoKeyframe[], duration: number | null, chunkSeconds = 45): VideoTimelineChunk[] {
  const chunks = new Map<number, VideoTimelineChunk>();
  for (const segment of transcript) {
    const key = Math.floor(Math.max(0, segment.start) / chunkSeconds) * chunkSeconds;
    const existing = chunks.get(key) ?? { start: key, end: Math.min(duration ?? key + chunkSeconds, key + chunkSeconds), text: "", keyframeIds: [] };
    existing.end = Math.max(existing.end, segment.end);
    existing.text = `${existing.text} ${segment.text}`.trim();
    chunks.set(key, existing);
  }
  if (!chunks.size && duration != null) {
    for (let start = 0; start < duration; start += chunkSeconds) {
      chunks.set(start, { start, end: Math.min(duration, start + chunkSeconds), text: "", keyframeIds: [] });
    }
  }
  for (const frame of keyframes) {
    const candidates = [...chunks.values()];
    if (!candidates.length) {
      const key = Math.floor(frame.at / chunkSeconds) * chunkSeconds;
      chunks.set(key, { start: key, end: key + chunkSeconds, text: "", keyframeIds: [frame.id] });
      continue;
    }
    const chunk = candidates.find((item) => frame.at >= item.start && frame.at <= item.end)
      ?? candidates.reduce((best, item) => Math.abs(item.start - frame.at) < Math.abs(best.start - frame.at) ? item : best);
    if (!chunk.keyframeIds.includes(frame.id)) chunk.keyframeIds.push(frame.id);
  }
  return [...chunks.values()]
    .sort((a, b) => a.start - b.start)
    .map((chunk) => ({ ...chunk, text: clipText(chunk.text, 4000) }));
}

function normalizeSearch(value: string) {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

export function lexicalSearch(timeline: VideoTimelineChunk[], query: string, limit = 8) {
  const normalizedQuery = normalizeSearch(query);
  const tokens = [...new Set(normalizedQuery.split(/\s+/).filter((token) => token.length > 1))];
  if (!normalizedQuery) return [];
  return timeline.map((chunk) => {
    const text = normalizeSearch(chunk.text);
    let score = text.includes(normalizedQuery) ? 20 : 0;
    for (const token of tokens) {
      let offset = 0;
      let count = 0;
      while ((offset = text.indexOf(token, offset)) >= 0) { count += 1; offset += token.length; }
      score += Math.min(6, count) * 2;
    }
    return { ...chunk, score };
  }).filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score || a.start - b.start)
    .slice(0, Math.max(1, Math.min(limit, 30)));
}

function isHttpUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch { return false; }
}

async function runProcess(command: string, args: string[], options: { cwd?: string; timeoutMs?: number; maxOutput?: number } = {}): Promise<ProcessResult> {
  // Restrict globally concurrent video subprocesses to protect browser responsiveness.
  return await videoProcessGate.withSlot(async () => {
    const timeoutMs = options.timeoutMs ?? 120_000;
    const maxOutput = options.maxOutput ?? 20 * 1024 * 1024;
    return await new Promise<ProcessResult>((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let overflow = false;
    const append = (kind: "stdout" | "stderr", chunk: Buffer) => {
      const value = chunk.toString("utf8");
      if (stdout.length + stderr.length + value.length > maxOutput) { overflow = true; return; }
      if (kind === "stdout") stdout += value; else stderr += value;
    };
    child.stdout.on("data", (chunk: Buffer) => append("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer) => append("stderr", chunk));
    child.on("error", reject);
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch {}
      reject(new Error(`Process timed out after ${Math.round(timeoutMs / 1000)}s: ${basename(command)}`));
    }, timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      if (overflow) return reject(new Error(`Process output exceeded ${maxOutput} bytes: ${basename(command)}`));
      resolvePromise({ stdout, stderr, code: code ?? -1 });
    });
    });
  });
}

function commandPath(name: string, envName: string) {
  const configured = String(process.env[envName] ?? "").trim();
  if (configured && existsSync(configured)) return configured;
  try {
    const probe = spawnSync("where.exe", [name], { encoding: "utf8", windowsHide: true, timeout: 3000 });
    const first = String(probe.stdout ?? "").split(/\r?\n/).map((item) => item.trim()).find((item) => item && existsSync(item));
    return first ?? null;
  } catch { return null; }
}

function safeJson(path: string): Record<string, unknown> | null {
  try { return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>; } catch { return null; }
}

function chooseRepresentative<T>(items: T[], max: number): T[] {
  if (items.length <= max) return items;
  const chosen: T[] = [];
  for (let i = 0; i < max; i += 1) {
    const index = Math.round((i / Math.max(1, max - 1)) * (items.length - 1));
    chosen.push(items[index]);
  }
  return chosen;
}

export class VideoService {
  readonly cacheRoot: string;
  readonly ffmpeg: string | null;
  readonly ffprobe: string | null;
  readonly ytdlp: string | null;
  readonly python: string | null;
  readonly transcriberScript: string;
  readonly localAsrAvailable: boolean;

  constructor(readonly config: AppConfig, readonly store?: Store) {
    this.cacheRoot = resolve(config.dataDir, "video-intelligence");
    mkdirSync(this.cacheRoot, { recursive: true });
    this.ffmpeg = commandPath("ffmpeg.exe", "NHD_FFMPEG_PATH") ?? commandPath("ffmpeg", "NHD_FFMPEG_PATH");
    this.ffprobe = commandPath("ffprobe.exe", "NHD_FFPROBE_PATH") ?? commandPath("ffprobe", "NHD_FFPROBE_PATH");
    this.ytdlp = commandPath("yt-dlp.exe", "NHD_YTDLP_PATH") ?? commandPath("yt-dlp", "NHD_YTDLP_PATH");
    this.python = resolveNhdPython();
    this.transcriberScript = resolve(process.cwd(), "skills", "video-understanding", "scripts", "transcribe_local.py");
    let localAsr = false;
    if (this.python && existsSync(this.transcriberScript)) {
      try {
        const probe = spawnSync(this.python, ["-c", "import importlib.util,sys; sys.exit(0 if importlib.util.find_spec(\'faster_whisper\') else 1)"], { windowsHide: true, timeout: 3000 });
        localAsr = probe.status === 0;
      } catch {}
    }
    this.localAsrAvailable = localAsr;
  }

  status() {
    return {
      available: Boolean(this.ffmpeg && this.ffprobe),
      ffmpeg: this.ffmpeg,
      ffprobe: this.ffprobe,
      ytDlp: this.ytdlp,
      python: this.python,
      localAsr: this.localAsrAvailable,
      localAsrEngine: this.localAsrAvailable ? "faster-whisper" : null,
      localAsrDefaults: { fast: "tiny", smart: "base", deep: "small", device: "cpu-int8 when CUDA is unavailable" },
      cacheRoot: this.cacheRoot,
      processGovernor: videoProcessGate.status(),
      supportedLocalExtensions: [...VIDEO_EXTENSIONS],
      strategy: "subtitle-first + local ASR fallback + sparse keyframes + cached semantic timeline",
    };
  }

  private assertLocalPath(input: string) {
    const resolved = resolve(input);
    if (!existsSync(resolved) || !statSync(resolved).isFile()) throw new Error("Video file was not found.");
    const extension = extname(resolved).toLowerCase();
    if (!VIDEO_EXTENSIONS.has(extension) && !AUDIO_EXTENSIONS.has(extension)) throw new Error(`Unsupported media extension: ${extension || "(none)"}`);
    const real = realpathSync(resolved);
    const roots = [...this.config.roots, ...this.config.intakeRoots].filter(Boolean).map((root) => {
      try { return realpathSync(resolve(root)); } catch { return resolve(root); }
    });
    const allowed = roots.some((root) => real.toLowerCase() === root.toLowerCase() || real.toLowerCase().startsWith(root.toLowerCase().endsWith(sep) ? root.toLowerCase() : root.toLowerCase() + sep));
    if (!allowed) throw new Error("Media path is outside configured workstation roots/intake roots.");
    return real;
  }

  private normalizeSource(source: string) {
    const trimmed = source.trim();
    if (!trimmed) throw new Error("source is required.");
    if (isHttpUrl(trimmed)) return { sourceType: "url" as const, source: new URL(trimmed).toString() };
    return { sourceType: "local" as const, source: this.assertLocalPath(trimmed) };
  }

  private async probeLocal(path: string) {
    if (!this.ffprobe) throw new Error("ffprobe is required for local video inspection.");
    const probe = await runProcess(this.ffprobe, ["-v", "error", "-show_format", "-show_streams", "-of", "json", path], { timeoutMs: 30_000 });
    if (probe.code !== 0) throw new Error(`ffprobe failed: ${clipText(probe.stderr, 3000)}`);
    const raw = JSON.parse(probe.stdout) as { format?: Record<string, unknown>; streams?: Array<Record<string, unknown>> };
    const streams = Array.isArray(raw.streams) ? raw.streams : [];
    const videoStream = streams.find((stream) => stream.codec_type === "video");
    const audioStream = streams.find((stream) => stream.codec_type === "audio");
    const subtitleStreams = streams.filter((stream) => stream.codec_type === "subtitle");
    return {
      raw,
      title: String((raw.format?.tags as Record<string, unknown> | undefined)?.title ?? basename(path)),
      duration: numeric(raw.format?.duration ?? videoStream?.duration ?? audioStream?.duration),
      width: numeric(videoStream?.width),
      height: numeric(videoStream?.height),
      fps: String(videoStream?.avg_frame_rate ?? videoStream?.r_frame_rate ?? "") || null,
      audioPresent: Boolean(audioStream),
      subtitleStreams: subtitleStreams.map((stream) => ({ index: numeric(stream.index), codec: String(stream.codec_name ?? ""), language: String((stream.tags as Record<string, unknown> | undefined)?.language ?? "") || null, title: String((stream.tags as Record<string, unknown> | undefined)?.title ?? "") || null })),
    };
  }

  private async probeUrl(url: string) {
    if (!this.ytdlp) throw new Error("yt-dlp is required for URL video inspection.");
    const probe = await runProcess(this.ytdlp, ["--dump-single-json", "--skip-download", "--no-warnings", "--no-playlist", "--socket-timeout", "20", url], { timeoutMs: 60_000, maxOutput: 30 * 1024 * 1024 });
    if (probe.code !== 0) throw new Error(`yt-dlp metadata failed: ${clipText(probe.stderr || probe.stdout, 4000)}`);
    const raw = JSON.parse(probe.stdout) as Record<string, unknown>;
    const subtitles = (raw.subtitles && typeof raw.subtitles === "object" ? raw.subtitles : {}) as Record<string, unknown>;
    const automatic = (raw.automatic_captions && typeof raw.automatic_captions === "object" ? raw.automatic_captions : {}) as Record<string, unknown>;
    return {
      raw,
      title: String(raw.title ?? raw.fulltitle ?? raw.id ?? url),
      duration: numeric(raw.duration),
      width: numeric(raw.width),
      height: numeric(raw.height),
      fps: numeric(raw.fps),
      audioPresent: true,
      subtitleLanguages: Object.keys(subtitles),
      automaticCaptionLanguages: Object.keys(automatic),
      extractor: String(raw.extractor_key ?? raw.extractor ?? "") || null,
      live: Boolean(raw.is_live),
    };
  }

  async inspect(source?: string) {
    if (!source) return { dependencies: this.status() };
    const normalized = this.normalizeSource(source);
    if (normalized.sourceType === "local") {
      const info = await this.probeLocal(normalized.source);
      return {
        sourceType: "local",
        source: normalized.source,
        title: info.title,
        duration: info.duration,
        width: info.width,
        height: info.height,
        fps: info.fps,
        audioPresent: info.audioPresent,
        embeddedSubtitles: info.subtitleStreams,
        dependencies: this.status(),
      };
    }
    const info = await this.probeUrl(normalized.source);
    return {
      sourceType: "url",
      source: normalized.source,
      title: info.title,
      duration: info.duration,
      width: info.width,
      height: info.height,
      fps: info.fps,
      audioPresent: info.audioPresent,
      subtitleLanguages: info.subtitleLanguages,
      automaticCaptionLanguages: info.automaticCaptionLanguages,
      extractor: info.extractor,
      live: info.live,
      dependencies: this.status(),
    };
  }

  private fingerprint(normalized: { sourceType: "local" | "url"; source: string }) {
    if (normalized.sourceType === "url") return sha256("url|" + normalized.source);
    const stat = statSync(normalized.source);
    return sha256(`local|${normalized.source}|${stat.size}|${stat.mtimeMs}`);
  }

  private manifestPath(videoId: string) {
    if (!/^[a-f0-9]{24}$/.test(videoId)) throw new Error("Invalid video_id.");
    return resolve(this.cacheRoot, videoId, "manifest.json");
  }

  private loadManifest(videoId: string): VideoManifest {
    const path = this.manifestPath(videoId);
    const parsed = safeJson(path) as VideoManifest | null;
    if (!parsed || parsed.schemaVersion !== 1 || parsed.videoId !== videoId) throw new Error("Video cache was not found. Run video_understand first.");
    return parsed;
  }

  private writeManifest(manifest: VideoManifest) {
    const dir = resolve(this.cacheRoot, manifest.videoId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(resolve(dir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
  }

  private chooseCaptionLanguage(info: Awaited<ReturnType<VideoService["probeUrl"]>>, preferred?: string) {
    const available = [...new Set([...info.subtitleLanguages, ...info.automaticCaptionLanguages])];
    if (!available.length) return null;
    const candidates = [preferred, preferred?.split("-")[0], "vi", "en"].filter(Boolean).map((item) => String(item).toLowerCase());
    for (const candidate of candidates) {
      const exact = available.find((lang) => lang.toLowerCase() === candidate);
      if (exact) return exact;
      const prefix = available.find((lang) => lang.toLowerCase().startsWith(candidate + "-"));
      if (prefix) return prefix;
    }
    return available[0];
  }

  private async remoteCaption(url: string, info: Awaited<ReturnType<VideoService["probeUrl"]>>, jobDir: string, preferred?: string) {
    const language = this.chooseCaptionLanguage(info, preferred);
    if (!language || !this.ytdlp) return null;
    const outputTemplate = resolve(jobDir, "caption.%(ext)s");
    const run = await runProcess(this.ytdlp, ["--skip-download", "--no-playlist", "--no-warnings", "--write-subs", "--write-auto-subs", "--sub-langs", language, "--sub-format", "vtt", "--output", outputTemplate, url], { timeoutMs: 90_000 });
    const files = readdirSync(jobDir).filter((name) => name.toLowerCase().endsWith(".vtt") && name.toLowerCase().startsWith("caption")).sort();
    if (!files.length) {
      this.store?.audit("video_caption", "miss", { urlHost: new URL(url).host, language, code: run.code });
      return null;
    }
    const path = resolve(jobDir, files[0]);
    const transcript = parseVtt(readFileSync(path, "utf8"));
    if (!transcript.length) return null;
    return { source: "remote-caption" as const, language, transcript, path };
  }

  private async embeddedCaption(path: string, info: Awaited<ReturnType<VideoService["probeLocal"]>>, jobDir: string) {
    if (!this.ffmpeg) return null;
    const stream = info.subtitleStreams.find((item) => item.index != null && TEXT_SUBTITLE_CODECS.has(item.codec));
    if (!stream || stream.index == null) return null;
    const output = resolve(jobDir, "embedded.vtt");
    const run = await runProcess(this.ffmpeg, ["-y", "-hide_banner", "-loglevel", "error", "-i", path, "-map", `0:${stream.index}`, output], { timeoutMs: 60_000 });
    if (run.code !== 0 || !existsSync(output)) return null;
    const transcript = parseVtt(readFileSync(output, "utf8"));
    if (!transcript.length) return null;
    return { source: "embedded-subtitle" as const, language: stream.language, transcript, path: output };
  }

  private async downloadUrlAudio(url: string, jobDir: string) {
    if (!this.ytdlp) throw new Error("yt-dlp is required to obtain URL audio.");
    const output = resolve(jobDir, "audio.%(ext)s");
    const run = await runProcess(this.ytdlp, ["--no-playlist", "--no-warnings", "-f", "bestaudio/best", "--output", output, url], { timeoutMs: 20 * 60_000 });
    if (run.code !== 0) throw new Error(`yt-dlp audio download failed: ${clipText(run.stderr || run.stdout, 3000)}`);
    const candidate = readdirSync(jobDir).map((name) => resolve(jobDir, name)).find((path) => basename(path).toLowerCase().startsWith("audio.") && statSync(path).isFile());
    if (!candidate) throw new Error("Downloaded audio file was not found.");
    return candidate;
  }

  private async localTranscribe(input: string, jobDir: string, mode: VideoMode, language?: string, modelOverride?: string) {
    if (!this.python || !this.localAsrAvailable || !existsSync(this.transcriberScript)) return null;
    const model = modelOverride?.trim() || (mode === "fast" ? "tiny" : mode === "deep" ? "small" : "base");
    const output = resolve(jobDir, "transcript.local.json");
    const args = [this.transcriberScript, "--input", input, "--output", output, "--model", model];
    if (language?.trim()) args.push("--language", language.trim());
    const run = await runProcess(this.python, args, { timeoutMs: 2 * 60 * 60_000, maxOutput: 4 * 1024 * 1024 });
    if (run.code !== 0 || !existsSync(output)) throw new Error(`Local ASR failed: ${clipText(run.stderr || run.stdout, 5000)}`);
    const parsed = JSON.parse(readFileSync(output, "utf8")) as { language?: string; segments?: TranscriptSegment[] };
    const transcript = Array.isArray(parsed.segments) ? parsed.segments.filter((segment) => segment && Number.isFinite(segment.start) && Number.isFinite(segment.end) && String(segment.text ?? "").trim()).map((segment) => ({ start: formatSeconds(segment.start), end: formatSeconds(segment.end), text: String(segment.text).trim() })) : [];
    if (!transcript.length) return null;
    return { source: "local-asr" as const, language: parsed.language ?? language ?? null, transcript, path: output, model };
  }

  private async prepareTranscript(normalized: { sourceType: "local" | "url"; source: string }, info: any, jobDir: string, mode: VideoMode, language?: string, modelOverride?: string) {
    if (normalized.sourceType === "local") {
      const embedded = await this.embeddedCaption(normalized.source, info, jobDir);
      if (embedded) return embedded;
      if (!info.audioPresent) return { source: "none" as const, language: null, transcript: [] as TranscriptSegment[] };
      const transcribed = await this.localTranscribe(normalized.source, jobDir, mode, language, modelOverride);
      return transcribed ?? { source: "none" as const, language: null, transcript: [] as TranscriptSegment[] };
    }
    const caption = await this.remoteCaption(normalized.source, info, jobDir, language);
    if (caption) return caption;
    if (!this.localAsrAvailable) return { source: "none" as const, language: null, transcript: [] as TranscriptSegment[] };
    const audio = await this.downloadUrlAudio(normalized.source, jobDir);
    try {
      const transcribed = await this.localTranscribe(audio, jobDir, mode, language, modelOverride);
      return transcribed ?? { source: "none" as const, language: null, transcript: [] as TranscriptSegment[] };
    } finally {
      // Only the temporary downloaded audio working copy is removed.
      // Source video, transcript, keyframes and reusable manifest are retained.
      if (audio.startsWith(jobDir + sep) && basename(audio).toLowerCase().startsWith("audio.")) {
        try { unlinkSync(audio); } catch {}
      }
    }
  }

  private async downloadUrlVisual(url: string, jobDir: string, mode: VideoMode) {
    if (!this.ytdlp) return null;
    const existing = readdirSync(jobDir).map((name) => resolve(jobDir, name)).find((path) => basename(path).toLowerCase().startsWith("visual.") && statSync(path).isFile());
    if (existing) return existing;
    const format = mode === "deep"
      ? "best[height<=720]/best[height<=480]/worst"
      : "best[height<=360]/worst";
    const run = await runProcess(this.ytdlp, ["--no-playlist", "--no-warnings", "-f", format, "--output", resolve(jobDir, "visual.%(ext)s"), url], { timeoutMs: 25 * 60_000 });
    if (run.code !== 0) return null;
    return readdirSync(jobDir).map((name) => resolve(jobDir, name)).find((path) => basename(path).toLowerCase().startsWith("visual.") && statSync(path).isFile()) ?? null;
  }

  private async extractFrameAt(videoPath: string, at: number, output: string, width = 960) {
    if (!this.ffmpeg) throw new Error("ffmpeg is required for frame extraction.");
    const filter = `scale=w='min(${width},iw)':h=-2`;
    const run = await runProcess(this.ffmpeg, ["-y", "-hide_banner", "-loglevel", "error", "-ss", String(Math.max(0, at)), "-i", videoPath, "-frames:v", "1", "-vf", filter, "-q:v", "4", output], { timeoutMs: 45_000 });
    if (run.code !== 0 || !existsSync(output)) throw new Error(`Frame extraction failed at ${at}s: ${clipText(run.stderr, 2000)}`);
    return output;
  }

  private async withConcurrency<T>(values: T[], limit: number, worker: (value: T, index: number) => Promise<void>) {
    let cursor = 0;
    const runners = Array.from({ length: Math.min(limit, values.length) }, async () => {
      while (cursor < values.length) {
        const index = cursor++;
        await worker(values[index], index);
      }
    });
    await Promise.all(runners);
  }

  private async extractKeyframes(videoPath: string, duration: number | null, jobDir: string, mode: VideoMode, maxOverride?: number) {
    if (!this.ffmpeg) return [] as VideoKeyframe[];
    const target = Math.max(1, Math.min(maxOverride ?? (mode === "fast" ? 10 : mode === "deep" ? 36 : 20), 60));
    const frameDir = resolve(jobDir, "frames");
    mkdirSync(frameDir, { recursive: true });
    const frames: VideoKeyframe[] = [];
    const coverPath = resolve(frameDir, "cover.jpg");
    try {
      await this.extractFrameAt(videoPath, 0, coverPath);
      frames.push({ id: "cover", at: 0, path: coverPath, source: "cover" });
    } catch {}

    if (mode !== "fast") {
      const threshold = mode === "deep" ? 0.20 : 0.30;
      const scenePattern = resolve(frameDir, "scene-%03d.jpg");
      const filter = `select=gt(scene\\,${threshold}),scale=w='min(960,iw)':h=-2,showinfo`;
      const run = await runProcess(this.ffmpeg, ["-y", "-hide_banner", "-loglevel", "info", "-skip_frame", "nokey", "-i", videoPath, "-vf", filter, "-fps_mode", "vfr", "-frames:v", String(Math.max(1, target - 1)), "-q:v", "4", scenePattern], { timeoutMs: 20 * 60_000, maxOutput: 16 * 1024 * 1024 });
      if (run.code === 0 || readdirSync(frameDir).some((name) => name.startsWith("scene-"))) {
        const times = [...run.stderr.matchAll(/pts_time:([0-9.]+)/g)].map((match) => Number(match[1])).filter(Number.isFinite);
        const files = readdirSync(frameDir).filter((name) => /^scene-\d+\.jpg$/i.test(name)).sort();
        files.forEach((name, index) => {
          const at = formatSeconds(times[index] ?? (duration && files.length ? ((index + 1) / (files.length + 1)) * duration : index + 1));
          frames.push({ id: `scene-${String(index + 1).padStart(3, "0")}`, at, path: resolve(frameDir, name), source: "scene" });
        });
      }
    }

    if (duration != null && duration > 0 && frames.length < target) {
      const needed = target - frames.length;
      const candidates = Array.from({ length: Math.max(target, needed * 2) }, (_, index) => formatSeconds(((index + 1) / (Math.max(target, needed * 2) + 1)) * duration))
        .filter((at) => !frames.some((frame) => Math.abs(frame.at - at) < Math.max(1.5, duration / (target * 4))))
        .slice(0, needed);
      await this.withConcurrency(candidates, mode === "deep" ? 3 : 4, async (at, index) => {
        const id = `uniform-${String(index + 1).padStart(3, "0")}`;
        const path = resolve(frameDir, id + ".jpg");
        try {
          await this.extractFrameAt(videoPath, at, path, mode === "fast" ? 720 : 960);
          frames.push({ id, at, path, source: "uniform" });
        } catch {}
      });
    }
    return frames.sort((a, b) => a.at - b.at).slice(0, target);
  }

  private manifestPublic(manifest: VideoManifest) {
    const transcriptText = manifest.transcript.map((segment) => segment.text).join(" ");
    const timelineLimit = manifest.mode === "deep" ? 120 : manifest.mode === "smart" ? 80 : 50;
    return {
      videoId: manifest.videoId,
      sourceType: manifest.sourceType,
      title: manifest.title,
      duration: manifest.duration,
      dimensions: manifest.width && manifest.height ? { width: manifest.width, height: manifest.height } : null,
      mode: manifest.mode,
      transcript: {
        source: manifest.transcriptSource,
        language: manifest.transcriptLanguage,
        segments: manifest.transcript.length,
        preview: clipText(transcriptText, 24_000),
      },
      keyframes: manifest.keyframes.map(({ id, at, source }) => ({ id, at, source })),
      timeline: manifest.timeline.slice(0, timelineLimit),
      timelineTruncated: manifest.timeline.length > timelineLimit,
      cachedAt: manifest.createdAt,
      cacheReusable: true,
    };
  }

  private imagePayload(path: string, at: number, id: string) {
    const data = readFileSync(path).toString("base64");
    return { id, at, mimeType: "image/jpeg", data };
  }

  async understand(input: { source: string; mode?: VideoMode; language?: string; maxKeyframes?: number; force?: boolean; asrModel?: string }) {
    const mode = input.mode ?? "smart";
    const normalized = this.normalizeSource(input.source);
    const fingerprint = this.fingerprint(normalized);
    const videoId = fingerprint.slice(0, 24);
    const jobDir = resolve(this.cacheRoot, videoId);
    mkdirSync(jobDir, { recursive: true });
    const manifestPath = resolve(jobDir, "manifest.json");
    if (!input.force && existsSync(manifestPath)) {
      const cached = safeJson(manifestPath) as VideoManifest | null;
      if (cached?.schemaVersion === 1 && cached.fingerprint === fingerprint && MODE_RANK[cached.mode] >= MODE_RANK[mode]) {
        const publicResult = this.manifestPublic(cached);
        const images = chooseRepresentative(cached.keyframes, mode === "deep" ? 8 : mode === "smart" ? 6 : 3).map((frame) => this.imagePayload(frame.path, frame.at, frame.id));
        return { ...publicResult, cacheHit: true, images };
      }
    }

    const info = normalized.sourceType === "local" ? await this.probeLocal(normalized.source) : await this.probeUrl(normalized.source);
    const transcriptPromise = this.prepareTranscript(normalized, info, jobDir, mode, input.language, input.asrModel);
    const visualPromise = normalized.sourceType === "local"
      ? Promise.resolve(VIDEO_EXTENSIONS.has(extname(normalized.source).toLowerCase()) ? normalized.source : null)
      : (mode === "fast" ? Promise.resolve(null) : this.downloadUrlVisual(normalized.source, jobDir, mode));
    const [transcriptResult, visualSource] = await Promise.all([transcriptPromise, visualPromise]);
    const keyframes = visualSource
      ? await this.extractKeyframes(visualSource, info.duration, jobDir, mode, input.maxKeyframes)
      : [];
    const chunkSeconds = mode === "fast" ? 75 : mode === "deep" ? 25 : 45;
    const timeline = buildTimeline(transcriptResult.transcript, keyframes, info.duration, chunkSeconds);
    const manifest: VideoManifest = {
      schemaVersion: 1,
      videoId,
      source: normalized.source,
      sourceType: normalized.sourceType,
      fingerprint,
      mode,
      title: info.title ?? null,
      duration: info.duration ?? null,
      width: info.width ?? null,
      height: info.height ?? null,
      transcriptSource: transcriptResult.source,
      transcriptLanguage: transcriptResult.language ?? null,
      transcript: transcriptResult.transcript,
      keyframes,
      timeline,
      visualSource,
      metadata: normalized.sourceType === "url"
        ? { extractor: (info as any).extractor, live: (info as any).live, subtitleLanguages: (info as any).subtitleLanguages, automaticCaptionLanguages: (info as any).automaticCaptionLanguages }
        : { subtitleStreams: (info as any).subtitleStreams, audioPresent: info.audioPresent, fps: info.fps },
      createdAt: new Date().toISOString(),
    };
    this.writeManifest(manifest);
    this.store?.audit("video_understand", "success", { videoId, sourceType: normalized.sourceType, mode, transcriptSource: manifest.transcriptSource, transcriptSegments: manifest.transcript.length, keyframes: manifest.keyframes.length, duration: manifest.duration });
    const images = chooseRepresentative(keyframes, mode === "deep" ? 8 : mode === "smart" ? 6 : 3).map((frame) => this.imagePayload(frame.path, frame.at, frame.id));
    return { ...this.manifestPublic(manifest), cacheHit: false, images };
  }

  search(videoId: string, query: string, limit = 8) {
    const manifest = this.loadManifest(videoId);
    const matches = lexicalSearch(manifest.timeline, query, limit);
    return { videoId, query, matches, transcriptSource: manifest.transcriptSource, language: manifest.transcriptLanguage };
  }

  private async ensureVisual(manifest: VideoManifest) {
    if (manifest.visualSource && existsSync(manifest.visualSource)) return manifest.visualSource;
    if (manifest.sourceType === "local" && VIDEO_EXTENSIONS.has(extname(manifest.source).toLowerCase())) return manifest.source;
    if (manifest.sourceType === "url") {
      const dir = resolve(this.cacheRoot, manifest.videoId);
      const visual = await this.downloadUrlVisual(manifest.source, dir, "smart");
      if (visual) {
        manifest.visualSource = visual;
        this.writeManifest(manifest);
        return visual;
      }
    }
    throw new Error("No visual stream is available for this video.");
  }

  async frame(videoId: string, timestamp: number, width = 1280) {
    const manifest = this.loadManifest(videoId);
    const at = Math.max(0, Math.min(Number.isFinite(timestamp) ? timestamp : 0, manifest.duration ?? Number.MAX_SAFE_INTEGER));
    const visual = await this.ensureVisual(manifest);
    const dir = resolve(this.cacheRoot, videoId, "frames", "ondemand");
    mkdirSync(dir, { recursive: true });
    const id = `ondemand-${Math.round(at * 1000)}`;
    const path = resolve(dir, id + ".jpg");
    if (!existsSync(path)) await this.extractFrameAt(visual, at, path, Math.max(320, Math.min(width, 1920)));
    const image = this.imagePayload(path, formatSeconds(at), id);
    const nearby = manifest.transcript.filter((segment) => segment.end >= at - 8 && segment.start <= at + 8);
    return { videoId, title: manifest.title, at: formatSeconds(at), nearbyTranscript: nearby, image };
  }

  async context(videoId: string, start: number, end: number, maxFrames = 6) {
    const manifest = this.loadManifest(videoId);
    const from = Math.max(0, Number.isFinite(start) ? start : 0);
    const to = Math.max(from, Number.isFinite(end) ? end : from + 60);
    const transcript = manifest.transcript.filter((segment) => segment.end >= from && segment.start <= to);
    let frames = manifest.keyframes.filter((frame) => frame.at >= from && frame.at <= to);
    const max = Math.max(1, Math.min(maxFrames, 10));
    if (!frames.length && to > from) {
      const visual = await this.ensureVisual(manifest);
      const dir = resolve(this.cacheRoot, videoId, "frames", "context");
      mkdirSync(dir, { recursive: true });
      const times = Array.from({ length: Math.min(max, 4) }, (_, index) => from + ((index + 1) / (Math.min(max, 4) + 1)) * (to - from));
      frames = [];
      await this.withConcurrency(times, 3, async (at, index) => {
        const id = `context-${Math.round(at * 1000)}-${index}`;
        const path = resolve(dir, id + ".jpg");
        if (!existsSync(path)) await this.extractFrameAt(visual, at, path);
        frames.push({ id, at: formatSeconds(at), path, source: "ondemand" });
      });
      frames.sort((a, b) => a.at - b.at);
    }
    const selected = chooseRepresentative(frames, max);
    return {
      videoId,
      title: manifest.title,
      start: formatSeconds(from),
      end: formatSeconds(to),
      transcript: transcript.slice(0, 300),
      transcriptTruncated: transcript.length > 300,
      images: selected.map((frame) => this.imagePayload(frame.path, frame.at, frame.id)),
    };
  }
}

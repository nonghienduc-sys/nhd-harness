import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { existsSync, lstatSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, resolve } from "node:path";
import { AppConfig } from "./config.js";

const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const MAX_RETURN_BYTES = 12 * 1024 * 1024;
const SUPPORTED_MIME = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

export type ImageMemoryMetadata = {
  caption?: string;
  ocrText?: string;
  tags?: string[];
  taskId?: string;
  chatId?: string;
  source?: string;
};

export type StoredImageMemory = {
  id: string;
  root: string;
  sha256: string;
  mimeType: string;
  bytes: number;
  width: number | null;
  height: number | null;
  storagePath: string;
  sourcePath: string | null;
  sourceKind: "file" | "screen" | "memory";
  originalName: string | null;
  caption: string;
  ocrText: string;
  tags: string[];
  taskId: string | null;
  chatId: string | null;
  source: string;
  createdAt: string;
  updatedAt: string;
};

type AssetInfo = {
  sha256: string;
  mimeType: string;
  extension: string;
  bytes: number;
  width: number | null;
  height: number | null;
  buffer: Buffer;
};

type ImageRow = {
  id: string;
  root: string;
  sha256: string;
  source_path: string | null;
  source_kind: string;
  original_name: string | null;
  caption: string;
  ocr_text: string;
  tags_json: string;
  task_id: string | null;
  chat_id: string | null;
  source: string;
  created_at: string;
  updated_at: string;
  storage_path: string;
  mime_type: string;
  bytes: number;
  width: number | null;
  height: number | null;
};

function sha256Buffer(buffer: Buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function boundedText(value: unknown, max: number) {
  const text = String(value ?? "").trim();
  if (text.length > max) throw new Error(`Image-memory metadata exceeds ${max} characters.`);
  return text;
}

function normalizeTags(tags: unknown): string[] {
  if (!Array.isArray(tags)) return [];
  const output: string[] = [];
  for (const value of tags.slice(0, 32)) {
    const tag = boundedText(value, 120);
    if (tag && !output.some((item) => item.toLowerCase() === tag.toLowerCase())) output.push(tag);
  }
  return output;
}

function normalizeMetadata(input: ImageMemoryMetadata = {}) {
  return {
    caption: boundedText(input.caption, 4_000),
    ocrText: boundedText(input.ocrText, 16_000),
    tags: normalizeTags(input.tags),
    taskId: boundedText(input.taskId, 300) || null,
    chatId: boundedText(input.chatId, 500) || null,
    source: boundedText(input.source, 300) || "context_image_memory",
  };
}

function detectImage(buffer: Buffer): { mimeType: string; extension: string; width: number | null; height: number | null } {
  if (buffer.length >= 24 && buffer.subarray(0, 8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]))) {
    return { mimeType: "image/png", extension: ".png", width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  if (buffer.length >= 10 && (buffer.subarray(0, 6).toString("ascii") === "GIF87a" || buffer.subarray(0, 6).toString("ascii") === "GIF89a")) {
    return { mimeType: "image/gif", extension: ".gif", width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
  }
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP") {
    let width: number | null = null;
    let height: number | null = null;
    const chunk = buffer.subarray(12, 16).toString("ascii");
    if (chunk === "VP8X" && buffer.length >= 30) {
      width = 1 + buffer[24] + (buffer[25] << 8) + (buffer[26] << 16);
      height = 1 + buffer[27] + (buffer[28] << 8) + (buffer[29] << 16);
    } else if (chunk === "VP8 " && buffer.length >= 30 && buffer[23] === 0x9d && buffer[24] === 0x01 && buffer[25] === 0x2a) {
      width = buffer.readUInt16LE(26) & 0x3fff;
      height = buffer.readUInt16LE(28) & 0x3fff;
    } else if (chunk === "VP8L" && buffer.length >= 25 && buffer[20] === 0x2f) {
      width = 1 + buffer[21] + ((buffer[22] & 0x3f) << 8);
      height = 1 + (buffer[22] >> 6) + (buffer[23] << 2) + ((buffer[24] & 0x0f) << 10);
    }
    return { mimeType: "image/webp", extension: ".webp", width, height };
  }
  if (buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    let offset = 2;
    while (offset + 9 < buffer.length) {
      if (buffer[offset] !== 0xff) { offset += 1; continue; }
      const marker = buffer[offset + 1];
      if (marker === 0xd8 || marker === 0xd9) { offset += 2; continue; }
      if (offset + 4 > buffer.length) break;
      const length = buffer.readUInt16BE(offset + 2);
      if (length < 2 || offset + 2 + length > buffer.length) break;
      if ([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker) && length >= 7) {
        return { mimeType: "image/jpeg", extension: ".jpg", width: buffer.readUInt16BE(offset + 7), height: buffer.readUInt16BE(offset + 5) };
      }
      offset += 2 + length;
    }
    return { mimeType: "image/jpeg", extension: ".jpg", width: null, height: null };
  }
  throw new Error("Unsupported image format. Supported formats: PNG, JPEG, GIF and WebP.");
}

function normalizeRecall(value: unknown) {
  return String(value ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

function scoreRecall(query: string, text: string) {
  const q = normalizeRecall(query).trim();
  const hay = normalizeRecall(text);
  if (!q || !hay) return 0;
  const tokens = [...new Set(q.split(/[^a-z0-9_:.\\/-]+/).filter((token) => token.length >= 2))];
  let score = hay.includes(q) ? 12 : 0;
  for (const token of tokens) if (hay.includes(token)) score += token.length >= 6 ? 3 : 2;
  return score;
}

export class ImageMemoryService {
  readonly dbPath: string;
  readonly mediaRoot: string;
  private readonly db: DatabaseSync;
  private readonly now: () => number;

  constructor(readonly config: Pick<AppConfig, "dataDir">, options: { now?: () => number } = {}) {
    mkdirSync(config.dataDir, { recursive: true });
    this.dbPath = resolve(config.dataDir, "workspace-memory.sqlite");
    this.mediaRoot = resolve(config.dataDir, "workspace-media", "assets");
    mkdirSync(this.mediaRoot, { recursive: true });
    this.db = new DatabaseSync(this.dbPath);
    this.now = options.now ?? Date.now;
    this.initSchema();
  }

  stats(root?: string) {
    const where = root ? "WHERE i.root=?" : "";
    const params = root ? [root] : [];
    const images = Number((this.db.prepare(`SELECT COUNT(*) AS count FROM workspace_images i ${where}`).get(...params) as { count: number }).count);
    const aggregate = this.db.prepare(`SELECT COALESCE(SUM(a.bytes),0) AS bytes FROM workspace_images i JOIN workspace_image_assets a ON a.sha256=i.sha256 ${where}`).get(...params) as { bytes: number };
    const assets = Number((this.db.prepare("SELECT COUNT(*) AS count FROM workspace_image_assets").get() as { count: number }).count);
    return { images, assets, bytes: Number(aggregate.bytes ?? 0), mediaRoot: this.mediaRoot };
  }

  inspectFile(path: string) {
    const target = resolve(path);
    if (!existsSync(target)) throw new Error("Image file was not found.");
    const lstat = lstatSync(target);
    if (lstat.isSymbolicLink()) throw new Error("Image-memory source cannot be a symbolic link.");
    const stat = statSync(target);
    if (!stat.isFile()) throw new Error("Image-memory source is not a regular file.");
    if (stat.size <= 0 || stat.size > MAX_IMAGE_BYTES) throw new Error(`Image must be between 1 byte and ${MAX_IMAGE_BYTES} bytes.`);
    const buffer = readFileSync(target);
    const detected = detectImage(buffer);
    return {
      path: target,
      originalName: basename(target),
      sha256: sha256Buffer(buffer),
      mimeType: detected.mimeType,
      bytes: buffer.length,
      width: detected.width,
      height: detected.height,
      extension: detected.extension,
    };
  }

  storeFile(root: string, path: string, metadata: ImageMemoryMetadata = {}, expectedSha256?: string | null) {
    const target = resolve(path);
    const buffer = readFileSync(target);
    const asset = this.assetInfo(buffer);
    if (expectedSha256 && asset.sha256 !== expectedSha256) throw new Error("Image changed after preview; preview it again before storing.");
    return this.persist(root, asset, {
      sourcePath: target,
      sourceKind: "file",
      originalName: basename(target),
      metadata,
    });
  }

  storeBuffer(root: string, input: { data: string; mimeType?: string; width?: number | null; height?: number | null; sourcePath?: string | null; sourceKind?: "screen" | "memory"; originalName?: string | null }, metadata: ImageMemoryMetadata = {}) {
    const buffer = Buffer.from(String(input.data ?? ""), "base64");
    if (!buffer.length || buffer.length > MAX_IMAGE_BYTES) throw new Error(`Image must be between 1 byte and ${MAX_IMAGE_BYTES} bytes.`);
    const asset = this.assetInfo(buffer);
    if (input.mimeType && input.mimeType !== asset.mimeType) throw new Error("Image MIME type does not match its binary content.");
    if (!SUPPORTED_MIME.has(asset.mimeType)) throw new Error("Unsupported image MIME type.");
    if (asset.width == null && Number.isFinite(input.width)) asset.width = Math.max(1, Math.trunc(Number(input.width)));
    if (asset.height == null && Number.isFinite(input.height)) asset.height = Math.max(1, Math.trunc(Number(input.height)));
    return this.persist(root, asset, {
      sourcePath: input.sourcePath ?? null,
      sourceKind: input.sourceKind ?? "memory",
      originalName: input.originalName ?? null,
      metadata,
    });
  }

  list(root: string, limit = 20): StoredImageMemory[] {
    const bounded = Math.max(1, Math.min(Math.floor(limit), 100));
    const rows = this.db.prepare(`SELECT i.*,a.storage_path,a.mime_type,a.bytes,a.width,a.height
      FROM workspace_images i JOIN workspace_image_assets a ON a.sha256=i.sha256
      WHERE i.root=? ORDER BY i.updated_at DESC LIMIT ?`).all(root, bounded) as ImageRow[];
    return rows.map((row) => this.publicRow(row));
  }

  search(root: string, query: string, limit = 12) {
    const q = boundedText(query, 2_000);
    if (!q) throw new Error("Image-memory search query is required.");
    const candidates = this.list(root, 250)
      .map((item) => {
        const text = [item.caption, item.ocrText, item.tags.join(" "), item.originalName ?? "", item.sourcePath ?? "", item.taskId ?? "", item.chatId ?? "", item.source].join(" ");
        return { ...item, score: scoreRecall(q, text) };
      })
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score || Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
    const bounded = Math.max(1, Math.min(Math.floor(limit), 30));
    return { root, query: q, count: Math.min(candidates.length, bounded), results: candidates.slice(0, bounded) };
  }

  read(root: string, id: string) {
    const row = this.row(root, id);
    if (!row) throw new Error("Image-memory item was not found in this project.");
    if (!existsSync(row.storage_path)) throw new Error("Image-memory asset is missing from local storage.");
    const stat = statSync(row.storage_path);
    if (stat.size > MAX_RETURN_BYTES) throw new Error("Stored image is too large to return through MCP.");
    const data = readFileSync(row.storage_path).toString("base64");
    const item = this.publicRow(row);
    return { ...item, image: { data, mimeType: item.mimeType, width: item.width, height: item.height } };
  }

  close() {
    this.db.close();
  }

  private assetInfo(buffer: Buffer): AssetInfo {
    if (!buffer.length || buffer.length > MAX_IMAGE_BYTES) throw new Error(`Image must be between 1 byte and ${MAX_IMAGE_BYTES} bytes.`);
    const detected = detectImage(buffer);
    if (!SUPPORTED_MIME.has(detected.mimeType)) throw new Error("Unsupported image MIME type.");
    return { sha256: sha256Buffer(buffer), ...detected, bytes: buffer.length, buffer };
  }

  private persist(rootInput: string, asset: AssetInfo, input: { sourcePath: string | null; sourceKind: "file" | "screen" | "memory"; originalName: string | null; metadata: ImageMemoryMetadata }) {
    const root = boundedText(rootInput, 5_000);
    if (!root) throw new Error("Project root is required for image memory.");
    const metadata = normalizeMetadata(input.metadata);
    const directory = resolve(this.mediaRoot, asset.sha256.slice(0, 2));
    const storagePath = resolve(directory, `${asset.sha256}${asset.extension}`);
    mkdirSync(directory, { recursive: true });
    if (!existsSync(storagePath)) writeFileSync(storagePath, asset.buffer, { flag: "wx" });

    const now = new Date(this.now()).toISOString();
    const identity = [root, asset.sha256, input.sourceKind, input.sourcePath ?? "", metadata.taskId ?? "", metadata.chatId ?? "", metadata.caption].join("\u0000");
    const id = `img-${createHash("sha256").update(identity).digest("hex").slice(0, 24)}`;

    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare(`INSERT INTO workspace_image_assets(sha256,storage_path,mime_type,extension,bytes,width,height,created_at)
        VALUES(?,?,?,?,?,?,?,?)
        ON CONFLICT(sha256) DO UPDATE SET storage_path=excluded.storage_path,mime_type=excluded.mime_type,extension=excluded.extension,bytes=excluded.bytes,width=COALESCE(workspace_image_assets.width,excluded.width),height=COALESCE(workspace_image_assets.height,excluded.height)`)
        .run(asset.sha256, storagePath, asset.mimeType, asset.extension, asset.bytes, asset.width, asset.height, now);
      const existing = this.db.prepare("SELECT created_at FROM workspace_images WHERE id=?").get(id) as { created_at: string } | undefined;
      this.db.prepare(`INSERT INTO workspace_images(id,root,sha256,source_path,source_kind,original_name,caption,ocr_text,tags_json,task_id,chat_id,source,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET caption=excluded.caption,ocr_text=excluded.ocr_text,tags_json=excluded.tags_json,task_id=excluded.task_id,chat_id=excluded.chat_id,source=excluded.source,updated_at=excluded.updated_at`)
        .run(id, root, asset.sha256, input.sourcePath, input.sourceKind, input.originalName, metadata.caption, metadata.ocrText, JSON.stringify(metadata.tags), metadata.taskId, metadata.chatId, metadata.source, existing?.created_at ?? now, now);
      this.db.exec("COMMIT");
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch {}
      throw error;
    }
    return this.publicRow(this.row(root, id)!);
  }

  private row(root: string, id: string): ImageRow | null {
    return (this.db.prepare(`SELECT i.*,a.storage_path,a.mime_type,a.bytes,a.width,a.height
      FROM workspace_images i JOIN workspace_image_assets a ON a.sha256=i.sha256
      WHERE i.root=? AND i.id=? LIMIT 1`).get(root, id) as ImageRow | undefined) ?? null;
  }

  private publicRow(row: ImageRow): StoredImageMemory {
    let tags: string[] = [];
    try { const parsed = JSON.parse(row.tags_json || "[]"); if (Array.isArray(parsed)) tags = parsed.map(String).slice(0, 32); } catch {}
    return {
      id: row.id,
      root: row.root,
      sha256: row.sha256,
      mimeType: row.mime_type,
      bytes: Number(row.bytes),
      width: row.width == null ? null : Number(row.width),
      height: row.height == null ? null : Number(row.height),
      storagePath: row.storage_path,
      sourcePath: row.source_path,
      sourceKind: row.source_kind as StoredImageMemory["sourceKind"],
      originalName: row.original_name,
      caption: row.caption,
      ocrText: row.ocr_text,
      tags,
      taskId: row.task_id,
      chatId: row.chat_id,
      source: row.source,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private initSchema() {
    this.db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS workspace_image_assets(
        sha256 TEXT PRIMARY KEY,
        storage_path TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        extension TEXT NOT NULL,
        bytes INTEGER NOT NULL,
        width INTEGER,
        height INTEGER,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS workspace_images(
        id TEXT PRIMARY KEY,
        root TEXT NOT NULL,
        sha256 TEXT NOT NULL,
        source_path TEXT,
        source_kind TEXT NOT NULL,
        original_name TEXT,
        caption TEXT NOT NULL,
        ocr_text TEXT NOT NULL,
        tags_json TEXT NOT NULL,
        task_id TEXT,
        chat_id TEXT,
        source TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_workspace_images_root_updated ON workspace_images(root,updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_workspace_images_sha ON workspace_images(sha256);
      CREATE INDEX IF NOT EXISTS idx_workspace_images_task ON workspace_images(root,task_id);
      CREATE INDEX IF NOT EXISTS idx_workspace_images_chat ON workspace_images(root,chat_id);
    `);
  }
}

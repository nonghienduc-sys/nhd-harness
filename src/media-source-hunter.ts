/**
 * NHD Media Source Hunter — official, metadata-only discovery.
 *
 * Trust boundary: this module NEVER downloads media or approves usage rights.
 * Requests go to fixed official API hosts; no arbitrary URLs or scraped HTML.
 * Credentials can only come from the launcher's environment; never returned.
 */
import { createHash } from "node:crypto";

export const MEDIA_PROVIDERS = ["youtube", "google", "commons", "openverse", "pexels", "pixabay"] as const;
export type MediaProvider = typeof MEDIA_PROVIDERS[number];
export type MediaKind = "video" | "image";
export type MediaOrientation = "any" | "portrait" | "landscape" | "square";

export type MediaAsset = {
  asset_id: string;
  provider: MediaProvider;
  external_id: string;
  title: string;
  kind: "video" | "image" | "reference";
  source_url: string;
  media_url: string | null;
  preview_url: string | null;
  author: string | null;
  license: string | null;
  rights_status: "reference_only" | "license_review";
  width: number | null;
  height: number | null;
  duration_seconds: number | null;
};

export type DiscoveryOptions = {
  query: string;
  kind: MediaKind;
  providers: MediaProvider[];
  orientation: MediaOrientation;
  limit: number;
};

type ApiFetch = typeof fetch;
type JsonObject = Record<string, any>;

const MAX_API_BODY = 1_500_000;
const REQUEST_TIMEOUT_MS = 12_000;
const MAX_QUERY_LENGTH = 180;

function text(value: unknown, max = 300): string {
  return String(value ?? "").replace(/[\u0000-\u001f]/g, " ").slice(0, max);
}
function numberOrNull(value: unknown): number | null {
  return Number.isFinite(Number(value)) && value != null ? Number(value) : null;
}
function asset(
  provider: MediaProvider,
  id: unknown,
  title: unknown,
  sourceUrl: unknown,
  kind: MediaAsset["kind"],
  data: Partial<MediaAsset> = {},
): MediaAsset {
  const external_id = text(id, 250);
  return {
    asset_id: createHash("sha256").update(provider + ":" + external_id).digest("hex").slice(0, 16),
    provider, external_id, title: text(title, 320),
    source_url: text(sourceUrl, 1500),
    kind,
    media_url: data.media_url ?? null,
    preview_url: data.preview_url ?? null,
    author: data.author ?? null,
    license: data.license ?? null,
    rights_status: provider === "google" || provider === "youtube" ? "reference_only" : "license_review",
    width: data.width ?? null, height: data.height ?? null,
    duration_seconds: data.duration_seconds ?? null,
  };
}
function safeMediaUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try { const url = new URL(value); return url.protocol === "https:" ? url.href : null; }
  catch { return null; }
}
function cleanHtml(value: unknown): string {
  return text(value, 600).replace(/<[^>]*>/g, " ").replace(/&amp;/g, "&").trim();
}
async function fetchJson(url: URL, headers: Record<string, string>, fetcher: ApiFetch): Promise<JsonObject> {
  // Strict allowlist prevents tools and query results from turning discovery into an SSRF proxy.
  if (url.protocol !== "https:" || ![
    "www.googleapis.com", "api.pexels.com", "pixabay.com",
    "commons.wikimedia.org", "api.openverse.org",
  ].includes(url.hostname)) throw new Error("API_HOST_NOT_ALLOWED");
  const response = await fetcher(url.href, {
    headers: { "Accept": "application/json", "User-Agent": "NHD-Media-Source-Hunter/1.0", ...headers },
    redirect: "error",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error("API_HTTP_" + response.status);
  const declared = Number(response.headers.get("content-length") || 0);
  if (declared > MAX_API_BODY) throw new Error("API_RESPONSE_TOO_LARGE");
  const body = response.body;
  if (!body) throw new Error("API_EMPTY_BODY");
  const reader = body.getReader();
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_API_BODY) throw new Error("API_RESPONSE_TOO_LARGE");
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = Buffer.concat(chunks.map(chunk => Buffer.from(chunk)), size);
  const parsed = JSON.parse(bytes.toString("utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("API_INVALID_RESPONSE");
  return parsed;
}
function url(host: string, path: string, params: Record<string, string | number>): URL {
  const u = new URL("https://" + host + path);
  for (const [key, value] of Object.entries(params)) u.searchParams.set(key, String(value));
  return u;
}
async function queryProvider(
  provider: MediaProvider, query: string, kind: MediaKind, orientation: MediaOrientation,
  limit: number, fetcher: ApiFetch, env: NodeJS.ProcessEnv,
): Promise<{ assets: MediaAsset[]; note?: string }> {
  if (provider === "google") {
    const u = url("www.google.com", "/search", { q: query, tbm: kind === "image" ? "isch" : "vid" });
    return { assets: [asset("google", query, "Google discovery: " + query, u.href, "reference")],
      note: "Search-link only; Google results are never automatically imported or licensed." };
  }
  if (provider === "youtube") {
    const key = env.YOUTUBE_API_KEY;
    if (!key) return { assets: [], note: "YOUTUBE_API_KEY_NOT_CONFIGURED" };
    const j = await fetchJson(url("www.googleapis.com", "/youtube/v3/search", {
      key, part: "snippet", type: "video", q: query, maxResults: limit, safeSearch: "moderate",
    }), {}, fetcher);
    return { assets: (j.items ?? []).flatMap((v: any) => {
      const id = v?.id?.videoId;
      if (typeof id !== "string" || !/^[\w-]{11}$/.test(id)) return [];
      return [asset(provider, id, v?.snippet?.title, "https://www.youtube.com/watch?v=" + id, "reference", {
        author: text(v?.snippet?.channelTitle), preview_url: safeMediaUrl(v?.snippet?.thumbnails?.medium?.url),
        license: "unverified; discovery only",
      })];
    }).slice(0, limit) };
  }
  if (provider === "pexels") {
    const key = env.PEXELS_API_KEY;
    if (!key) return { assets: [], note: "PEXELS_API_KEY_NOT_CONFIGURED" };
    const path = kind === "video" ? "/videos/search" : "/v1/search";
    const params: Record<string, string | number> = { query, per_page: limit };
    if (orientation !== "any") params.orientation = orientation;
    const j = await fetchJson(url("api.pexels.com", path, params), { Authorization: key }, fetcher);
    const items = kind === "video" ? j.videos : j.photos;
    return { assets: (Array.isArray(items) ? items : []).slice(0, limit).map((v: any) => {
      const files = Array.isArray(v.video_files) ? v.video_files.filter((f: any) => f.file_type === "video/mp4") : [];
      files.sort((a: any, b: any) => Math.abs(Number(a.width || 0) - 1080) - Math.abs(Number(b.width || 0) - 1080));
      const media = kind === "video" ? files[0]?.link : (v.src?.large2x || v.src?.large);
      return asset(provider, v.id, v.alt || query, v.url, kind, {
        media_url: safeMediaUrl(media), preview_url: safeMediaUrl(kind === "video" ? v.image : v.src?.medium),
        author: text(kind === "video" ? v.user?.name : v.photographer),
        license: "Pexels License", width: numberOrNull(kind === "video" ? files[0]?.width : v.width),
        height: numberOrNull(kind === "video" ? files[0]?.height : v.height),
        duration_seconds: numberOrNull(v.duration),
      });
    }) };
  }
  if (provider === "pixabay") {
    const key = env.PIXABAY_API_KEY;
    if (!key) return { assets: [], note: "PIXABAY_API_KEY_NOT_CONFIGURED" };
    const path = kind === "video" ? "/api/videos/" : "/api/";
    const j = await fetchJson(url("pixabay.com", path, { key, q: query.slice(0, 100), per_page: Math.max(3, limit), safesearch: "true" }), {}, fetcher);
    return { assets: (Array.isArray(j.hits) ? j.hits : []).slice(0, limit).map((v: any) => {
      const file = v.videos?.medium || v.videos?.small || v.videos?.large || {};
      return asset(provider, v.id, v.tags || query, v.pageURL, kind, {
        media_url: safeMediaUrl(kind === "video" ? file.url : (v.largeImageURL || v.webformatURL)),
        preview_url: safeMediaUrl(v.previewURL), author: text(v.user),
        license: "Pixabay Content License",
        width: numberOrNull(kind === "video" ? file.width : v.imageWidth),
        height: numberOrNull(kind === "video" ? file.height : v.imageHeight),
        duration_seconds: numberOrNull(v.duration),
      });
    }) };
  }
  if (provider === "openverse") {
    if (kind === "video") return { assets: [], note: "Openverse provides images/audio metadata, not video footage." };
    const j = await fetchJson(url("api.openverse.org", "/v1/images/", { q: query, page_size: limit }), {}, fetcher);
    return { assets: (Array.isArray(j.results) ? j.results : []).slice(0, limit).map((v: any) =>
      asset(provider, v.id, v.title || query, v.foreign_landing_url || v.detail_url || "", "image", {
        media_url: safeMediaUrl(v.url), preview_url: safeMediaUrl(v.thumbnail), author: text(v.creator),
        license: text([String(v.license || "").toUpperCase(), v.license_version || ""].filter(Boolean).join(" "), 100),
        width: numberOrNull(v.width), height: numberOrNull(v.height),
      })) };
  }
  const j = await fetchJson(url("commons.wikimedia.org", "/w/api.php", {
    action: "query", format: "json", generator: "search", gsrsearch: query,
    gsrnamespace: 6, gsrlimit: Math.min(limit * 3, 30), prop: "imageinfo",
    iiprop: "url|mime|size|extmetadata",
  }), {}, fetcher);
  const pages: any[] = Object.values(j.query?.pages ?? {});
  return { assets: pages.flatMap(v => {
    const info = v.imageinfo?.[0] || {};
    if (kind === "image" && !String(info.mime || "").startsWith("image/")) return [];
    if (kind === "video" && !String(info.mime || "").startsWith("video/")) return [];
    return [asset(provider, v.pageid, v.title, info.descriptionurl, kind, {
      media_url: safeMediaUrl(info.url), preview_url: safeMediaUrl(info.thumburl),
      author: cleanHtml(info.extmetadata?.Artist?.value),
      license: cleanHtml(info.extmetadata?.LicenseShortName?.value),
      width: numberOrNull(info.width), height: numberOrNull(info.height),
    })];
  }).slice(0, limit) };
}

export function mediaSourceStatus(env: NodeJS.ProcessEnv = process.env) {
  return {
    status: "available",
    version: 1,
    officialApis: {
      youtube: Boolean(env.YOUTUBE_API_KEY), pexels: Boolean(env.PEXELS_API_KEY),
      pixabay: Boolean(env.PIXABAY_API_KEY), commons: true, openverse: true,
      google: "search_link_only",
    },
    policy: "Read-only metadata discovery. YouTube/Google reference-only; no download, publishing or rights approval.",
  };
}
export async function discoverMediaSources(
  options: DiscoveryOptions,
  deps: { fetcher?: ApiFetch; env?: NodeJS.ProcessEnv } = {},
) {
  const query = options.query?.trim();
  if (!query || query.length > MAX_QUERY_LENGTH) throw new Error("QUERY_LENGTH_INVALID");
  if (!["image", "video"].includes(options.kind)) throw new Error("KIND_INVALID");
  if (!["any", "portrait", "landscape", "square"].includes(options.orientation)) throw new Error("ORIENTATION_INVALID");
  if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 10) throw new Error("LIMIT_INVALID");
  if (!Array.isArray(options.providers) || options.providers.length < 1 || options.providers.length > 6 ||
      options.providers.some(p => !MEDIA_PROVIDERS.includes(p))) throw new Error("PROVIDERS_INVALID");
  const assets: MediaAsset[] = [];
  const notes: Partial<Record<MediaProvider, string>> = {};
  for (const provider of [...new Set(options.providers)]) {
    try {
      const result = await queryProvider(provider, query, options.kind, options.orientation,
        options.limit, deps.fetcher ?? fetch, deps.env ?? process.env);
      assets.push(...result.assets);
      if (result.note) notes[provider] = result.note;
    } catch (e) {
      // Do not expose request URL: for YouTube/Pixabay it includes the API key.
      const code = e instanceof Error && /^API_(?:HTTP_\d+|HOST_NOT_ALLOWED|RESPONSE_TOO_LARGE|EMPTY_BODY|INVALID_RESPONSE)$/.test(e.message)
        ? e.message : "PROVIDER_QUERY_FAILED";
      notes[provider] = code;
    }
  }
  return {
    schema_version: 1, query, kind: options.kind, orientation: options.orientation,
    providers: [...new Set(options.providers)],
    discovered_at: new Date().toISOString(),
    assets: [...new Map(assets.map(v => [v.asset_id, v])).values()],
    notes,
    rights_policy: "Metadata is not license approval. YouTube and Google are reference_only. Confirm terms and attribution for every other item.",
  };
}

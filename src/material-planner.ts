/**
 * NHD Material Planner v1
 *
 * Scene/storyboard -> metadata discovery -> explainable, ranked media candidate plan.
 * No downloads, no rights approval, no mutable filesystem writes, no model inference.
 * Human rights review and source-file provenance must precede any editor import.
 */
import { createHash } from "node:crypto";
import { discoverMediaSources, type MediaAsset, type MediaKind, type MediaOrientation, type MediaProvider } from "./media-source-hunter.js";

export const MATERIAL_STRATEGIES = ["stock", "mixed", "graphics"] as const;
export type MaterialStrategy = typeof MATERIAL_STRATEGIES[number];
export type MaterialScene = {
  id: string;
  visual: string;
  query: string;
  durationSeconds: number;
  startSeconds: number;
  strategy: MaterialStrategy;
  purpose?: string;
};
export type MaterialPlanRequest = {
  title: string;
  scenes: MaterialScene[];
  orientation: MediaOrientation;
  providers: MediaProvider[];
  candidatesPerScene: number;
  enableImageFallback: boolean;
};
export type MaterialDiscovery = typeof discoverMediaSources;
export type CandidateDecision = {
  asset: MediaAsset;
  score: number;
  reasons: string[];
  rights: {
    status: "reference_only" | "manual_review_required";
    restrictions: string[];
    suggestedAttribution: string | null;
    reviewChecklist: string[];
    mayImportToTimeline: false;
  };
  relevance: "high" | "medium" | "low";
};
export type SceneSelection = {
  id: string;
  startSeconds: number;
  endSeconds: number;
  visual: string;
  purpose: string | null;
  query: string;
  strategy: MaterialStrategy;
  candidates: CandidateDecision[];
  recommendedAssetId: string | null;
  sourceQueries: Array<{ kind: MediaKind; providers: MediaProvider[]; count: number; notes: Record<string, string> }>;
  recommendation: string;
  importGate: "blocked_pending_rights" | "graphics_only";
};
function compact(value: unknown, max = 240): string {
  return String(value ?? "").replace(/[\u0000-\u001f]/g, " ").slice(0, max).trim();
}
const STOP = new Set([
  "the","and","from","with","into","for","this","that","here","there","is","are","it","an","a","in",
  "video","photo","footage","image","scene","stock","film","picture","of","to","on",
  "va","là","là","và","một","của","cho","người","được","trong","để","từ","với","những","các","trên",
]);
function terms(value: string): string[] {
  return [...new Set(compact(value, 1600).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, " ").split(/\s+/).filter(x => x.length >= 3 && !STOP.has(x)))].slice(0, 24);
}
function clipTokenOverlap(search: string, asset: MediaAsset): number {
  const keys = terms(search);
  if (!keys.length) return 0;
  const candidate = terms(asset.title + " " + (asset.author ?? ""));
  return keys.filter(key => candidate.some(word => key === word || (key.length >= 6 && (word.startsWith(key) || key.startsWith(word))))).length / keys.length;
}
function aspectMatch(asset: MediaAsset, orientation: MediaOrientation): "match" | "mismatch" | "unknown" {
  if (orientation === "any") return "match";
  if (!asset.width || !asset.height) return "unknown";
  const ratio = asset.width / asset.height;
  return orientation === "portrait" ? (ratio < 0.86 ? "match" : "mismatch") :
    orientation === "landscape" ? (ratio > 1.17 ? "match" : "mismatch") :
      (ratio >= 0.86 && ratio <= 1.17 ? "match" : "mismatch");
}
function rightsReview(asset: MediaAsset): CandidateDecision["rights"] {
  if (asset.provider === "youtube" || asset.provider === "google") {
    return {
      status: "reference_only",
      restrictions: ["Metadata/link reference only. No rights to download, edit, or repost granted by discovery."],
      suggestedAttribution: null,
      reviewChecklist: ["Locate an authorized original or explicit permission from the rightsholder."],
      mayImportToTimeline: false,
    };
  }
  const license = compact(asset.license ?? "", 150);
  const l = license.toLowerCase();
  const restrictions: string[] = [];
  const checklist = [
    "Open the original landing page and verify exact license, author, and applicable version.",
    "Confirm commercial use, edit/derivative rights, trademarks, identifiable people and model/property releases.",
    "Keep source URL, asset ID, license, author and a dated evidence receipt with the project.",
  ];
  if (!license || /unknown|not verified|all rights reserved/.test(l)) {
    restrictions.push("License not established; cannot import until rights verified.");
  } else if (/\bsa\b|share.?alike/.test(l)) {
    restrictions.push("ShareAlike conditions may apply to adaptations; review distribution obligations.");
    checklist.push("Review ShareAlike version and whether the edited video becomes an adaptation.");
  } else if (/\bby\b|attribution/.test(l)) {
    restrictions.push("Attribution is generally required; validate exact credit terms.");
    checklist.push("Credit author/title/source/license and link where required.");
  } else if (/pexels|pixabay/.test(l)) {
    restrictions.push("Platform stock terms apply; do not redistribute unmodified stock or imply endorsements.");
    checklist.push("Review provider's current license restrictions, identity and branded-content limits.");
  } else if (/cc0|public domain|pdm/.test(l)) {
    restrictions.push("Confirm public-domain/CC0 status and other non-copyright rights.");
  } else {
    restrictions.push("License requires manual legal/usage review.");
  }
  const credit = asset.author && asset.source_url
    ? compact(asset.title) + " — " + compact(asset.author) + " | " + asset.source_url + " | " + license
    : null;
  return { status: "manual_review_required", restrictions, suggestedAttribution: credit,
    reviewChecklist: checklist, mayImportToTimeline: false };
}
function rank(asset: MediaAsset, scene: MaterialScene, orientation: MediaOrientation, alreadyFeatured: Set<string>): CandidateDecision {
  const reasons: string[] = [];
  const match = clipTokenOverlap(scene.query, asset);
  let score = Math.round(match * 56);
  reasons.push("Keyword overlap: " + Math.round(match * 100) + "%");
  if (asset.kind === "video") { score += 12; reasons.push("Video footage"); }
  else if (asset.kind === "image") { score += 4; reasons.push("Still image, requires motion/crop"); }
  const aspect = aspectMatch(asset, orientation);
  if (aspect === "match") { score += 14; reasons.push("Orientation compatible"); }
  else if (aspect === "mismatch") { score -= 13; reasons.push("Orientation mismatch; crop/recompose required"); }
  else reasons.push("Dimensions unknown; inspect before import");
  const width = asset.width ?? 0, height = asset.height ?? 0;
  if (Math.max(width, height) >= 1600) { score += 8; reasons.push("High resolution"); }
  if (asset.rights_status === "reference_only") { score -= 30; reasons.push("Reference only, not reusable"); }
  else if (asset.license) { score += 8; reasons.push("License metadata present; verification pending"); }
  if (alreadyFeatured.has(asset.asset_id)) { score -= 24; reasons.push("Penalized repeated footage"); }
  score = Math.max(0, Math.min(100, score));
  const rights = rightsReview(asset);
  const relevance: CandidateDecision["relevance"] = match >= 0.50 ? "high" : match >= 0.23 ? "medium" : "low";
  return { asset, score, reasons, rights, relevance };
}
export function validateMaterialPlan(input: MaterialPlanRequest): MaterialPlanRequest {
  if (!input || !Array.isArray(input.scenes) || input.scenes.length < 1 || input.scenes.length > 8)
    throw new Error("SCENE_COUNT_INVALID");
  if (!compact(input.title) || String(input.title).length > 240) throw new Error("TITLE_INVALID");
  if (!["any","portrait","landscape","square"].includes(input.orientation)) throw new Error("ORIENTATION_INVALID");
  if (!Array.isArray(input.providers) || !input.providers.length || input.providers.length > 6 ||
      input.providers.some(p => !["youtube","google","commons","openverse","pexels","pixabay"].includes(p)))
    throw new Error("PROVIDER_LIST_INVALID");
  if (!Number.isInteger(input.candidatesPerScene) || input.candidatesPerScene < 1 || input.candidatesPerScene > 5)
    throw new Error("CANDIDATE_LIMIT_INVALID");
  if (typeof input.enableImageFallback !== "boolean") throw new Error("FALLBACK_FLAG_INVALID");
  const ids = new Set<string>();
  let previousEnd = 0;
  for (const s of input.scenes) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,59}$/.test(s.id) || ids.has(s.id))
      throw new Error("INVALID_OR_DUPLICATE_SCENE_ID");
    ids.add(s.id);
    if (typeof s.visual !== "string" || !s.visual.trim() || s.visual.length > 1500) throw new Error("VISUAL_INVALID");
    if (typeof s.query !== "string" || s.query.length < 3 || s.query.length > 180) throw new Error("SCENE_QUERY_INVALID");
    if (!MATERIAL_STRATEGIES.includes(s.strategy)) throw new Error("SCENE_STRATEGY_INVALID");
    if (!Number.isFinite(s.startSeconds) || !Number.isFinite(s.durationSeconds) ||
        s.startSeconds < 0 || s.durationSeconds <= 0 || s.startSeconds < previousEnd - 0.001 ||
        s.startSeconds + s.durationSeconds > 300.01) throw new Error("TIMELINE_INVALID");
    previousEnd = s.startSeconds + s.durationSeconds;
  }
  return input;
}
export async function planVideoMaterials(
  input: MaterialPlanRequest,
  deps: { discover?: MaterialDiscovery } = {},
) {
  const request = validateMaterialPlan(input);
  const discover = deps.discover ?? discoverMediaSources;
  const selected = new Set<string>();
  const memo = new Map<string, Awaited<ReturnType<MaterialDiscovery>>>();
  const scenes: SceneSelection[] = [];
  for (const s of request.scenes) {
    if (s.strategy === "graphics") {
      scenes.push({
        id: s.id, visual: s.visual, purpose: s.purpose ?? null,
        startSeconds: s.startSeconds, endSeconds: s.startSeconds + s.durationSeconds,
        query: s.query, strategy: s.strategy, candidates: [],
        recommendedAssetId: null, sourceQueries: [], recommendation: "Keep original illustrated motion graphics; no external media required.",
        importGate: "graphics_only",
      });
      continue;
    }
    const sourceQueries: SceneSelection["sourceQueries"] = [];
    const merged: MediaAsset[] = [];
    const providers = [...new Set(request.providers)];
    const query = s.query.trim();
    const searches: Array<{ kind: MediaKind; providers: MediaProvider[] }> = [
      { kind: "video", providers: providers.filter(x => x !== "openverse") }
    ];
    if (request.enableImageFallback)
      searches.push({ kind: "image", providers: providers.filter(x => x !== "youtube") });
    for (const search of searches) {
      if (!search.providers.length) continue;
      const key = JSON.stringify([query, search.kind, search.providers, request.orientation, request.candidatesPerScene]);
      let result = memo.get(key);
      if (!result) {
        result = await discover({
          query, kind: search.kind, providers: search.providers,
          orientation: request.orientation, limit: request.candidatesPerScene,
        });
        memo.set(key, result);
      }
      merged.push(...result.assets);
      sourceQueries.push({ kind: search.kind, providers: search.providers, count: result.assets.length,
        notes: result.notes ?? {} });
      // Avoid a redundant fallback query when usable, relevant stock footage was found.
      if (search.kind === "video" && result.assets.some(asset =>
        asset.kind === "video" && asset.rights_status !== "reference_only" &&
        clipTokenOverlap(query, asset) >= 0.23)) break;
    }
    const unique = [...new Map(merged.map(a => [a.asset_id, a])).values()];
    const candidates = unique.map(a => rank(a, s, request.orientation, selected))
      .sort((a,b) => b.score-a.score || a.asset.asset_id.localeCompare(b.asset.asset_id))
      .slice(0, request.candidatesPerScene);
    const recommended = candidates.find(x => x.asset.rights_status !== "reference_only" &&
      x.relevance !== "low" && x.score >= 30) ?? null;
    if (recommended) selected.add(recommended.asset.asset_id);
    scenes.push({
      id: s.id, visual: s.visual, purpose: s.purpose ?? null,
      startSeconds: s.startSeconds, endSeconds: s.startSeconds + s.durationSeconds,
      query, strategy: s.strategy, candidates,
      recommendedAssetId: recommended?.asset.asset_id ?? null,
      sourceQueries,
      recommendation: recommended ? "Candidate for manual source/rights review; not approved for use." :
        "No sufficiently relevant licensable footage found. Keep original graphics or refine search.",
      importGate: "blocked_pending_rights",
    });
  }
  const count = scenes.reduce((n,s) => n + s.candidates.length, 0);
  const planned = scenes.filter(s => s.recommendedAssetId).length;
  return {
    schema_version: 1, planner: "NHD Material Planner v1",
    title: request.title, orientation: request.orientation, timelineSeconds: Math.max(...scenes.map(s=>s.endSeconds)),
    scenes,
    statistics: {
      totalScenes: scenes.length, graphicsOnly: scenes.filter(s=>s.importGate==="graphics_only").length,
      withReviewCandidates: planned, returnedCandidates: count,
      approvedAssets: 0, importableAssets: 0,
    },
    safety: {
      noMediaDownloaded: true, editorImportAuthorized: false, noAutoLicenseApproval: true,
      note: "All external files require human rights verification, local source, and NHD-authorized import before editing.",
    },
    fingerprint: createHash("sha256").update(JSON.stringify({
      title: request.title, orientation: request.orientation,
      scenes: scenes.map(s => [s.id, s.query, s.candidates.map(c=>c.asset.asset_id)])
    })).digest("hex"),
  };
}
/**
 * Pure rights review checklist. It produces no approval, no access tokens or import paths.
 */
export function prepareMaterialRightsReview(input: {
  asset: MediaAsset; intendedUse: "educational" | "commercial" | "personal";
}) {
  const asset = input.asset;
  if (!asset || !asset.asset_id || !asset.source_url || !["educational","commercial","personal"].includes(input.intendedUse))
    throw new Error("REVIEW_INPUT_INVALID");
  const rights = rightsReview(asset);
  return {
    assetId: asset.asset_id, provider: asset.provider, sourceUrl: asset.source_url,
    author: asset.author, licenseClaim: asset.license,
    intendedUse: input.intendedUse, rights,
    reviewStatus: "pending_human_verification",
    requiredEvidence: ["Source license URL/version at review time","Attribution/copyright holder",
      "Intended-use compatibility and release checks","Local file hash after authorized import"],
    readyForEditorImport: false,
  };
}

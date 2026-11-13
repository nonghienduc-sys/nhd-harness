import { basename, extname } from "node:path";
import { OfficeLiveApplication } from "./office.js";
import { ScreenService, ScreenSource } from "./screen.js";

export type OfficeVisualReviewState = {
  required: true;
  available: boolean;
  status: "awaiting_ai_review" | "unavailable";
  completionGate: "review_screenshot_before_finalizing" | "visual_review_unavailable_do_not_claim_visually_correct";
  source?: ScreenSource;
  reason?: string;
};

export type OfficeVisualReviewCapture = {
  review: OfficeVisualReviewState;
  capture?: {
    source: ScreenSource;
    width: number;
    height: number;
    mimeType: "image/png";
    data: string;
  };
};

function normalize(value: unknown) {
  return String(value ?? "").trim().toLowerCase();
}

function appTokens(application: OfficeLiveApplication) {
  if (application === "word") return ["word", "microsoft word"];
  if (application === "excel") return ["excel", "microsoft excel"];
  return ["powerpoint", "power point", "microsoft powerpoint"];
}

export function scoreOfficeWindow(source: ScreenSource, application: OfficeLiveApplication, officeState: Record<string, unknown>) {
  if (source.kind !== "window") return -1;
  const title = normalize(source.name);
  if (!title) return -1;
  const name = normalize(officeState.name);
  const path = normalize(officeState.path);
  const fileName = name || (path ? normalize(basename(path)) : "");
  const stem = fileName ? normalize(basename(fileName, extname(fileName))) : "";
  let score = 0;
  const exactFileMatch = Boolean(fileName && title.includes(fileName));
  const stemMatch = Boolean(stem && stem.length >= 4 && title.includes(stem));
  // If Office reports an active file identity, never accept a generic same-app window
  // whose title belongs to another document. Visual QA must fail closed rather than
  // attach evidence from the wrong Word/Excel/PowerPoint document.
  if ((fileName || stem) && !exactFileMatch && !stemMatch) return -1;
  if (exactFileMatch) score += 120;
  if (stemMatch) score += 100;
  for (const token of appTokens(application)) if (title.includes(token)) score += 30;
  if (title.includes("compatibility mode")) score += 5;
  return score > 0 ? score : -1;
}

export function pickOfficeWindow(sources: ScreenSource[], application: OfficeLiveApplication, officeState: Record<string, unknown>) {
  return sources
    .map((source) => ({ source, score: scoreOfficeWindow(source, application, officeState) }))
    .filter((item) => item.score >= 0)
    .sort((a, b) => b.score - a.score)[0]?.source ?? null;
}

export async function captureOfficeVisualReview(screen: ScreenService, application: OfficeLiveApplication, officeState: Record<string, unknown>, maxWidth = 1600, maxHeight = 1200): Promise<OfficeVisualReviewCapture> {
  try {
    const sources = (await screen.list()).sources;
    const source = pickOfficeWindow(sources, application, officeState);
    if (!source) {
      return {
        review: {
          required: true,
          available: false,
          status: "unavailable",
          completionGate: "visual_review_unavailable_do_not_claim_visually_correct",
          reason: `No visible ${application} window matched the active Office file.`,
        },
      };
    }
    const capture = await screen.capture(source.id, maxWidth, maxHeight);
    return {
      review: {
        required: true,
        available: true,
        status: "awaiting_ai_review",
        completionGate: "review_screenshot_before_finalizing",
        source: capture.source,
      },
      capture,
    };
  } catch (error) {
    return {
      review: {
        required: true,
        available: false,
        status: "unavailable",
        completionGate: "visual_review_unavailable_do_not_claim_visually_correct",
        reason: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

import { resolve, sep } from "node:path";
import type { ContextEvidence } from "./sbce-context.js";

export function loadContextRefs(
  root: string,
  refs: string[],
  readFile: (absPath: string) => string | null,
): { evidence: ContextEvidence[]; errors: string[] } {
  const evidence: ContextEvidence[] = [];
  const errors: string[] = [];
  const limitedRefs = refs.slice(0, 12);

  if (refs.length > 12) {
    errors.push("SBCE_CONTEXT_REF_LIMIT");
  }

  const rootPath = resolve(root);

  for (const ref of limitedRefs) {
    const match = /^(.+?)(?::(\d+)-(\d+))?$/.exec(ref);

    if (!match) {
      errors.push(`SBCE_CONTEXT_REF_INVALID:${ref}`);
      continue;
    }

    const [, rel, startText, endText] = match;
    const hasRange = startText !== undefined && endText !== undefined;
    const start = hasRange ? Number(startText) : 1;
    const requestedEnd = hasRange ? Number(endText) : Number.MAX_SAFE_INTEGER;
    const segments = rel.split(/[\\/]/);

    if (
      rel.startsWith("/") ||
      rel.startsWith("\\") ||
      /^[A-Za-z]:/.test(rel) ||
      segments.includes("..") ||
      start < 1 ||
      start > requestedEnd
    ) {
      errors.push(`SBCE_CONTEXT_REF_INVALID:${ref}`);
      continue;
    }

    const absPath = resolve(root, rel);
    if (absPath !== rootPath && !absPath.startsWith(rootPath + sep)) {
      errors.push(`SBCE_CONTEXT_REF_INVALID:${ref}`);
      continue;
    }

    const contents = readFile(absPath);
    if (contents === null) {
      errors.push(`SBCE_CONTEXT_REF_MISSING:${ref}`);
      continue;
    }

    const lines = contents.split("\n").map((line) => line.replace(/\r$/, ""));
    if (lines.at(-1) === "") {
      lines.pop();
    }

    const end = hasRange
      ? Math.min(requestedEnd, lines.length)
      : lines.length;
    const source = rel.replace(/\\/g, "/");
    const selected = lines.slice(start - 1, end);

    evidence.push({
      source,
      locator: `${source}:${start}-${end}`,
      snippet: selected.join("\n"),
      label: "public/code",
    });
  }

  return { evidence, errors };
}

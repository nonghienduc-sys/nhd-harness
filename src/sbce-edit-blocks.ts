export function parseEditBlocks(
  text: string,
): { path: string; search: string[]; replace: string[] }[] {
  const lines = text.split("\n").map((line) => line.endsWith("\r") ? line.slice(0, -1) : line);
  const blocks: { path: string; search: string[]; replace: string[] }[] = [];
  let i = 0;
  const fail = (why: string) => { throw new Error(`SBCE_EDIT_BLOCK_SYNTAX: ${why}`); };

  while (i < lines.length) {
    // Tolerate prose, headings and code fences between blocks: only a FILE marker starts a block.
    const path = fileMarker(lines[i]);
    if (path === null) {
      if (isSearchMarker(lines[i])) fail(`line ${i + 1}: '<<<<<<< SEARCH' without a preceding 'FILE: <path>' line`);
      i++;
      continue;
    }
    if (!path) fail(`line ${i + 1}: FILE marker has no path`);
    i++;
    while (i < lines.length && /^\s*```/.test(lines[i])) i++;
    if (i >= lines.length || !isSearchMarker(lines[i])) {
      fail(`line ${i + 1}: expected '<<<<<<< SEARCH' right after 'FILE: ${path}'`);
    }
    i++;

    const search: string[] = [];
    while (i < lines.length && !isDivider(lines[i])) {
      search.push(lines[i++]);
    }
    if (i >= lines.length) fail(`block for ${path}: missing '=======' divider`);
    i++;

    const replace: string[] = [];
    while (i < lines.length && !isReplaceMarker(lines[i])) {
      replace.push(lines[i++]);
    }
    if (i >= lines.length) fail(`block for ${path}: missing '>>>>>>> REPLACE' end marker`);
    i++;
    blocks.push({ path, search, replace });
  }

  if (!blocks.length) fail("no 'FILE: <path>' block found");
  return blocks;
}

/** Returns the path for a FILE marker line ("" if the path is empty), or null if the line is not one. */
function fileMarker(line: string): string | null {
  const m = /^[\s#>*_`-]*FILE\s*:\s*(.*)$/i.exec(line);
  if (!m) return null;
  return m[1].replace(/[*_`]+/g, "").trim();
}
function isSearchMarker(line: string): boolean { return /^\s*<{5,9}\s*SEARCH\s*$/.test(line); }
function isDivider(line: string): boolean { return /^\s*={5,9}\s*$/.test(line); }
function isReplaceMarker(line: string): boolean { return /^\s*>{5,9}\s*REPLACE\s*$/.test(line); }

type Edit = {
  start: number;
  end: number;
  replace: string[];
};

function fileLines(text: string): string[] {
  const lines = text.split("\n").map((line) => line.endsWith("\r") ? line.slice(0, -1) : line);
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
}

function validPath(path: string): boolean {
  return path.length > 0 &&
    !path.startsWith("/") &&
    !/^[A-Za-z]:[\\/]/.test(path) &&
    !path.split(/[\\/]/).includes("..");
}

function occurrences(lines: string[], wanted: string[]): number[] {
  const result: number[] = [];
  if (wanted.length === 0) return result;
  for (let i = 0; i + wanted.length <= lines.length; i++) {
    let match = true;
    for (let j = 0; j < wanted.length; j++) {
      if (lines[i + j] !== wanted[j]) {
        match = false;
        break;
      }
    }
    if (match) result.push(i);
  }
  return result;
}

/**
 * Exact match first. Only if that finds nothing: drop copied 'NNNNN| ' line-number prefixes,
 * then ignore trailing whitespace. A fallback never widens an exact unique or ambiguous result.
 */
function locate(lines: string[], wanted: string[]): number[] {
  const exact = occurrences(lines, wanted);
  if (exact.length) return exact;
  const prefix = /^\s*\d{1,6}\| ?/;
  const unprefixed = wanted.length && wanted.every((line) => prefix.test(line))
    ? wanted.map((line) => line.replace(prefix, ""))
    : wanted;
  if (unprefixed !== wanted) {
    const found = occurrences(lines, unprefixed);
    if (found.length) return found;
  }
  const trim = (list: string[]) => list.map((line) => line.trimEnd());
  return occurrences(trim(lines), trim(unprefixed));
}

function existingPatch(path: string, original: string[], edits: Edit[]): string {
  const sorted = edits.slice().sort((a, b) => a.start - b.start);
  const groups: { start: number; end: number; edits: Edit[] }[] = [];

  for (const edit of sorted) {
    const start = Math.max(0, edit.start - 3);
    const end = Math.min(original.length, edit.end + 3);
    const group = groups[groups.length - 1];
    if (group && start <= group.end) {
      group.end = Math.max(group.end, end);
      group.edits.push(edit);
    } else {
      groups.push({ start, end, edits: [edit] });
    }
  }

  let patch = `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n`;
  let priorDelta = 0;
  for (const group of groups) {
    const output: string[] = [];
    let cursor = group.start;
    for (const edit of group.edits) {
      for (let i = cursor; i < edit.start; i++) output.push(` ${original[i]}`);
      for (let i = edit.start; i < edit.end; i++) output.push(`-${original[i]}`);
      for (const line of edit.replace) output.push(`+${line}`);
      cursor = edit.end;
    }
    for (let i = cursor; i < group.end; i++) output.push(` ${original[i]}`);

    const oldCount = group.end - group.start;
    const newCount = output.filter((line) => line[0] !== "-").length;
    const newStart = group.start + 1 + priorDelta;
    patch += `@@ -${group.start + 1},${oldCount} +${newStart},${newCount} @@\n`;
    patch += output.length ? `${output.join("\n")}\n` : "";
    for (const edit of group.edits) {
      priorDelta += edit.replace.length - (edit.end - edit.start);
    }
  }
  return patch;
}

function newFilePatch(path: string, content: string[]): string {
  let patch = `diff --git a/${path} b/${path}\nnew file mode 100644\n--- /dev/null\n+++ b/${path}\n`;
  patch += `@@ -0,0 +1,${content.length} @@\n`;
  if (content.length) patch += `${content.map((line) => `+${line}`).join("\n")}\n`;
  return patch;
}

export function editBlocksToPatch(
  text: string,
  readFile: (path: string) => string | null,
): { ok: true; patch: string } | { ok: false; errors: string[] } {
  let blocks: { path: string; search: string[]; replace: string[] }[];
  try {
    blocks = parseEditBlocks(text);
  } catch (error) {
    return { ok: false, errors: [error instanceof Error ? error.message.slice(0, 300) : "SBCE_EDIT_BLOCK_SYNTAX"] };
  }

  const errors: string[] = [];
  const byPath = new Map<string, typeof blocks>();
  for (const block of blocks) {
    if (!validPath(block.path)) {
      errors.push("SBCE_EDIT_PATH_INVALID");
      continue;
    }
    const list = byPath.get(block.path) ?? [];
    list.push(block);
    byPath.set(block.path, list);
  }
  if (errors.length) return { ok: false, errors };

  const patches: string[] = [];
  for (const [path, pathBlocks] of byPath) {
    const source = readFile(path);
    const isNew = pathBlocks.some((block) => block.search.length === 0);
    if (isNew) {
      if (pathBlocks.some((block) => block.search.length !== 0)) {
        errors.push(`SBCE_EDIT_FILE_MISSING:${path}`);
        continue;
      }
      patches.push(newFilePatch(path, pathBlocks[0].replace));
      continue;
    }
    if (source === null) {
      errors.push(`SBCE_EDIT_FILE_MISSING:${path}`);
      continue;
    }

    const original = fileLines(source);
    const edits: Edit[] = [];
    for (const block of pathBlocks) {
      const found = locate(original, block.search);
      if (found.length === 0) {
        errors.push(`SBCE_EDIT_SEARCH_NOT_FOUND:${path} (first SEARCH line: ${JSON.stringify((block.search[0] ?? "").slice(0, 80))})`);
      } else if (found.length > 1) {
        errors.push(`SBCE_EDIT_SEARCH_AMBIGUOUS:${path} (${found.length} matches; add more surrounding lines to SEARCH)`);
      } else {
        edits.push({ start: found[0], end: found[0] + block.search.length, replace: block.replace });
      }
    }
    edits.sort((a, b) => a.start - b.start);
    for (let i = 1; i < edits.length; i++) {
      if (edits[i].start < edits[i - 1].end) {
        errors.push(`SBCE_EDIT_OVERLAP:${path}`);
        break;
      }
    }
    if (!errors.some((error) => error.endsWith(`:${path}`))) {
      patches.push(existingPatch(path, original, edits));
    }
  }

  if (errors.length) return { ok: false, errors };
  return { ok: true, patch: `${patches.join("")}` };
}

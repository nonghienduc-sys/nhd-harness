#!/usr/bin/env node
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

export function sanitize(text) {
  let count = 0;
  let out = text;
  const filters = [
    /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,
    /\b(?:\+?84|0)(?:[\s.-]?\d){9,10}\b/g,
    /\b\d{9,12}\b/g,
    /\b(?:sk-[A-Za-z0-9_-]{12,}|ghp_[A-Za-z0-9]{12,})\b/g,
    /\b(?:password|api[_ -]?key|access[_ -]?token|client[_ -]?secret|mật khẩu|mat khau)\s*[:=]\s*[^\s,;]+/giu,
  ];
  for (const re of filters) out = out.replace(re, () => { count++; return "[đã lọc]"; });
  return { text: out, count };
}
function parseSource(text) {
  const clean = text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  const lines = clean.split("\n");
  if (lines[0] !== "---") throw new Error("missing front matter");
  const last = lines.findIndex((line, i) => i > 0 && line.trim() === "---");
  if (last < 2) throw new Error("invalid front matter");
  let name = "", description = "", type = "reference", inMeta = false;
  for (const line of lines.slice(1, last)) {
    if (/^metadata:\s*$/.test(line)) { inMeta = true; continue; }
    const match = /^(\s*)([\w-]+):\s*(.*)$/.exec(line);
    if (!match) continue;
    const [, indent, key, value] = match;
    if (!indent) {
      inMeta = false;
      if (key === "name") name = value;
      if (key === "description") description = value;
    } else if (inMeta && key === "type") type = value;
  }
  return { name, description, type, body: lines.slice(last + 1).join("\n").trim() };
}
export function importMemory(from, dest, dryRun = false) {
  if (!existsSync(from)) throw new Error("Missing input directory");
  let files = 0, written = 0, unchanged = 0, filtered = 0, skipped = 0;
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".md") || entry.name === "MEMORY.md" || entry.name === "_archive") { skipped++; continue; }
    try {
      const raw = readFileSync(join(from, entry.name), "utf8");
      const parsed = parseSource(raw);
      const id = (parsed.name || basename(entry.name, ".md")).toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-|-$/g, "");
      if (!id) throw new Error("invalid name");
      const loai = ["user", "feedback", "project", "reference"].includes(parsed.type) ? parsed.type : "reference";
      const cleaned = sanitize(parsed.body);
      const descClean = sanitize(parsed.description.replace(/[\r\n]/g, " "));
      filtered += cleaned.count + descClean.count;
      const description = descClean.text.slice(0, 170).replace(/^["']|["']$/g, "");
      const doc = "---\nid: " + id + "\nloai: " + loai + "\nmo_ta: " + description + "\n---\n" + cleaned.text + "\n";
      const output = join(dest, id + ".md");
      files++;
      if (existsSync(output) && readFileSync(output, "utf8") === doc) { unchanged++; continue; }
      if (!dryRun) {
        mkdirSync(dest, { recursive: true });
        writeFileSync(output, doc, { encoding: "utf8", mode: 0o600 });
      }
      written++;
    } catch (e) {
      skipped++;
      process.stderr.write("SKIP " + entry.name + ": " + (e instanceof Error ? e.message : String(e)) + "\n");
    }
  }
  return { files, written, unchanged, skipped, filtered, dryRun };
}
if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname.replace(/^\/([a-zA-Z]:)/, "$1"))) {
  const args = process.argv.slice(2);
  const src = args.indexOf("--tu"), dst = args.indexOf("--den");
  if (src < 0 || dst < 0 || !args[src + 1] || !args[dst + 1]) {
    process.stderr.write('Usage: node scripts/nap-claude-memory.mjs --tu "<Claude memory>" --den "<private/memory>" [--dry-run]\n');
    process.exitCode = 2;
  } else {
    try { process.stdout.write(JSON.stringify(importMemory(resolve(args[src + 1]), resolve(args[dst + 1]), args.includes("--dry-run"))) + "\n"); }
    catch (e) { process.stderr.write(String(e) + "\n"); process.exitCode = 1; }
  }
}

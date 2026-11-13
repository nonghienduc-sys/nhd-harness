import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ProjectRagService } from "../dist/project-rag.js";
import { capabilityPermission, capabilityRisk, capabilityIsMutation } from "../dist/capability-registry.js";

// Bản clone mới chưa có runtime/semantic-memory-venv: bỏ qua test cần Python thật.
const RAG_PY_SKIP = existsSync(join(process.cwd(), "runtime", "semantic-memory-venv", "Scripts", "python.exe")) ? false : "chưa có runtime/semantic-memory-venv";

test("project-isolated hybrid retrieval, provenance, token limits, stale detection and source guards", { timeout: 240000, skip: RAG_PY_SKIP }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "nhd-project-rag-"));
  const a = join(dir, "HTX"), b = join(dir, "TRADING");
  mkdirSync(a); mkdirSync(b);
  const docA = join(a, "ho-tro.txt"), docB = join(b, "bot.txt");
  writeFileSync(docA, "# Kinh phí hỗ trợ dự án\n\nDự án cộng đồng Tiến Thắng được ghi nhận kinh phí 661 triệu đồng.", "utf8");
  writeFileSync(docB, "# Quản trị rủi ro\n\nBot SOLUSDT giao dịch ký quỹ với chế độ isolated, thời gian nến 1 giờ.", "utf8");
  const files = { resolvePath: p => resolve(p) };
  const config = { projectWorkspaceRoot: dir };
  const pdf = { read: async () => { throw Error("mock PDF not expected"); } };
  const rag = new ProjectRagService(config, files, pdf);
  try {
    const empty = await rag.status(a);
    assert.equal(empty.indexed, false, "read-only status must not create a DB");
    await assert.rejects(() => rag.index(a, docB), /Cross-project/);
    await assert.rejects(() => rag.index(dir, docA), /concrete project/);
    writeFileSync(join(a, ".env"), "private=secret", "utf8");
    await assert.rejects(() => rag.index(a, join(a, ".env")), /denied/);
    const ingA = await rag.index(a, docA);
    const ingB = await rag.index(b, docB);
    assert.equal(ingA.ok, true); assert.equal(ingB.ok, true);
    assert.equal(ingA.unchanged, false);
    assert.equal((await rag.index(a, docA)).unchanged, true, "idempotent ingest avoids duplicate chunks");
    const statusA = await rag.status(a);
    assert.ok(statusA.chunks >= 1);
    assert.equal(statusA.chunks, statusA.fts_chunks);
    assert.equal(statusA.sources, 1);
    const foundA = await rag.query(a, "Kinh phí dự án cộng đồng Tiến Thắng bao nhiêu?", 6, 1800);
    assert.equal(foundA.indexed, true);
    assert.ok(foundA.results.length >= 1);
    assert.ok(foundA.results.every(hit => hit.source === docA));
    assert.ok(foundA.results.some(hit => hit.text.includes("661 triệu")));
    assert.ok(foundA.results.every(hit => hit.citation.locator && hit.untrustedSource === true));
    assert.ok(foundA.returnedChars <= 1800);
    const foundB = await rag.query(b, "SOLUSDT chế độ margin", 5, 1400);
    assert.ok(foundB.results.length >= 1);
    assert.ok(foundB.results.every(hit => hit.source === docB), "no cross-project leakage");
    writeFileSync(docA, "# Kinh phí thay đổi\n\nNội dung đã cập nhật.", "utf8");
    const stale = await rag.query(a, "Tiến Thắng", 5, 1000);
    assert.equal(stale.results.length, 0, "stale evidence is discarded until reindex");
    const updated = await rag.index(a, docA);
    assert.equal(updated.unchanged, false);
    const refreshed = await rag.query(a, "Kinh phí thay đổi", 5, 1000);
    assert.ok(refreshed.results.some(hit => hit.text.includes("đã cập nhật")));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("PDF page locators, safe scanned-PDF failure, and independent project index", { timeout: 240000, skip: RAG_PY_SKIP }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "nhd-project-rag-pdf-"));
  const p = join(dir, "RESEARCH");
  mkdirSync(p);
  const source = join(p, "article.pdf");
  writeFileSync(source, "%PDF-TEST-FIXTURE", "utf8");
  let scanned = false;
  const files = { resolvePath: v => resolve(v) };
  const pdf = { read: async () => ({
    totalPages: 2, truncated: false, pages: [
      { page: 1, scanned: false, text: "Nghiên cứu về nguồn phấn hoa cho ong nội Apis cerana." },
      { page: 2, scanned, text: "Cây dược liệu hỗ trợ quần thể ong và nguồn mật." },
    ],
  }) };
  const rag = new ProjectRagService({ projectWorkspaceRoot: dir }, files, pdf);
  try {
    scanned = true;
    await assert.rejects(() => rag.index(p, source), /requires OCR/);
    scanned = false;
    const indexed = await rag.index(p, source);
    assert.equal(indexed.chunks, 2);
    const hits = await rag.query(p, "Cây dược liệu nguồn mật ong", 4, 2000);
    assert.ok(hits.results.length);
    assert.ok(hits.results.some(x => x.citation.page === 2 && x.citation.locator.includes("#page=2")));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("RAG ingestion is governed as an explicit write mutation", () => {
  assert.equal(capabilityPermission("project_rag_ingest"), "write");
  assert.equal(capabilityIsMutation("project_rag_ingest"), true);
  assert.equal(capabilityRisk("project_rag_ingest", { readOnlyHint: false, destructiveHint: false }), "mutation");
  assert.equal(capabilityPermission("project_rag_query"), "read");
  assert.equal(capabilityPermission("project_rag_status"), "read");
});

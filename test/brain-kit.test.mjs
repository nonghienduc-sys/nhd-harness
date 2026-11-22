import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { brainStart, loadKnowledge, memoryDocument, parseFrontMatter } from "../dist/brain-kit.js";

const fixture = () => {
  const base = mkdtempSync(join(tmpdir(), "brain-kit-"));
  const pub = join(base, "public"), priv = join(base, "private");
  for (const root of [pub, priv]) for (const name of ["quy_trinh", "bai_hoc", "memory"])
    mkdirSync(join(root, name), { recursive: true });
  const save = (root, rel, text) => writeFileSync(join(root, rel), text, "utf8");
  save(pub, "luat_nen.md", "Luật nền luôn phải giữ nguyên.");
  save(pub, "cong.json", JSON.stringify({ kiem: { cmd: "test", expect_exit: 0 } }));
  save(pub, "quy_trinh/bao_cao.md", "---\nid: bao_cao\nten: Báo cáo gốc\ntu_khoa: [báo cáo, rà soát, chính sách]\nkhi_nao: Soạn báo cáo\nbuoc:\n  - so: 1\n    viec: Kiểm đầu vào\n    cong: [kiem]\n---\nGhi chú công khai.");
  save(priv, "quy_trinh/bao_cao.md", "---\nid: bao_cao\nten: Báo cáo riêng\ntu_khoa: [báo cáo, rà soát, chính sách]\nkhi_nao: Soạn báo cáo\nbuoc:\n  - so: 1\n    viec: Đối chiếu\n    cong: [kiem]\n---\nGhi chú riêng.");
  save(pub, "bai_hoc/cho_duyet.md", "---\nid: cho_duyet\nquy_trinh: bao_cao\nma_loi: E01\ntrang_thai: de_xuat\nso_lan: 5\n---\nChưa duyệt");
  save(pub, "bai_hoc/da_duyet.md", "---\nid: da_duyet\nquy_trinh: bao_cao\nma_loi: E02\ntrang_thai: da_duyet\nso_lan: 2\n---\nBài học đúng");
  save(pub, "memory/nguoi_dung.md", "---\nid: nguoi_dung\nloai: user\nmo_ta: Luôn giữ luật\n---\nNgười dùng muốn kiểm nghiệm thu");
  save(priv, "memory/du_an.md", "---\nid: du_an\nloai: project\nmo_ta: Kiểm tra báo cáo\n---\nTóm tắt dự án kiểm báo cáo");
  return { base, pub, priv, save, opts: { publicDir: pub, localDir: priv } };
};
test("private id overrides public and Vietnamese accent-free matching works", t => {
  const f = fixture(); t.after(() => rmSync(f.base, { recursive: true, force: true }));
  const store = loadKnowledge(f.opts);
  assert.equal(store.all.get("quy_trinh").get("bao_cao").fields.ten, "Báo cáo riêng");
  for (const query of ["soạn báo cáo rà soát chính sách", "soan bao cao ra soat chinh sach"]) {
    const x = brainStart({ yeu_cau: query }, f.opts);
    assert.equal(x.quy_trinh.id, "bao_cao");
    assert.equal(x.quy_trinh.ten, "Báo cáo riêng");
    assert.ok(x.cong.kiem);
  }
});
test("only approved lessons and all user memories appear", t => {
  const f = fixture(); t.after(() => rmSync(f.base, { recursive: true, force: true }));
  const out = brainStart({ yeu_cau: "soạn báo cáo rà soát" }, f.opts);
  assert.equal(out.bai_hoc.length, 1);
  assert.equal(out.bai_hoc[0].id, "da_duyet");
  assert.ok(out.memory.find(x => x.id === "nguoi_dung"));
});
test("bounded output preserves the entire law", t => {
  const f = fixture(); t.after(() => rmSync(f.base, { recursive: true, force: true }));
  const out = brainStart({ yeu_cau: "soạn báo cáo rà soát", max_chars: 900 }, f.opts);
  assert.ok(JSON.stringify(out).length <= 900);
  assert.equal(out.luat_nen, "Luật nền luôn phải giữ nguyên.");
  assert.equal(out.quy_trinh.id, "bao_cao");
});
test("broken front matter is skipped with warning", t => {
  const f = fixture(); t.after(() => rmSync(f.base, { recursive: true, force: true }));
  f.save(f.pub, "memory/hong.md", "---\nid: hong\nloai: user\n");
  const store = loadKnowledge(f.opts);
  assert.ok(store.warnings.some(s => s.includes("hong.md")));
  assert.equal(store.all.get("memory").has("hong"), false);
  assert.throws(() => parseFrontMatter("broken"));
});
test("write memory refuses fake phone and email", () => {
  assert.throws(() => memoryDocument("test", "user", "mẫu", "Số 0900000000"), /Từ chối/);
  assert.throws(() => memoryDocument("test", "user", "mẫu", "mail a@example.com"), /Từ chối/);
});
test("import is idempotent, skips MEMORY.md and filters private identifiers", async t => {
  const f = fixture(); t.after(() => rmSync(f.base, { recursive: true, force: true }));
  const from = join(f.base, "claude"); const dest = join(f.base, "output");
  mkdirSync(from);
  writeFileSync(join(from, "MEMORY.md"), "never import");
  mkdirSync(join(from, "_archive"));
  writeFileSync(join(from, "example.md"), "---\nname: example\ndescription: harmless\nmetadata:\n  type: feedback\n---\nUse [[related]]; fake phone 0900000000; contact a@example.com");
  const { importMemory } = await import("../scripts/nap-claude-memory.mjs");
  const a = importMemory(from, dest), b = importMemory(from, dest);
  assert.equal(a.written, 1);
  assert.equal(b.written, 0);
  assert.equal(b.unchanged, 1);
  assert.deepEqual(readdirSync(dest), ["example.md"]);
  const saved = readFileSync(join(dest, "example.md"), "utf8");
  assert.ok(saved.includes("[[related]]"));
  assert.ok(saved.includes("[đã lọc]"));
  assert.ok(!saved.includes("0900000000"));
});
test("CLI brain_start prints parseable output with memory", () => {
  const out = execFileSync(process.execPath, ["dist/brain-kit-cli.js", "brain_start", "giao việc cho ChatGPT rồi nghiệm thu receipt", "--json"], { encoding: "utf8", timeout: 30000 });
  const parsed = JSON.parse(out);
  assert.ok(parsed.luat_nen);
  assert.ok(parsed.memory.length > 0);
});

test("private workflow gate resolves every referenced definition and overrides public gate", t => {
  const f = fixture(); t.after(() => rmSync(f.base, { recursive: true, force: true }));
  f.save(f.priv, "cong.json", JSON.stringify({
    kiem: { cmd: "private-check", expect_exit: 0 },
    nghiem_thu: { mo_ta: "Chạy kiểm độc lập", cmd: "verify --run-checks", expect_exit: 0, expect_regex: "DAT" },
  }));
  f.save(f.priv, "quy_trinh/giao_viec_va_nghiem_thu.md",
    "---\nid: giao_viec_va_nghiem_thu\nten: Giao việc và nghiệm thu\ntu_khoa: [giao việc, ChatGPT, nghiệm thu, receipt]\nkhi_nao: Giao việc cho ChatGPT rồi nghiệm thu\nbuoc:\n  - so: 1\n    viec: Kiểm nguồn\n    cong: [kiem]\n  - so: 2\n    viec: Nghiệm thu\n    cong: [nghiem_thu]\n---\nNghiệm thu đúng cổng.");
  const out = brainStart({ yeu_cau: "giao việc cho ChatGPT rồi nghiệm thu receipt" }, f.opts);
  assert.equal(out.quy_trinh.id, "giao_viec_va_nghiem_thu");
  assert.deepEqual(Object.keys(out.cong).sort(), ["kiem", "nghiem_thu"]);
  assert.equal(out.cong.kiem.cmd, "private-check");
  assert.equal(out.cong.nghiem_thu.cmd, "verify --run-checks");
  assert.equal(out.cong.nghiem_thu.expect_regex, "DAT");
});

test("memory is ranked by id, ten, mo_ta, noi_dung; accent-free match wins over sample", t => {
  const f = fixture(); t.after(() => rmSync(f.base, { recursive: true, force: true }));
  f.save(f.priv, "memory/chatgpt-loop-nghiem-thu.md",
    "---\nid: chatgpt-loop-nghiem-thu\nloai: project\nmo_ta: ChatGPT nghiệm thu receipt\n---\nBài học kiểm soát quy trình.");
  f.save(f.priv, "memory/other.md",
    "---\nid: other\nloai: reference\nmo_ta: Chăm sóc cây trồng\n---\nGhi chú không liên quan.");
  for (const yeu_cau of ["giao việc cho ChatGPT rồi nghiệm thu receipt", "giao viec cho ChatGPT roi nghiem thu receipt"]) {
    const out = brainStart({ yeu_cau }, f.opts);
    assert.ok(out.memory.find(x => x.id === "chatgpt-loop-nghiem-thu"), JSON.stringify(out.memory));
    assert.ok(out.memory.find(x => x.id === "nguoi_dung"), "user memory must always be included");
    assert.equal(out.memory[0].id, "chatgpt-loop-nghiem-thu");
    assert.equal(out.memory.some(x => x.id === "other"), false);
  }
});

test("unknown gate is warned without inventing its definition", t => {
  const f = fixture(); t.after(() => rmSync(f.base, { recursive: true, force: true }));
  f.save(f.priv, "quy_trinh/bao_cao.md",
    "---\nid: bao_cao\nten: Báo cáo riêng\ntu_khoa: [báo cáo, rà soát, chính sách]\nkhi_nao: Soạn báo cáo\nbuoc:\n  - so: 1\n    viec: Kiểm đầu vào\n    cong: [kiem, cong_khong_co]\n---\nGhi chú riêng.");
  const out = brainStart({ yeu_cau: "soạn báo cáo rà soát" }, f.opts);
  assert.ok(out.cong.kiem);
  assert.equal(Object.hasOwn(out.cong, "cong_khong_co"), false);
  assert.ok(out.canh_bao.some(x => x.includes("cong_khong_co")));
});

test("ambiguous request yields clarification", t => {
  const f = fixture(); t.after(() => rmSync(f.base, { recursive: true, force: true }));
  const out = brainStart({ yeu_cau: "Làm báo cáo giúp tôi" }, f.opts);
  assert.equal(out.quy_trinh?.id, undefined);
  assert.ok(out.can_hoi_lai?.cau_hoi);
  assert.ok(out.can_hoi_lai?.goi_y.length);
});
test("gate symptom selects workflow", t => {
  const f = fixture(); t.after(() => rmSync(f.base, { recursive: true, force: true }));
  f.save(f.pub, "cong.json", JSON.stringify({ kiem: {cmd:"test"}, kiem_pdf_hien_thi: {mo_ta:"PDF đường kẻ quốc hiệu XML hiển thị"} }));
  f.save(f.pub, "quy_trinh/soan_mau.md", ["---","id: soan_mau","ten: Soạn văn bản từ mẫu","tu_khoa: [văn bản, mẫu]","buoc:","  - so: 1","    viec: Kiểm PDF đường kẻ quốc hiệu","    cong: [kiem_pdf_hien_thi]","---",""].join("\n"));
  f.save(f.pub, "quy_trinh/du_an.md", ["---","id: du_an","ten: Hồ sơ dự án","tu_khoa: [dự án, PDF]","buoc:","  - so: 1","    viec: Kiểm dự toán","    cong: [kiem]","---",""].join("\n"));
  const out = brainStart({ yeu_cau: "PDF đường kẻ quốc hiệu mất dù kiểm XML đạt" }, f.opts);
  assert.equal(out.quy_trinh.id, "soan_mau");
  assert.ok(out.cong.kiem_pdf_hien_thi);
});

test("deictic references without task context ask for clarification", t => {
  const f = fixture(); t.after(() => rmSync(f.base, { recursive: true, force: true }));
  for (const yeu_cau of ["Làm cái đó giúp tôi", "Xem tài liệu này", "Như hôm qua nhé"]) {
    const out = brainStart({ yeu_cau }, f.opts);
    assert.equal(out.quy_trinh.id, undefined, yeu_cau);
    assert.ok(out.can_hoi_lai?.cau_hoi);
  }
});
test("administrative document type and form concept select template workflow", t => {
  const f = fixture(); t.after(() => rmSync(f.base, { recursive: true, force: true }));
  f.save(f.pub, "quy_trinh/soan_mau.md", [
    "---", "id: soan_mau", "ten: Soạn văn bản hành chính từ mẫu",
    "tu_khoa: [công văn, quyết định, mẫu, Word]",
    "khi_nao: Soạn văn bản đúng thể thức cơ quan", "buoc:",
    "  - so: 1", "    viec: Dựng Word theo mẫu", "    cong: [kiem]", "---", ""
  ].join("\n"));
  const out = brainStart({ yeu_cau: "Chuẩn bị tờ trình theo thể thức hành chính" }, f.opts);
  assert.equal(out.quy_trinh.id, "soan_mau");
});
test("ranking source contains no complete phrases copied from mock exam questions", t => {
  const f = fixture(); t.after(() => rmSync(f.base, { recursive: true, force: true }));
  const exam = [
    { yeu_cau: "Kiểm hồ sơ nhập liệu phiên bản mới" },
    { yeu_cau: "Tổng hợp thông tin dự án đầu năm" },
    { yeu_cau: "Đối chiếu thông báo đã nhận tuần trước" }
  ];
  f.save(f.pub, "cau_hoi.json", JSON.stringify(exam));
  const source = readFileSync(new URL("../src/brain-kit.ts", import.meta.url), "utf8");
  for (const row of JSON.parse(readFileSync(join(f.pub, "cau_hoi.json"), "utf8"))) {
    assert.equal(source.includes(row.yeu_cau), false);
  }
  assert.equal(source.includes('tokens.includes("soan")'), false);
});

test("candidate ranking has at most three descending positive scores", t => {
  const f = fixture(); t.after(() => rmSync(f.base, { recursive: true, force: true }));
  for (const id of ["alpha", "beta", "gamma", "delta"]) {
    f.save(f.pub, `quy_trinh/${id}.md`, [
      "---", `id: ${id}`, `ten: ${id} rà soát chính sách`,
      "tu_khoa: [rà soát, chính sách]", "khi_nao: Có nhu cầu rà soát chính sách",
      "buoc:", "  - so: 1", "    viec: Kiểm nội dung", "    cong: [kiem]", "---", ""
    ].join("\n"));
  }
  const out = brainStart({ yeu_cau: "rà soát chính sách hiện hành", max_chars: 12000 }, f.opts);
  assert.ok(out.ung_vien.length > 0 && out.ung_vien.length <= 3);
  assert.ok(out.ung_vien.every(x => x.diem > 0 && x.khi_nao.length <= 200 && Array.isArray(x.cong)));
  assert.ok(out.ung_vien.every((x, i, a) => i === 0 || a[i - 1].diem >= x.diem));
});
test("no hand-tuned large score constants in ranking source", () => {
  const source = readFileSync(new URL("../src/brain-kit.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /points\s*\+=\s*(?:1[6-9]|[2-9][0-9])\b/);
});

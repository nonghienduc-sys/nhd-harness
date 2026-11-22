import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brainStart } from "../dist/brain-kit.js";
import { analyzeLessons, proposeLesson, listLessons, previewLessonDecision, applyLessonDecision } from "../dist/lesson-loop.js";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "nhd-p7-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const priv = join(root, "private");
  const pub = join(root, "public");
  for (const base of [priv, pub]) {
    mkdirSync(join(base, "bai_hoc"), { recursive: true });
    mkdirSync(join(base, "quy_trinh"), { recursive: true });
    writeFileSync(join(base, "luat_nen.md"), "Tuân thủ kiểm tra độc lập và quyền người dùng.");
  }
  writeFileSync(join(priv, "cong.json"), '{"nghiem_thu":{"cmd":"check"}}');
  writeFileSync(join(priv, "quy_trinh", "soan_bao_cao.md"),
    "---\nid: soan_bao_cao\nten: Soạn báo cáo\ntu_khoa: [soạn, báo cáo, kiểm]\nkhi_nao: Lập báo cáo\nbuoc:\n  - so: 1\n    viec: Kiểm tệp\n    cong: [nghiem_thu]\n---\nNội dung quy trình.\n");
  function add(ma, receipt, quy_trinh = "soan_bao_cao") {
    const row = {luc:"2026-11-22T00:00:00Z", receipt, quy_trinh, ma_loi:ma,
      mo_ta:"Kiểm kết quả", nguon:"nghiem_thu"};
    const { appendFileSync } = requireCompat;
    appendFileSync(join(priv, "phan_hoi.jsonl"), JSON.stringify(row)+"\n");
  }
  return {root, priv, pub, add, opts:{publicDir:pub,localDir:priv}};
}
import { appendFileSync } from "node:fs";
const requireCompat={appendFileSync};

function fakeTransaction() {
  const pending = new Map();
  return {
    preview(kind, payload, taskId) {
      assert.equal(kind, "write");
      const actionId = "token-action-" + pending.size;
      pending.set(actionId, {payload, taskId});
      return { actionId, confirmationToken: "human-confirmation" };
    },
    apply(actionId, token, kind, taskId) {
      assert.equal(kind, "write");
      if (token !== "human-confirmation") throw new Error("Invalid approval token");
      const saved = pending.get(actionId);
      if (!saved || saved.taskId !== taskId) throw new Error("Unmatched preview");
      writeFileSync(saved.payload.path, saved.payload.content);
      pending.delete(actionId);
      return {applied:true};
    }
  };
}

test("analyze counts by process and code, including distinct receipts", t => {
  const f=fixture(t);
  f.add("SHA_SAI","r1"); f.add("SHA_SAI","r2"); f.add("CHECK_TRUOT","r3");
  const groups=analyzeLessons(f.priv);
  assert.equal(groups.length,2);
  assert.equal(groups[0].so_lan,2);
  assert.deepEqual(groups[0].nguon,["r1","r2"]);
});
test("propose requires >=2, creates one stable proposed lesson", t => {
  const f=fixture(t); f.add("SHA_SAI","r1");
  assert.throws(()=>proposeLesson(f.priv,"soan_bao_cao","SHA_SAI"),/2 lần/);
  f.add("SHA_SAI","r2");
  const one=proposeLesson(f.priv,"soan_bao_cao","SHA_SAI","Luôn so bản gốc và SHA trước khi hoàn tất.");
  const two=proposeLesson(f.priv,"soan_bao_cao","SHA_SAI");
  assert.equal(one.id,two.id);
  assert.equal(readdirSync(join(f.priv,"bai_hoc")).length,1);
  assert.equal(listLessons(f.priv)[0].trang_thai,"de_xuat");
});
test("approving without high-level preview token is impossible", t => {
  const f=fixture(t);f.add("SHA_SAI","r1");f.add("SHA_SAI","r2");
  const entry=proposeLesson(f.priv,"soan_bao_cao","SHA_SAI");
  const tx=fakeTransaction();
  assert.throws(()=>applyLessonDecision(f.priv,entry.id,"approve","task-id",undefined,undefined,undefined,tx),/token required/);
  assert.equal(listLessons(f.priv)[0].trang_thai,"de_xuat");
});
test("approved lesson reaches brainStart and rejected lesson does not", t => {
  const f=fixture(t); f.add("SHA_SAI","r1");f.add("SHA_SAI","r2");
  f.add("CHECK_TRUOT","r3");f.add("CHECK_TRUOT","r4");
  const one=proposeLesson(f.priv,"soan_bao_cao","SHA_SAI","Luôn kiểm SHA độc lập.");
  const two=proposeLesson(f.priv,"soan_bao_cao","CHECK_TRUOT","Chạy kiểm thật.");
  const tx=fakeTransaction();
  for(const [id,op] of [[one.id,"approve"],[two.id,"reject"]]){
    const p=previewLessonDecision(f.priv,id,op,"task-id",tx);
    const pending={id,op,taskRunId:"task-id",path:p.path};
    applyLessonDecision(f.priv,id,op,"task-id",p.actionId,p.confirmationToken,pending,tx);
  }
  assert.deepEqual(listLessons(f.priv).map(x=>x.trang_thai).sort(),["bo","da_duyet"]);
  const out=brainStart({yeu_cau:"soạn báo cáo kiểm",max_chars:9000},f.opts);
  assert.deepEqual(out.bai_hoc.map(x=>x.id),[one.id]);
  assert.match(readFileSync(join(f.priv,"bai_hoc",one.id+".md"),"utf8"),/duyet_luc: 20/);
});
test("sensitive lessons with a fake phone number are rejected", t => {
  const f=fixture(t);f.add("SHA_SAI","r1");f.add("SHA_SAI","r2");
  assert.throws(()=>proposeLesson(f.priv,"soan_bao_cao","SHA_SAI","SĐT 0900000000"),/Từ chối/);
});
test("DOCX_SHAPE_LINE approval invokes the existing self-evolution feedback service", t => {
  const f=fixture(t);f.add("DOCX_SHAPE_LINE","r1");f.add("DOCX_SHAPE_LINE","r2");
  const entry=proposeLesson(f.priv,"soan_bao_cao","DOCX_SHAPE_LINE");
  const tx=fakeTransaction(), calls=[];
  const p=previewLessonDecision(f.priv,entry.id,"approve","task-checked",tx);
  const pending={id:entry.id,op:"approve",taskRunId:"task-checked",path:p.path};
  applyLessonDecision(f.priv,entry.id,"approve","task-checked",p.actionId,p.confirmationToken,pending,tx,
    {recordFeedback: x=>{calls.push(x);return {accepted:true}}},"admin-docx");
  assert.equal(calls.length,1);
  assert.equal(calls[0].issueCode,"DOCX_SHAPE_LINE");
  assert.equal(calls[0].verified,true);
});

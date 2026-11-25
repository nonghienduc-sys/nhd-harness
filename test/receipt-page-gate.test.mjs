import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { receiptWrite, LEDGER_COLUMNS } from "../dist/receipt-write.js";

const start = new Date("2026-11-25T01:00:00Z"), end = new Date("2026-11-25T01:01:00Z");
const now = new Date("2026-11-25T01:02:00Z"), earlier = new Date("2026-11-25T00:59:00Z");
function sandbox(fn) {
  const root = mkdtempSync(join(tmpdir(), "nhd-page-gate-"));
  try {
    const script = join(root, "kiem_trang.py"), output = join(root, "receipt.json"), ledger = join(root, "ledger.csv");
    const ra = join(root, "qa");
    function file(name) {
      const p = join(root, name);
      mkdirSync(join(p, ".."), { recursive: true });
      writeFileSync(p, "fixture"); utimesSync(p, earlier, earlier); return p;
    }
    writeFileSync(script, "# fixture");
    const word = file("lam/a.docx");
    function pair(mode, target = word, opts = {}) {
      const cmd = opts.cmd ?? 'python "' + (opts.script ?? script) + '" ' + mode + ' "' + target + '" --ra "' + ra + '"';
      const check = { cmd, expect_exit: opts.expect_exit ?? 0, ...(opts.expect_regex === undefined ? {} : { expect_regex: opts.expect_regex }) };
      const row = { action: "terminal_execute", at: end.toISOString(), detail: {
        command: opts.actualCmd ?? cmd, code: opts.code ?? 0, timedOut: opts.timedOut ?? false,
        stdout: opts.stdout ?? (mode === "kiem" ? "KIEM_TRANG: DAT\n" : "KIEM_TRANG_SO: DAT\n"),
        startedAt: opts.noStart ? undefined : start.toISOString(), completedAt: end.toISOString(),
      }};
      return { check, row };
    }
    function seal(pairs, opts = {}) {
      return receiptWrite({ path: output, receipt: { task: "fixture", status: opts.status ?? "XONG",
        files: (opts.files ?? [word]).map(path => ({ path })), checks: pairs.map(p => p.check), ...opts.receipt },
        pageGateScript: opts.script === undefined ? script : opts.script,
        auditRows: pairs.map(p => p.row), now: () => now, ledgerPath: opts.ledgerPath });
    }
    fn({ root, script, output, ledger, ra, word, file, pair, seal });
  } finally { rmSync(root, { recursive: true, force: true }); }
}
const fail = /RECEIPT_PAGE_CHECK_REQUIRED/;
test("both fresh checks seal", () => sandbox(({pair,seal,output}) => {
  seal([pair("kiem"),pair("so")]); assert.ok(existsSync(output));
}));
test("missing kiem", () => sandbox(({pair,seal}) => assert.throws(() => seal([pair("so")]), /thieu KIEM_TRANG;/)));
test("missing so", () => sandbox(({pair,seal}) => assert.throws(() => seal([pair("kiem")]), /thieu KIEM_TRANG_SO;/)));
test("fake expect_regex cannot replace DAT", () => sandbox(({word,pair,seal}) => assert.throws(() => seal([pair("kiem",word,{expect_regex:".*",stdout:"KIEM_TRANG: CHUA DAT"}),pair("so")]),fail)));
test("expected nonzero exit is not DAT", () => sandbox(({word,pair,seal}) => assert.throws(() => seal([pair("kiem",word,{expect_exit:1,code:1}),pair("so")]),fail)));
test("echo marker cannot count", () => sandbox(({word,pair,seal}) => assert.throws(() => seal([pair("kiem",word,{cmd:"echo KIEM_TRANG: DAT"}),pair("so")]),fail)));
test("chained command cannot count", () => sandbox(({word,pair,seal}) => assert.throws(() => seal([pair("kiem",word,{cmd:pair("kiem").check.cmd+"; echo KIEM_TRANG: DAT"}),pair("so")]),fail)));
test("same script name in other directory cannot count", () => sandbox(({root,word,pair,seal}) => assert.throws(() => seal([pair("kiem",word,{script:join(root,"other","kiem_trang.py")}),pair("so")]),fail)));
test("parent directory covers multiple Word files", () => sandbox(({root,word,file,pair,seal}) => {
  const other=file("lam/sub/b.docm"); seal([pair("kiem",join(root,"lam")),pair("so",join(root,"lam"))],{files:[word,other]});
}));
test("directory prefix is not a directory boundary", () => sandbox(({root,file,pair,seal}) => assert.throws(() => seal([pair("kiem",join(root,"lam")),pair("so",join(root,"lam"))],{files:[file("lam2/b.docx")]}),fail)));
test("uppercase DOCX requires checks", () => sandbox(({file,seal}) => assert.throws(() => seal([],{files:[file("UPPER.DOCX")]}),fail)));
test("modified after check start even before completion is stale", () => sandbox(({word,pair,seal}) => {
  const changed=new Date("2026-11-25T01:00:30Z"); utimesSync(word,changed,changed);
  assert.throws(() => seal([pair("kiem"),pair("so")]),/sua sau khi kiem/);
}));
test("blocked receipt KET allowed", () => sandbox(({seal,output}) => {seal([],{status:"KET"}); assert.ok(existsSync(output));}));
test("non-Word files unaffected", () => sandbox(({file,seal,output}) => {seal([],{files:[file("plain.txt")]}); assert.ok(existsSync(output));}));
test("disabled page gate unaffected", () => sandbox(({seal,output}) => {seal([],{script:null}); assert.ok(existsSync(output));}));
test("blocked gate leaves receipt absent and ledger untouched", () => sandbox(({ledger,output,seal}) => {
  const original=LEDGER_COLUMNS.join(",")+"\n"; writeFileSync(ledger,original);
  assert.throws(() => seal([],{ledgerPath:ledger}),fail);
  assert.equal(existsSync(output),false); assert.equal(readFileSync(ledger,"utf8"),original);
}));
test("only uncovered file is listed", () => sandbox(({word,file,pair,seal}) => {
  const other=file("lam/b.docx");
  assert.throws(() => seal([pair("kiem"),pair("so")],{files:[word,other]}),e => e.message.includes(other+": thieu") && !e.message.includes(word+": thieu"));
}));
test("normalization and supported Python flags", () => sandbox(({root,script,ra,word,pair,seal}) => {
  const target=join(root,"lam")+"\\..\\lam";
  const cmd='py -I -X utf8 "'+script.toUpperCase()+'" kiem "'+target+'" --ra "'+ra+'"';
  seal([pair("kiem",word,{cmd}),pair("so")]);
}));
test("unquoted shell operators and extra flags cannot count", () => sandbox(({word,pair,seal}) => {
  for(const extra of [" | echo x"," & echo x"," > out"," < in","\n"," $(echo x)", " --extra", " \x60"]) {
    assert.throws(() => seal([pair("kiem",word,{cmd:pair("kiem").check.cmd+extra}),pair("so")]),fail);
  }
}));
test("timeout cannot count", () => sandbox(({word,pair,seal}) => assert.throws(() => seal([pair("kiem",word,{timedOut:true}),pair("so")]),fail)));
test("full audit output, not truncated public evidence", () => sandbox(({word,pair,seal}) => seal([pair("kiem",word,{stdout:"KIEM_TRANG: DAT\n"+"a".repeat(3000)}),pair("so")])));
test("fallback to completion when start time unavailable", () => sandbox(({word,pair,seal}) => {
  const changed=new Date("2026-11-25T01:00:30Z"); utimesSync(word,changed,changed);
  seal([pair("kiem",word,{noStart:true}),pair("so",word,{noStart:true})]);
}));
test("receipt content cannot disable gate", () => sandbox(({seal}) => assert.throws(() => seal([],{receipt:{pageGateScript:null}}),fail)));

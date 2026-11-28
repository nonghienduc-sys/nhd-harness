import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, readFileSync, existsSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { receiptWrite } from "../dist/receipt-write.js";

const pageRequired = /RECEIPT_PAGE_CHECK_REQUIRED/;
const windowsOnly = { skip: process.platform !== "win32" };

function fixture(fn) {
  const root = mkdtempSync(join(tmpdir(), "receipt-source-copy-"));
  try {
    const sourceRoot = join(root, "store", "files");
    const outputDir = join(root, "products");
    mkdirSync(join(sourceRoot, "aa"), { recursive: true });
    mkdirSync(outputDir);
    const original = join(sourceRoot, "aa", "source.docx");
    const copy = join(outputDir, "copy.docx");
    const pageGateScript = join(root, "pages.py");
    const out = join(root, "receipt.json");
    writeFileSync(original, "original fixture bytes");
    copyFileSync(original, copy);
    writeFileSync(pageGateScript, "# fixture");
    const seal = (files, overrides = {}, receiptOverrides = {}) =>
      receiptWrite({
        path: out, pageGateScript, sourceCopyRoots: [sourceRoot],
        auditRows: [],
        receipt: { task: "fixture", status: "completed", files, checks: [], ...receiptOverrides },
        ...overrides
      });
    fn({ root, sourceRoot, outputDir, original, copy, out, seal, pageGateScript });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("source copy: identical bytes, normalized Windows path and sealed digest", windowsOnly, () =>
  fixture(({ sourceRoot, original, copy, out, seal }) => {
    const claimed = sourceRoot.toUpperCase() + "\\aa\\..\\aa\\source.docx";
    seal([{ path: copy, nguon_goc: claimed }]);
    const result = JSON.parse(readFileSync(out, "utf8"));
    assert.equal(result.files[0].nguon_goc.toLowerCase(), original.toLowerCase());
    assert.equal(result.files[0].sha256, createHash("sha256").update(readFileSync(copy)).digest("hex"));
  }));

test("source copy: a changed Word copy still needs both page gates", windowsOnly, () =>
  fixture(({ original, copy, seal, out }) => {
    writeFileSync(copy, "changed");
    assert.throws(() => seal([{ path: copy, nguon_goc: original }]), pageRequired);
    assert.equal(existsSync(out), false);
  }));

test("source copy: outside root and sibling prefix are rejected", windowsOnly, () =>
  fixture(({ root, sourceRoot, copy, seal, out }) => {
    const outside = join(root, "outside.docx");
    const sibling = sourceRoot + "2";
    mkdirSync(sibling);
    const siblingFile = join(sibling, "source.docx");
    copyFileSync(copy, outside);
    copyFileSync(copy, siblingFile);
    for (const claim of [outside, siblingFile, sourceRoot + "\\..\\..\\outside.docx"]) {
      assert.throws(() => seal([{ path: copy, nguon_goc: claim }]), pageRequired);
    }
    assert.equal(existsSync(out), false);
  }));

test("source copy: invalid path, missing file, directory and non-string are rejected", windowsOnly, () =>
  fixture(({ sourceRoot, copy, seal, out }) => {
    for (const claim of ["aa\\source.docx", "\\aa\\source.docx", "C:source.docx",
      join(sourceRoot, "missing.docx"), join(sourceRoot, "aa"), null, 42, {}]) {
      assert.throws(() => seal([{ path: copy, nguon_goc: claim }]), pageRequired);
    }
    assert.equal(existsSync(out), false);
  }));

test("source copy: junction pointing outside the trusted root is rejected", windowsOnly, () =>
  fixture(({ root, sourceRoot, copy, seal }) => {
    const outside = join(root, "outside");
    mkdirSync(outside);
    copyFileSync(copy, join(outside, "source.docx"));
    const junction = join(sourceRoot, "junction");
    symlinkSync(outside, junction, "junction");
    assert.throws(() => seal([{ path: copy, nguon_goc: join(junction, "source.docx") }]), pageRequired);
  }));

test("source copy: independent DOCM and draft still need page gates", windowsOnly, () =>
  fixture(({ outputDir, copy, original, seal }) => {
    const draft = join(outputDir, "draft.docm");
    writeFileSync(draft, "draft");
    assert.throws(() => seal([{ path: copy, nguon_goc: original }, { path: draft }]),
      error => pageRequired.test(error.message) && error.message.includes(draft) && !error.message.includes(copy + ": thieu"));
  }));

test("source copy: missing harness check evidence is not exempt", windowsOnly, () =>
  fixture(({ copy, original, seal }) => {
    assert.throws(() => seal([{ path: copy, nguon_goc: original }], {},
      { checks: [{ cmd: "fixture-command", expect_exit: 0 }] }), /RECEIPT_CHECKS_FAILED/);
  }));

test("source copy: configured roots take precedence and environment supports multiple roots", windowsOnly, () =>
  fixture(({ root, sourceRoot, copy, original, seal }) => {
    const previous = process.env.NHD_NGUON_GOC_ROOTS;
    try {
      delete process.env.NHD_NGUON_GOC_ROOTS;
      assert.throws(() => seal([{ path: copy, nguon_goc: original }], { sourceCopyRoots: undefined }), pageRequired);
      process.env.NHD_NGUON_GOC_ROOTS = join(root, "absent") + ";" + sourceRoot;
      seal([{ path: copy, nguon_goc: original }], { sourceCopyRoots: undefined });
      assert.throws(() => seal([{ path: copy, nguon_goc: original }], { sourceCopyRoots: [] }), pageRequired);
      process.env.NHD_NGUON_GOC_ROOTS = "";
      assert.throws(() => seal([{ path: copy, nguon_goc: original }], { sourceCopyRoots: undefined }), pageRequired);
    } finally {
      if (previous === undefined) delete process.env.NHD_NGUON_GOC_ROOTS;
      else process.env.NHD_NGUON_GOC_ROOTS = previous;
    }
  }));

test("source copy: verified PDF retains source metadata; blocked receipt can retain an invalid claim", windowsOnly, () =>
  fixture(({ outputDir, sourceRoot, copy, out, seal }) => {
    const pdf = join(outputDir, "copy.pdf");
    const originalPdf = join(sourceRoot, "source.pdf");
    writeFileSync(originalPdf, "PDF fixture bytes");
    copyFileSync(originalPdf, pdf);
    seal([{ path: pdf, nguon_goc: originalPdf }]);
    assert.equal(JSON.parse(readFileSync(out, "utf8")).files[0].nguon_goc, originalPdf);
    seal([{ path: copy, nguon_goc: "not-valid" }], {}, { status: "blocked" });
    assert.equal(JSON.parse(readFileSync(out, "utf8")).status, "blocked");
  }));

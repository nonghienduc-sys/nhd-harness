import test from "node:test";
import assert from "node:assert/strict";
import { planArtifactWorkflow } from "../dist/artifact-intelligence.js";
import { UnifiedExecutionPlanner } from "../dist/execution-planner.js";
import { WorkstationRouter } from "../dist/router.js";
import { ToolGovernorService } from "../dist/tool-governor.js";
import { SkillService } from "../dist/skills.js";

function mockCapabilities() {
  return {
    version: "0.24.6",
    roots: ["D:\\Work"],
    writeEnabled: true,
    terminalEnabled: true,
    skillsEnabled: true,
    screenEnabled: true,
    desktopEnabled: true,
    visualDesktopEnabled: true,
    intakeEnabled: true,
    ocrEnabled: true,
    emergencyStop: false,
    tools: [],
    files: { read: true, write: true },
    office: {
      offlineRead: true,
      offlineWrite: true,
      liveRead: true,
      liveWrite: true,
      applications: { word: true, excel: true, powerpoint: true, outlook: true },
      liveWriteApplications: { word: true, excel: true, powerpoint: true, outlook: false },
    },
    browser: {
      enabled: true,
      dom: true,
      screenshot: true,
      dedicatedChromium: true,
      cocCocConnected: true,
      cocCocTabs: 2,
      isolatedBrowser: true,
    },
    desktop: { enabled: true, uia: true, visual: true },
    terminal: { enabled: true },
    intake: { enabled: true },
    pdf: { enabled: true },
  };
}

function createPlanner() {
  const router = new WorkstationRouter();
  const governor = {
    advice: (input) => ({
      planningMode: "advisory-read-only",
      createsActivePlan: false,
      root: input.root ?? null,
      taskClass: "general_workstation",
      projectProfile: "unknown",
      directFastLane: true,
      globalCapabilityAwareness: true,
      hiddenCapabilities: false,
      recommendedTools: [],
      qualityFloor: [],
      avoidUnlessNeeded: [],
      toolBudget: { kind: "soft", expectedCalls: 1, softLimit: 3, hardLimit: null },
      escalationTriggers: [],
      artifactPlan: planArtifactWorkflow({ text: input.text, projectHint: input.projectHint }),
    }),
  };
  return new UnifiedExecutionPlanner({ router, governor });
}

test("Test A: Government công văn -> government route, strict, admin skill, visual QA", () => {
  const plan = planArtifactWorkflow({
    text: "Soạn công văn gửi UBND tỉnh về việc báo cáo giải ngân",
    target: "cong_van_ubnd.docx",
    application: "word",
  });
  assert.equal(plan.artifactType, "government_document");
  assert.equal(plan.fidelity, "strict");
  assert.ok(plan.recommendedSkills.includes("skill-chinh-sua-format-van-ban") || plan.recommendedSkills.includes("vietnam-admin-documents"));
  assert.equal(plan.qa.visual, true);
  assert.equal(plan.qa.structural, true);
  assert.equal(plan.requiresLegalSourceResolution, true);
  assert.ok(plan.warnings.some((w) => /Plain-text.*DOCX SaveAs is forbidden/i.test(w)));
});

test("Test B: NEU KLTN -> academic route; NĐ30 NOT selected", () => {
  const plan = planArtifactWorkflow({
    text: "Soạn khóa luận tốt nghiệp NEU về tài chính ngân hàng",
    target: "kltn_neu_final.docx",
    application: "word",
  });
  assert.equal(plan.artifactType, "academic_thesis");
  assert.equal(plan.fidelity, "strict");
  assert.ok(plan.recommendedSkills.includes("word-professional"));
  assert.ok(!plan.recommendedSkills.includes("skill-chinh-sua-format-van-ban"));
  assert.ok(!plan.recommendedSkills.includes("vietnam-admin-documents"));
  assert.equal(plan.qa.citationCheck, true);
  assert.equal(plan.qa.crossReferenceCheck, true);
  assert.ok(!plan.sourceOfTruth.some((s) => /Nghị định 30/i.test(s.value)));
});

test("Test C: CMC report 'same as 2025 FINAL' -> corporate template route; reference file highest precedence; template diff QA", () => {
  const plan = planArtifactWorkflow({
    text: "Viết báo cáo CMC quý 1 giống hệt file 2025 FINAL",
    referencePath: "D:\\Reports\\CMC_Report_2025_FINAL.docx",
    target: "CMC_Report_Q1_2026.docx",
    application: "word",
  });
  assert.equal(plan.artifactType, "corporate_template_report");
  assert.equal(plan.editingMode, "template_clone_update");
  assert.equal(plan.fidelity, "strict");
  assert.equal(plan.sourceOfTruth[0].priority, 1);
  assert.equal(plan.sourceOfTruth[0].kind, "user_selected_artifact");
  assert.ok(plan.sourceOfTruth[0].value.includes("CMC_Report_2025_FINAL.docx"));
  assert.equal(plan.qa.templateDiff, true);
  assert.equal(plan.requiresTemplateInspection, true);
});

test("Test D: HTX Điều lệ -> legal structured route; preserve article/clause numbering; no forced government format", () => {
  const plan = planArtifactWorkflow({
    text: "Soạn dự thảo Điều lệ hợp tác xã nông nghiệp công nghệ cao",
    target: "dieu_le_htx.docx",
    application: "word",
  });
  assert.equal(plan.artifactType, "legal_structured_document");
  assert.equal(plan.fidelity, "strict");
  assert.equal(plan.qa.crossReferenceCheck, true);
  assert.equal(plan.qa.structural, true);
  assert.ok(!plan.sourceOfTruth.some((s) => /Nghị định 30/i.test(s.value)));
});

test("Test E: Generic travel report -> business/general document; no NĐ30", () => {
  const plan = planArtifactWorkflow({
    text: "Lập báo cáo chuyến công tác Đà Nẵng tháng 10",
    target: "bao_cao_cong_tac.docx",
    application: "word",
  });
  assert.equal(plan.artifactType, "business_general_document");
  assert.equal(plan.fidelity, "standard");
  assert.ok(!plan.sourceOfTruth.some((s) => /Nghị định 30/i.test(s.value)));
  assert.ok(!plan.recommendedSkills.includes("skill-chinh-sua-format-van-ban"));
});

test("Test F: Existing Word 'sửa đoạn này' -> existing_document_edit; preserve artifact; no rebuild", () => {
  const plan = planArtifactWorkflow({
    text: "sửa đoạn 2 trong tài liệu thành thông tin cập nhật mới",
    existingPath: "D:\\Docs\\ke_hoach.docx",
    operation: "edit",
    application: "word",
  });
  assert.equal(plan.editingMode, "existing_document_edit");
  assert.equal(plan.preserveExistingArtifact, true);
  assert.notEqual(plan.editingMode, "create_structured");
  assert.notEqual(plan.editingMode, "reconstruct_layout");
  assert.notEqual(plan.editingMode, "quick_create");
});

test("Test G: Statutory form -> form_fill_preserve; mandatory form outranks general admin style", () => {
  const plan = planArtifactWorkflow({
    text: "Điền mẫu số 01/ĐK-TCT theo thông tư 105 cho doanh nghiệp",
    target: "to_khai_01.docx",
    application: "word",
  });
  assert.equal(plan.artifactType, "form_fill");
  assert.equal(plan.editingMode, "form_fill_preserve");
  assert.equal(plan.fidelity, "strict");
  const p2 = plan.sourceOfTruth.find((s) => s.priority === 2);
  assert.ok(p2);
  assert.equal(p2.kind, "mandatory_regulation_template");
  assert.match(p2.value, /Statutory Form|Biểu mẫu/i);
});

test("Test H: Image/PDF 'chuyển sang Word giống hệt' -> reconstruction + strict + visual comparison", () => {
  const plan = planArtifactWorkflow({
    text: "chuyển scan.pdf sang Word giống hệt ảnh gốc",
    referencePath: "D:\\Scans\\scan.pdf",
    target: "scan_converted.docx",
    application: "word",
  });
  assert.equal(plan.artifactType, "reconstruction");
  assert.equal(plan.editingMode, "reconstruct_layout");
  assert.equal(plan.fidelity, "strict");
  assert.equal(plan.qa.visual, true);
  assert.equal(plan.qa.structural, true);
});

test("Test I: Image/PDF 'chỉ lấy nội dung' -> content_extract_only; no layout reconstruction", () => {
  const plan = planArtifactWorkflow({
    text: "lấy nội dung từ file scan.pdf sang Word chỉ lấy nội dung không cần format",
    referencePath: "D:\\Scans\\scan.pdf",
    target: "extracted_text.docx",
    application: "word",
  });
  assert.equal(plan.artifactType, "reconstruction");
  assert.equal(plan.editingMode, "content_extract_only");
  assert.equal(plan.qa.visual, false);
});

test("Test J: Existing Excel operational template -> spreadsheet_operational_template; preserve formulas/sheets/layout", () => {
  const plan = planArtifactWorkflow({
    text: "cập nhật dữ liệu bảng chấm công tháng 10",
    existingPath: "D:\\HR\\bang_cham_cong.xlsx",
    target: "bang_cham_cong.xlsx",
    application: "excel",
    operation: "edit",
  });
  assert.equal(plan.artifactType, "spreadsheet_operational_template");
  assert.equal(plan.preserveExistingArtifact, true);
  assert.equal(plan.qa.formulaErrorScan, true);
});

test("Test K: Raw survey Excel -> spreadsheet_data; formula/error validation, not template clone", () => {
  const plan = planArtifactWorkflow({
    text: "tổng hợp kết quả khảo sát người dùng ra file excel",
    target: "ket_qua_khao_sat.xlsx",
    application: "excel",
  });
  assert.equal(plan.artifactType, "spreadsheet_data");
  assert.notEqual(plan.editingMode, "template_clone_update");
  assert.equal(plan.qa.formulaErrorScan, true);
});

test("Test L: Reference PowerPoint supplied -> presentation_template + visual QA", () => {
  const plan = planArtifactWorkflow({
    text: "tạo slide giới thiệu dự án theo mẫu slide này",
    referencePath: "D:\\Decks\\company_master_deck.pptx",
    target: "project_pitch.pptx",
    application: "powerpoint",
  });
  assert.equal(plan.artifactType, "presentation_template");
  assert.equal(plan.editingMode, "template_clone_update");
  assert.equal(plan.fidelity, "strict");
  assert.equal(plan.qa.visual, true);
  assert.equal(plan.requiresTemplateInspection, true);
});

test("Test M: Plain PowerPoint request without template -> presentation_general", () => {
  const plan = planArtifactWorkflow({
    text: "tạo bài thuyết trình về ứng dụng AI trong nông nghiệp",
    target: "ai_agriculture.pptx",
    application: "powerpoint",
  });
  assert.equal(plan.artifactType, "presentation_general");
  assert.equal(plan.qa.visual, false);
});

test("Test N: Ambiguous .docx request -> must NOT default to government/NĐ30", () => {
  const plan = planArtifactWorkflow({
    text: "tạo file summary.docx ghi vài ý chính",
    target: "summary.docx",
    application: "word",
  });
  assert.notEqual(plan.artifactType, "government_document");
  assert.ok(!plan.recommendedSkills.includes("skill-chinh-sua-format-van-ban"));
  assert.ok(!plan.recommendedSkills.includes("vietnam-admin-documents"));
  assert.ok(!plan.sourceOfTruth.some((s) => /Nghị định 30/i.test(s.value)));
});

test("Test O: User template vs generic regulation conflict -> user template precedence is explicit, warning emitted", () => {
  const plan = planArtifactWorkflow({
    text: "soạn công văn theo mẫu riêng của tập đoàn XYZ",
    templatePath: "D:\\Templates\\mau_rieng_XYZ.docx",
    target: "cong_van_XYZ.docx",
    application: "word",
  });
  assert.equal(plan.sourceOfTruth[0].priority, 1);
  assert.equal(plan.sourceOfTruth[0].kind, "user_selected_artifact");
  assert.ok(plan.warnings.some((w) => /User-selected template.*takes precedence over generic administrative regulations/i.test(w)));
});

test("Test P: 'format văn bản này' with low confidence -> inspect/source resolve before destructive reformat", () => {
  const plan = planArtifactWorkflow({
    text: "format văn bản này",
  });
  assert.ok(plan.confidence < 0.7);
  assert.equal(plan.requiresTemplateInspection, true);
  assert.ok(plan.warnings.some((w) => /Low confidence format request.*Inspect existing artifact structure/i.test(w)));
  assert.notEqual(plan.artifactType, "government_document");
});

test("Test Q: Existing file edit must not choose quick_create", () => {
  const plan = planArtifactWorkflow({
    text: "thêm ghi chú nhanh vào cuối file",
    existingPath: "D:\\Docs\\notes.txt",
    operation: "edit",
  });
  assert.notEqual(plan.editingMode, "quick_create");
  assert.equal(plan.editingMode, "existing_document_edit");
  assert.equal(plan.preserveExistingArtifact, true);
});

test("Test R: Planner remains read-only and cannot alter authorization/risk gates", () => {
  const planner = createPlanner();
  const executionPlan = planner.plan({
    intent: {
      domain: "office",
      operation: "edit",
      target: "D:\\Docs\\official_report.docx",
      application: "word",
      description: "Soạn công văn gửi UBND",
    },
    capabilities: mockCapabilities(),
  });
  assert.equal(executionPlan.executesActions, false);
  assert.equal(executionPlan.grantsAuthorization, false);
  assert.equal(executionPlan.artifact.artifactType, "government_document");
  assert.equal(executionPlan.artifactPlan.artifactType, "government_document");
  assert.equal(executionPlan.safety.authorizationStillEnforcedByActionTool, true);
});

test("Artifact Intelligence benchmark: 50 warmup + 500 measured plans achieve mean < 2ms", () => {
  const samples = [
    { text: "Soạn công văn gửi UBND tỉnh", target: "cv.docx", application: "word" },
    { text: "Khóa luận tốt nghiệp NEU", target: "kltn.docx", application: "word" },
    { text: "Báo cáo CMC giống hệt file 2025 FINAL", referencePath: "ref.docx", target: "out.docx" },
    { text: "Soạn Điều lệ hợp tác xã nông nghiệp", target: "dieu_le.docx" },
    { text: "Báo cáo chuyến công tác", target: "trip.docx" },
    { text: "cập nhật dữ liệu bảng chấm công tháng 10", existingPath: "cc.xlsx", application: "excel", operation: "edit" },
    { text: "chuyển scan.pdf sang Word giống hệt ảnh gốc", referencePath: "scan.pdf", target: "out.docx" },
    { text: "tạo bài thuyết trình về AI", target: "ai.pptx", application: "powerpoint" },
  ];

  // Warmup
  for (let i = 0; i < 50; i++) {
    planArtifactWorkflow(samples[i % samples.length]);
  }

  // Measured
  const iterations = 500;
  const durations = [];
  for (let i = 0; i < iterations; i++) {
    const input = samples[i % samples.length];
    const t0 = process.hrtime.bigint();
    planArtifactWorkflow(input);
    const t1 = process.hrtime.bigint();
    durations.push(Number(t1 - t0) / 1_000_000); // ms
  }

  durations.sort((a, b) => a - b);
  const sum = durations.reduce((acc, d) => acc + d, 0);
  const mean = sum / durations.length;
  const p50 = durations[Math.floor(durations.length * 0.5)];
  const p95 = durations[Math.floor(durations.length * 0.95)];
  const p99 = durations[Math.floor(durations.length * 0.99)];

  console.log(`BENCHMARK ARTIFACT PLAN: mean=${mean.toFixed(4)}ms, p50=${p50.toFixed(4)}ms, p95=${p95.toFixed(4)}ms, p99=${p99.toFixed(4)}ms`);
  assert.ok(mean < 2.0, `Mean latency ${mean.toFixed(4)}ms must be < 2.0ms`);
  assert.ok(p95 < 2.0, `p95 latency ${p95.toFixed(4)}ms must be < 2.0ms`);
});

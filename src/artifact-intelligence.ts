import { extname } from "node:path";

export type ArtifactType =
  | "government_document"
  | "academic_thesis"
  | "corporate_template_report"
  | "legal_structured_document"
  | "business_general_document"
  | "form_fill"
  | "existing_document_edit"
  | "reconstruction"
  | "spreadsheet_data"
  | "spreadsheet_operational_template"
  | "spreadsheet_dashboard"
  | "presentation_template"
  | "presentation_general"
  | "quick_draft"
  | "unknown";

export type EditingMode =
  | "create_structured"
  | "template_clone_update"
  | "existing_document_edit"
  | "form_fill_preserve"
  | "reconstruct_layout"
  | "content_extract_only"
  | "quick_create";

export type FidelityLevel = "fast" | "standard" | "strict";

export type SourceOfTruthKind =
  | "user_selected_artifact"
  | "mandatory_regulation_template"
  | "project_confirmed_style"
  | "artifact_type_skill"
  | "harness_generic_default";

export type SourceOfTruthItem = {
  kind: SourceOfTruthKind;
  value: string;
  priority: number;
  rationale: string;
};

export type ArtifactPlan = {
  schemaVersion: 1;
  artifactType: ArtifactType;
  confidence: number;
  evidence: string[];
  editingMode: EditingMode;
  fidelity: FidelityLevel;
  sourceOfTruth: SourceOfTruthItem[];
  recommendedSkills: string[];
  preserveExistingArtifact: boolean;
  requiresTemplateInspection: boolean;
  requiresLegalSourceResolution: boolean;
  qa: {
    structural: boolean;
    visual: boolean;
    templateDiff: boolean;
    formulaErrorScan: boolean;
    citationCheck: boolean;
    crossReferenceCheck: boolean;
  };
  warnings: string[];
};

export type ArtifactPlanInput = {
  text?: string;
  target?: string;
  referencePath?: string;
  templatePath?: string;
  existingPath?: string;
  application?: "word" | "excel" | "powerpoint" | "outlook" | string;
  operation?: string;
  projectHint?: string;
  explicitFidelity?: FidelityLevel;
  explicitEditingMode?: EditingMode;
  explicitArtifactType?: ArtifactType;
};

const GOVERNMENT_PATTERNS = [
  /(công văn|cong van)/i,
  /(tờ trình|to trinh)/i,
  /(quyết định|quyet dinh)/i,
  /(nghị quyết|nghi quyet)/i,
  /(chỉ thị|chi thi)/i,
  /(thông tri|thong tri)/i,
  /(thông báo|thong bao)/i,
  /(giấy mời|giay moi|giấy triệu tập|giay trieu tap)/i,
  /(nghị định 30|nghi dinh 30|nđ30|nd30|30\/2020\/nđ-cp|30\/2020\/nd-cp)/i,
  /(ubnd|hđnd|hdnd|hội đồng nhân dân|ủy ban nhân dân|uy ban nhan dan)/i,
  /(phòng văn hóa|phong van hoa|sở |ban chỉ đạo|ban chi dao|cơ quan nhà nước|co quan nha nuoc)/i,
  /(thể thức văn bản|the thuc van ban|văn bản hành chính|van ban hanh chinh|soạn công văn|soan cong van)/i,
];

const ACADEMIC_PATTERNS = [
  /(khóa luận|khoá luận|khoa luan|luận văn|luan van|luận án|luan an)/i,
  /(tiểu luận|tieu luan|đồ án tốt nghiệp|do an tot nghiep|kltn)/i,
  /(neu|khtn|bách khoa|bach khoa|kinh tế quốc dân|kinh te quoc dan)/i,
  /(dissertation|master thesis|bachelor thesis|doctoral thesis)/i,
  /(giáo viên hướng dẫn|gvhd|tài liệu tham khảo|trích dẫn|danh mục hình vẽ|danh mục bảng biểu)/i,
];

const CORPORATE_TEMPLATE_PATTERNS = [
  /(giống hệt file|giong het file|y hệt file|y het file|y hệt template|theo mẫu này|theo mau nay)/i,
  /(giống hệt.*(202\d|final|mẫu|template))/i,
  /(corporate report|mẫu báo cáo doanh nghiệp|mẫu báo cáo định kỳ)/i,
  /(cmc report|báo cáo cmc)/i,
];

const LEGAL_STRUCTURED_PATTERNS = [
  /(điều lệ|dieu le)/i,
  /(hợp tác xã|htx)/i,
  /(hợp đồng|hop dong|thỏa thuận|thoa thuan)/i,
  /(quy chế nội bộ|quy che noi bo|qui chế nội bộ)/i,
  /(nghị quyết đại hội đồng cổ đông|quy chế quản trị)/i,
];

const STATUTORY_FORM_PATTERNS = [
  /(mẫu số\s*[:\d\w\/-]+|mau so\s*[:\d\w\/-]+)/i,
  /(mẫu\s*\d+[\w\/-]*)/i,
  /(thông tư\s*\d+|thong tu\s*\d+)/i,
  /(statutory form|biểu mẫu bắt buộc|bieu mau bat buoc|tờ khai|to khai)/i,
];

const RECONSTRUCTION_PATTERNS = [
  /(chuyển|chuyen).*(ảnh|scan|pdf).*(sang|thành).*(word|docx)/i,
  /(ảnh sang word|anh sang word|scan sang word|pdf sang word)/i,
  /(chuyển sang word giống hệt|chuyen sang word giong het)/i,
  /(chuyển sang word chỉ lấy nội dung|lấy nội dung từ file scan|lấy nội dung từ file pdf)/i,
  /(reconstruct|layout reconstruction)/i,
];

const EXTRACTION_ONLY_PATTERNS = [
  /(chỉ lấy nội dung|chi lay noi dung|chỉ extract|chi extract|chỉ lấy text|chi lay text)/i,
  /(content[- ]only|extract[- ]only)/i,
  /(không cần format|khong can format|không cần layout|khong can layout)/i,
];

const QUICK_DRAFT_PATTERNS = [
  /(ghi chú nhanh|ghi chu nhanh|viết nháp|viet nhap|quick draft|viết draft|draft|tạo file nháp)/i,
  /(ghi vài ý|vài ý chính|take notes|note nhanh)/i,
];

const BUSINESS_GENERAL_PATTERNS = [
  /(báo cáo chuyến công tác|bao cao chuyen cong tac|travel expense|travel report|business trip)/i,
  /(báo cáo tuần|bao cao tuan|báo cáo tiến độ|bao cao tien do|kế hoạch tuần|ke hoach tuan)/i,
  /(biên bản cuộc họp nội bộ|meeting minutes|thông báo nội bộ|thong bao noi bo)/i,
];

export function planArtifactWorkflow(input: ArtifactPlanInput): ArtifactPlan {
  const text = (input.text || "").trim();
  const target = (input.target || "").trim();
  const ext = extname(target).toLowerCase();
  const existingPath = (input.existingPath || "").trim();
  const templatePath = (input.templatePath || "").trim();
  const referencePath = (input.referencePath || "").trim();
  const operation = (input.operation || "").toLowerCase().trim();
  const application = (input.application || "").toLowerCase().trim();

  const evidence: string[] = [];
  const warnings: string[] = [];

  const hasExistingFile = Boolean(existingPath || (target && (operation === "edit" || operation === "modify")));
  const hasTemplateOrRef = Boolean(templatePath || referencePath);

  let artifactType: ArtifactType = "unknown";
  let confidence = 0.5;
  let editingMode: EditingMode = "create_structured";
  let fidelity: FidelityLevel = "standard";

  // Check explicit overrides first if provided
  if (input.explicitArtifactType) {
    artifactType = input.explicitArtifactType;
    confidence = 1.0;
    evidence.push(`explicit_artifact_type:${artifactType}`);
  }

  // 1. Check Reconstruction (Image/PDF -> Word)
  const isScanOrPdfSource = referencePath && /\.(pdf|png|jpe?g|bmp|tiff)$/i.test(referencePath);
  const textMatchesReconstruction = RECONSTRUCTION_PATTERNS.some((p) => p.test(text));
  if (artifactType === "unknown" && (textMatchesReconstruction || (isScanOrPdfSource && (ext === ".docx" || application === "word")))) {
    artifactType = "reconstruction";
    confidence = 0.92;
    evidence.push("signal:reconstruction_from_visual_or_pdf");

    if (EXTRACTION_ONLY_PATTERNS.some((p) => p.test(text))) {
      editingMode = "content_extract_only";
      fidelity = "fast";
      evidence.push("mode:content_extract_only");
    } else {
      editingMode = "reconstruct_layout";
      fidelity = "strict";
      evidence.push("mode:reconstruct_layout");
    }
  }

  // 2. Check Spreadsheets (Excel)
  if (artifactType === "unknown" && (application === "excel" || ext === ".xlsx" || ext === ".xls" || ext === ".csv" || /\b(excel|bảng tính|bang tinh|spreadsheet)\b/i.test(text))) {
    evidence.push("app:excel_domain");
    if (/(dashboard|kpi|báo cáo trực quan|biểu đồ|bieu do)/i.test(text)) {
      artifactType = "spreadsheet_dashboard";
      editingMode = hasExistingFile ? "existing_document_edit" : "create_structured";
      fidelity = "strict";
      confidence = 0.88;
      evidence.push("signal:spreadsheet_dashboard");
    } else if (
      /(chấm công|cham cong|bảng lương|bang luong|phiếu thu|phieu thu|phiếu chi|phieu chi|sổ quỹ|so quy|dự toán|du toan|ngân sách|ngan sach|mẫu biểu|mẫu tính)/i.test(text) ||
      (hasExistingFile && !/(khảo sát|khao sat|survey|raw|thô|tho)/i.test(text))
    ) {
      artifactType = "spreadsheet_operational_template";
      editingMode = hasExistingFile ? "existing_document_edit" : hasTemplateOrRef ? "template_clone_update" : "create_structured";
      fidelity = "strict";
      confidence = 0.9;
      evidence.push("signal:spreadsheet_operational_template");
    } else {
      artifactType = "spreadsheet_data";
      editingMode = hasExistingFile ? "existing_document_edit" : "create_structured";
      fidelity = "standard";
      confidence = 0.85;
      evidence.push("signal:spreadsheet_data_aggregation");
    }
  }

  // 3. Check Presentations (PowerPoint)
  if (artifactType === "unknown" && (application === "powerpoint" || ext === ".pptx" || ext === ".ppt" || /(powerpoint|slide|thuyết trình|thuyet trinh|presentation)/i.test(text))) {
    evidence.push("app:powerpoint_domain");
    if (hasTemplateOrRef || /(mẫu slide|template slide|giống slide|slide mẫu|theo mẫu|reference deck)/i.test(text)) {
      artifactType = "presentation_template";
      editingMode = "template_clone_update";
      fidelity = "strict";
      confidence = 0.9;
      evidence.push("signal:presentation_template_reference");
    } else {
      artifactType = "presentation_general";
      editingMode = hasExistingFile ? "existing_document_edit" : "create_structured";
      fidelity = "standard";
      confidence = 0.85;
      evidence.push("signal:presentation_general");
    }
  }

  // 4. Check Academic Thesis
  if (artifactType === "unknown" && ACADEMIC_PATTERNS.some((p) => p.test(text))) {
    artifactType = "academic_thesis";
    editingMode = hasExistingFile ? "existing_document_edit" : "create_structured";
    fidelity = "strict";
    confidence = 0.95;
    evidence.push("signal:academic_thesis_or_dissertation");
  }

  // 5. Check Corporate Template Report
  if (artifactType === "unknown" && (CORPORATE_TEMPLATE_PATTERNS.some((p) => p.test(text)) || (hasTemplateOrRef && /(báo cáo|report)/i.test(text)))) {
    artifactType = "corporate_template_report";
    editingMode = "template_clone_update";
    fidelity = "strict";
    confidence = 0.92;
    evidence.push("signal:corporate_template_report");
  }

  // 6. Check Statutory Forms / Form Fill
  if (artifactType === "unknown" && STATUTORY_FORM_PATTERNS.some((p) => p.test(text))) {
    artifactType = "form_fill";
    editingMode = "form_fill_preserve";
    fidelity = "strict";
    confidence = 0.92;
    evidence.push("signal:statutory_form_fill");
  }

  // 7. Check Legal Structured Document
  if (artifactType === "unknown" && LEGAL_STRUCTURED_PATTERNS.some((p) => p.test(text))) {
    artifactType = "legal_structured_document";
    editingMode = hasExistingFile ? "existing_document_edit" : "create_structured";
    fidelity = "strict";
    confidence = 0.9;
    evidence.push("signal:legal_structured_document");
  }

  // Internal HTX/corporate formal acts are legal documents, but their requested
  // administrative presentation must not be lost to earlier legal classification.
  // NĐ30 is not assumed to bind every HTX document: resolve scope/template first.
  const explicitNd30Format = /(nghị định\s*30|nghi dinh\s*30|nđ\s*30|nd30|30\/2020\/nđ-cp|30\/2020\/nd-cp)/i.test(text);
  const formalInternalAct = /(hợp tác xã|\bhtx\b|cooperative)/i.test(text)
    && /(quyết định|quyet dinh|giấy ủy quyền|giay uy quyen|nghị quyết|nghi quyet|công văn|cong van)/i.test(text)
    && !/(chỉ đọc|chi doc|chỉ tìm|chi tim)/i.test(text);
  const needsAdministrativeFormatGate = explicitNd30Format || formalInternalAct;

  // 8. Check Government Document (requires positive signals!)
  if (artifactType === "unknown" && GOVERNMENT_PATTERNS.some((p) => p.test(text))) {
    artifactType = "government_document";
    editingMode = hasExistingFile ? "existing_document_edit" : "create_structured";
    fidelity = "strict";
    confidence = 0.95;
    evidence.push("signal:vietnamese_administrative_government_document");
  }

  // 9. Check Business General Document
  if (artifactType === "unknown" && BUSINESS_GENERAL_PATTERNS.some((p) => p.test(text))) {
    artifactType = "business_general_document";
    editingMode = hasExistingFile ? "existing_document_edit" : "create_structured";
    fidelity = "standard";
    confidence = 0.88;
    evidence.push("signal:business_general_document");
  }

  // 10. Check Quick Draft
  if (artifactType === "unknown" && QUICK_DRAFT_PATTERNS.some((p) => p.test(text))) {
    artifactType = "quick_draft";
    editingMode = "quick_create";
    fidelity = "fast";
    confidence = 0.85;
    evidence.push("signal:quick_draft");
  }

  // 11. Check Existing Document Edit
  if (
    hasExistingFile ||
    operation === "edit" ||
    /(sửa đoạn|sua doan|chỉnh lại|chinh lai|thay đổi đoạn|cập nhật đoạn|edit paragraph|sửa câu|sua cau)/i.test(text)
  ) {
    if (artifactType === "unknown") {
      artifactType = "existing_document_edit";
      confidence = 0.8;
      evidence.push("signal:existing_document_edit_fallback");
    }
    // Hard rule: EDIT != REBUILD. Default to existing_document_edit unless form_fill or reconstruction
    if (editingMode !== "form_fill_preserve" && editingMode !== "reconstruct_layout" && editingMode !== "content_extract_only") {
      editingMode = "existing_document_edit";
      evidence.push("hard_rule:edit_does_not_rebuild");
    }
  }

  // 12. Soft Fallback for Ambiguous .docx or Unrecognized Requests
  if (artifactType === "unknown") {
    confidence = 0.5;
    if (/(format văn bản|format file|sửa format|chuẩn hóa format)/i.test(text)) {
      editingMode = hasExistingFile ? "existing_document_edit" : "create_structured";
      fidelity = "standard";
      evidence.push("ambiguous:format_request_without_domain_context");
      warnings.push("Low confidence format request. Inspect existing artifact structure and resolve governing source before applying formatting; do not default to generic administrative/NĐ30 rules.");
    } else {
      artifactType = "business_general_document";
      editingMode = hasExistingFile ? "existing_document_edit" : "quick_create";
      fidelity = "standard";
      evidence.push("fail_soft:general_business_fallback_never_default_government");
    }
  }

  // Enforcement of hard rules:
  // Hard Rule 1: Existing file edit must never choose quick_create!
  if (hasExistingFile && editingMode === "quick_create") {
    editingMode = "existing_document_edit";
    evidence.push("hard_rule:existing_file_never_quick_create");
  }

  // Hard Rule 2: Explicit editing mode / fidelity overrides
  if (input.explicitEditingMode) {
    editingMode = input.explicitEditingMode;
    evidence.push(`explicit_editing_mode:${editingMode}`);
  }
  if (input.explicitFidelity) {
    fidelity = input.explicitFidelity;
    evidence.push(`explicit_fidelity:${fidelity}`);
  }

  // Resolve Source of Truth Precedence
  const sourceOfTruth: SourceOfTruthItem[] = [];

  // P1: User-selected existing file/template/reference artifact
  if (hasTemplateOrRef || hasExistingFile) {
    const val = templatePath || referencePath || existingPath || target || "user-selected-artifact";
    sourceOfTruth.push({
      kind: "user_selected_artifact",
      value: val,
      priority: 1,
      rationale: "User-selected existing file, template, or reference artifact has supreme precedence over general rules.",
    });
  }

  // P2: Mandatory official regulation/template directly governing the artifact
  if (artifactType === "government_document") {
    sourceOfTruth.push({
      kind: "mandatory_regulation_template",
      value: "Nghị định 30/2020/NĐ-CP (hoặc quy định hành chính chuyên ngành trực tiếp)",
      priority: 2,
      rationale: "Official Vietnamese administrative regulations directly govern administrative document structure.",
    });
  } else if (artifactType === "form_fill") {
    sourceOfTruth.push({
      kind: "mandatory_regulation_template",
      value: "Biểu mẫu quy định trực tiếp (Statutory Form)",
      priority: 2,
      rationale: "Statutory mandatory form outranks general administrative styling.",
    });
  } else if (artifactType === "academic_thesis") {
    sourceOfTruth.push({
      kind: "mandatory_regulation_template",
      value: "Quy định trình bày luận văn/khóa luận của cơ sở đào tạo",
      priority: 2,
      rationale: "Institution-specific thesis formatting guidelines govern structure, numbering, TOC, and citations.",
    });
  }

  // P3: Confirmed project-specific style/template/rules
  if (input.projectHint) {
    sourceOfTruth.push({
      kind: "project_confirmed_style",
      value: input.projectHint,
      priority: 3,
      rationale: "Confirmed project-specific style rules and historical preferences.",
    });
  }

  // P4: Artifact-type skill / default workflow
  let primarySkill = "word-professional";
  let recommendedSkills: string[] = [];

  switch (artifactType) {
    case "government_document":
      primarySkill = "viet-admin-format-checker";
      recommendedSkills = ["viet-admin-format-checker", "vietnam-admin-documents"];
      break;
    case "academic_thesis":
      primarySkill = "word-professional";
      recommendedSkills = ["word-professional", "office-legal-reference-pack"];
      break;
    case "corporate_template_report":
      primarySkill = "office-template-library";
      recommendedSkills = ["office-template-library", "word-professional"];
      break;
    case "legal_structured_document":
      primarySkill = "office-legal-reference-pack";
      recommendedSkills = ["office-legal-reference-pack", "word-professional"];
      break;
    case "business_general_document":
    case "existing_document_edit":
      primarySkill = "word-professional";
      recommendedSkills = ["office-reporting-pack", "word-professional"];
      break;
    case "form_fill":
      primarySkill = "office-word-writer";
      recommendedSkills = ["office-word-writer", "office-template-library"];
      break;
    case "reconstruction":
      primarySkill = "pdf-layout-pymupdf4llm";
      recommendedSkills = ["pdf-layout-pymupdf4llm", "office-scan-ocr-intake", "word-professional"];
      break;
    case "spreadsheet_operational_template":
    case "spreadsheet_dashboard":
    case "spreadsheet_data":
      primarySkill = "excel-professional";
      recommendedSkills = ["excel-professional", "data-analytics-duckdb"];
      break;
    case "presentation_template":
    case "presentation_general":
      primarySkill = "slide-design";
      recommendedSkills = ["slide-design", "presentation-skill", "pptx-template-engine"];
      break;
    case "quick_draft":
    default:
      primarySkill = "word-professional";
      recommendedSkills = ["word-professional"];
      break;
  }

  // Keep the law/specialized form first, but make formatting skill + QA mandatory
  // for any formal cooperative decision/authorization and explicit NĐ30 requests.
  if (needsAdministrativeFormatGate &&
      (artifactType === "legal_structured_document" || artifactType === "government_document" || artifactType === "existing_document_edit")) {
    recommendedSkills = ["viet-admin-format-checker", ...recommendedSkills.filter(s => s !== "viet-admin-format-checker")];
    fidelity = "strict";
    evidence.push("hard_gate:admin_format_resolve_and_audit");
    warnings.push("FINALIZE VIA office_admin_release_prepare → office_admin_release_view_page (EVERY page) → office_admin_release_review (ALL rendered pages) → office_admin_release_preview → office_admin_release_apply. All other DOCX writing is DRAFT ONLY. FINAL DOCX QUALITY GATE: activate viet-admin-format-checker; resolve scope/template; run independent structural DOCX audit and visual QA. Python/Word COM creation does not bypass QA. If either receipt is unavailable, report draft/unverified, not completed.");
    if (artifactType === "legal_structured_document")
      warnings.push("HTX internal documents are not automatically within NĐ30 legal scope; use requested administrative presentation only after specialist/charter resolution.");
  }
  if (explicitNd30Format && artifactType === "legal_structured_document") {
    sourceOfTruth.push({
      kind: "project_confirmed_style",
      value: "NĐ30 administrative presentation requested; subject to statutory form and HTX charter priority",
      priority: 3,
      rationale: "Explicit formatting standard chosen by user, not a claim of direct statutory applicability to HTX.",
    });
  }

  sourceOfTruth.push({
    kind: "artifact_type_skill",
    value: primarySkill,
    priority: 4,
    rationale: `Workflow and domain rules supplied by ${primarySkill}.`,
  });

  // P5: Harness generic default styling
  sourceOfTruth.push({
    kind: "harness_generic_default",
    value: "harness-generic-office-style",
    priority: 5,
    rationale: "Default fallback workstation styling when no higher tier provides explicit rules.",
  });

  // Conflict detection: User template vs generic regulation
  if (hasTemplateOrRef && artifactType === "government_document") {
    warnings.push("User-selected template/reference artifact takes precedence over generic administrative regulations (NĐ 30/2020/NĐ-CP). Specialized template rules will govern.");
  }
  if (artifactType === "government_document" && fidelity === "strict") {
    warnings.push("Plain-text to generic DOCX SaveAs is forbidden as final production path for strict government documents. Use Word Live transaction or specialized template.");
  }

  const preserveExistingArtifact = hasExistingFile || editingMode === "existing_document_edit" || editingMode === "form_fill_preserve";
  const requiresTemplateInspection = hasTemplateOrRef || editingMode === "template_clone_update" || artifactType === "corporate_template_report" || artifactType === "presentation_template" || confidence < 0.7;
  const requiresLegalSourceResolution = artifactType === "government_document" || artifactType === "form_fill" || artifactType === "legal_structured_document";

  const qa = {
    structural: fidelity === "strict" || editingMode === "existing_document_edit" || editingMode === "template_clone_update",
    visual: fidelity === "strict" && (needsAdministrativeFormatGate || artifactType === "government_document" || artifactType === "reconstruction" || artifactType === "presentation_template" || artifactType === "corporate_template_report" || artifactType === "spreadsheet_dashboard" || editingMode === "reconstruct_layout"),
    templateDiff: editingMode === "template_clone_update" || editingMode === "form_fill_preserve" || artifactType === "corporate_template_report",
    formulaErrorScan: artifactType === "spreadsheet_data" || artifactType === "spreadsheet_operational_template" || artifactType === "spreadsheet_dashboard",
    citationCheck: artifactType === "academic_thesis",
    crossReferenceCheck: artifactType === "legal_structured_document" || artifactType === "academic_thesis" || artifactType === "government_document",
  };

  return {
    schemaVersion: 1,
    artifactType,
    confidence,
    evidence,
    editingMode,
    fidelity,
    sourceOfTruth,
    recommendedSkills,
    preserveExistingArtifact,
    requiresTemplateInspection,
    requiresLegalSourceResolution,
    qa,
    warnings,
  };
}


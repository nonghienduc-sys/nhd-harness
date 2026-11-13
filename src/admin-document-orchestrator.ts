/**
 * NHD Vietnamese administrative-document pipeline.
 * Stages are driven by registered skills; actual Office/MCP mutations are supplied by
 * an adapter and MUST go through NHD Safety/lease/version controls.
 * This module NEVER submits, signs, stamps, or issues an official document.
 */
export type AdminDocumentType = "cong_van" | "bao_cao" | "ke_hoach" | "to_trinh" | "quyet_dinh" | "thong_bao";
export type AdminPipelinePhase =
  | "intake" | "legal_resolve" | "draft" | "template" | "format"
  | "structural_qa" | "visual_qa" | "human_review";

export interface AdminDocumentRequest {
  docType: AdminDocumentType;
  subject: string;
  documentId: string;
  agency?: string;
  requiresSpecializedTemplate?: boolean;
  mandatoryTemplateRef?: string;
  sourceReferences?: string[];
  sourceIsScan?: boolean;
  currentDocumentVersion?: string;
  expectedTextHash?: string;
  confidential?: boolean;
}
export interface RegistryEntry {
  id: string;
  enabled: boolean;
  type: "executable_skill" | "resource_pack";
}
export interface AdminSkillRegistry {
  schemaVersion: number;
  routing: {
    canonicalAdminFormatter: string;
    disabledLegacyIds: string[];
    legacyAlias: Record<string,string>;
  };
  skills: RegistryEntry[];
}
export interface DocumentTypeProfile {
  heading: string;
  requiredSemanticBlocks: readonly string[];
  optionalSemanticBlocks: readonly string[];
}
export const ADMIN_DOCUMENT_PROFILES: Readonly<Record<AdminDocumentType,DocumentTypeProfile>> = {
  cong_van: {heading:"CÔNG VĂN",requiredSemanticBlocks:["quoc_hieu","tieu_ngu","co_quan","so_ky_hieu","dia_danh_ngay","trich_yeu_vv","kinh_gui","noi_dung","khoi_ky","noi_nhan"],optionalSemanticBlocks:["can_cu","phu_luc"]},
  bao_cao: {heading:"BÁO CÁO",requiredSemanticBlocks:["quoc_hieu","tieu_ngu","co_quan","so_ky_hieu","dia_danh_ngay","ten_loai","trich_yeu","ket_qua","danh_gia","kien_nghi","khoi_ky","noi_nhan"],optionalSemanticBlocks:["bang_bieu","phu_luc"]},
  ke_hoach: {heading:"KẾ HOẠCH",requiredSemanticBlocks:["quoc_hieu","tieu_ngu","co_quan","so_ky_hieu","dia_danh_ngay","ten_loai","trich_yeu","muc_dich_yeu_cau","noi_dung","to_chuc_thuc_hien","khoi_ky","noi_nhan"],optionalSemanticBlocks:["tien_do","kinh_phi","phu_luc"]},
  to_trinh: {heading:"TỜ TRÌNH",requiredSemanticBlocks:["quoc_hieu","tieu_ngu","co_quan","so_ky_hieu","dia_danh_ngay","ten_loai","trich_yeu","kinh_gui","co_so_de_xuat","noi_dung_de_nghi","khoi_ky","noi_nhan"],optionalSemanticBlocks:["bang_bieu","phu_luc"]},
  quyet_dinh: {heading:"QUYẾT ĐỊNH",requiredSemanticBlocks:["quoc_hieu","tieu_ngu","co_quan","so_ky_hieu","dia_danh_ngay","ten_loai","trich_yeu","tham_quyen","can_cu","dieu_1","dieu_2","hieu_luc_hoac_thi_hanh","khoi_ky","noi_nhan"],optionalSemanticBlocks:["phu_luc","dieu_3"]},
  thong_bao: {heading:"THÔNG BÁO",requiredSemanticBlocks:["quoc_hieu","tieu_ngu","co_quan","so_ky_hieu","dia_danh_ngay","ten_loai","trich_yeu","noi_dung_thong_bao","khoi_ky","noi_nhan"],optionalSemanticBlocks:["phoi_hop","phu_luc"]},
};
export interface AdminPipelineStage {
  phase: AdminPipelinePhase;
  purpose: string;
  skillIds: string[];
  toolAdapters: string[];
  effects: "read" | "write" | "none";
  requiredReceipt: string[];
  manualOnly?: boolean;
}
export interface AdminPipelinePlan {
  version: "nhd-admin-pipeline-v1";
  request: AdminDocumentRequest;
  profile: DocumentTypeProfile;
  canonicalFormatter: string;
  stages: AdminPipelineStage[];
  pendingHumanActions: string[];
  scopeNote: string;
}
export interface AdminStageReceipt {
  phase: AdminPipelinePhase;
  ok: boolean;
  evidence: Record<string,unknown>;
  artifactPath?: string;
  stepVersion?: string;
}
export interface AdminRuntimeAdapter {
  /** Calls the existing NHD skills_activate action, never a legacy alias directly. */
  activateSkill: (id:string, task:string) => Promise<unknown>;
  /** Calls existing NHD/Hermes tools through a mandatory Safety gateway. */
  executeStep: (step:AdminPipelineStage, req:AdminDocumentRequest, prior:readonly AdminStageReceipt[])=>Promise<AdminStageReceipt>;
  /** Explicit one-step authorization, lease and expected-version binding before ANY write. */
  authorizeWrite: (step:AdminPipelineStage, req:AdminDocumentRequest)=>Promise<{approved:boolean;leaseValid:boolean;versionBound:boolean}>;
}
export interface AdminPipelineOutcome {
  status:"awaiting_human_approval" | "blocked";
  completed: AdminStageReceipt[];
  blockedAt?:AdminPipelinePhase;
  reason?:string;
}

const REQUIRED_FORMATTER = "viet-admin-format-checker";
const LEGACY_FORMATTER = "skill-chinh-sua-format-van-ban";

export function buildAdminDocumentPlan(request:AdminDocumentRequest,registry:AdminSkillRegistry):AdminPipelinePlan {
  if(!ADMIN_DOCUMENT_PROFILES[request.docType]) throw new Error("Unsupported administrative document type");
  if(!request.subject?.trim() || !request.documentId?.trim()) throw new Error("Subject/documentId required");
  if(registry.schemaVersion!==1 || registry.routing.canonicalAdminFormatter!==REQUIRED_FORMATTER)
    throw new Error("Registry/canonical skill mismatch");
  if(!registry.routing.disabledLegacyIds.includes(LEGACY_FORMATTER))
    throw new Error("Legacy formatter must be disabled");
  if(registry.routing.legacyAlias[LEGACY_FORMATTER]!==REQUIRED_FORMATTER)
    throw new Error("Legacy alias must resolve to canonical ID");
  const byId=new Map(registry.skills.map(x=>[x.id,x]));
  if(byId.get(LEGACY_FORMATTER)?.enabled) throw new Error("Legacy formatter still enabled");
  const stages:AdminPipelineStage[] = [
    {phase:"intake",purpose:"Read source documents and extract text; OCR only where needed",skillIds:request.sourceIsScan?["office-scan-ocr-intake"]:[],toolAdapters:["document_qa/index","pdf_document","outlook_read"],effects:"read",requiredReceipt:["intakeRecorded"]},
    {phase:"legal_resolve",purpose:"Classify, resolve authority/mandatory template/specialized rules BEFORE NĐ30 fallback",skillIds:[REQUIRED_FORMATTER,"office-legal-reference-pack"],toolAdapters:["document_qa/index","official_legal_sources"],effects:"read",requiredReceipt:["legalVerified","resolvedSpecId","sourceProvenance"]},
    {phase:"draft",purpose:"Create evidence-grounded draft; do not invent legal bases, number, signer or recipients",skillIds:["vietnam-admin-documents"],toolAdapters:["hermes_microsoft_office","document_qa/index"],effects:"none",requiredReceipt:["draftHash","contentSourcesBound"]},
    {phase:"template",purpose:"Choose confirmed template and create DOCX structure",skillIds:["viet-admin-docx-template-builder"],toolAdapters:["hermes_microsoft_office"],effects:"write",requiredReceipt:["docxPath","templateId","normalizedTextHash"]},
    {phase:"format",purpose:"Apply resolved format with canonical skill; preserve body text",skillIds:[REQUIRED_FORMATTER],toolAdapters:["hermes_microsoft_office","nhd_office_live"],effects:"write",requiredReceipt:["preEditTextHash","postEditTextHash","versionMatched","readBackCompleted"]},
    {phase:"structural_qa",purpose:"Independent DOCX/section/text/rule audit, zero mandatory errors",skillIds:["office-workflow-qa"],toolAdapters:["docx_xml_validator","document_qa/index"],effects:"read",requiredReceipt:["mandatoryErrors","contentUnchanged","qaReportId"]},
    {phase:"visual_qa",purpose:"Render DOCX to PDF and inspect first, overflow/table, final/signature pages",skillIds:[],toolAdapters:["nhd_office_live","pdf_document"],effects:"write",requiredReceipt:["visuallyReviewed","layoutErrors","renderReceiptId"]},
    {phase:"human_review",purpose:"Handoff to authorized staff; NEVER auto sign/stamp/issue/send",skillIds:[],toolAdapters:[],effects:"none",requiredReceipt:[],manualOnly:true},
  ];
  for(const step of stages) for(const id of step.skillIds){
    const skill=byId.get(id);
    if(!skill || skill.type!=="executable_skill" || !skill.enabled)
      throw new Error("Required skill missing or disabled: "+id);
    if(id===LEGACY_FORMATTER)throw new Error("Legacy skill cannot be invoked");
  }
  return {
    version:"nhd-admin-pipeline-v1",request,
    profile:ADMIN_DOCUMENT_PROFILES[request.docType],
    canonicalFormatter:REQUIRED_FORMATTER,
    stages,
    pendingHumanActions:["confirm_final_content_and_authority","approve_or_reject","assign_document_number_by_van_thu","sign_and_seal_or_sign_digitally_in_official_system","issue_via_official_document_management_system"],
    scopeNote:"Workflow contract, NOT legal approval. Mandatory form/specialized regulation takes priority; NĐ30 only where applicable.",
  };
}
function receiptError(step:AdminPipelineStage,r:AdminStageReceipt, request:AdminDocumentRequest):string|null{
  if(!r || !r.ok || r.phase!==step.phase)return "Missing, failed, or mismatched receipt";
  for(const key of step.requiredReceipt)if(r.evidence[key]===undefined || r.evidence[key]===null)return "Missing evidence: "+key;
  if(step.phase==="legal_resolve"){
    if(r.evidence.legalVerified!==true)return "Legal sources not verified";
    if(request.requiresSpecializedTemplate && (!request.mandatoryTemplateRef || r.evidence.templateVerified!==true))
      return "Mandatory specialized template unresolved";
  }
  if(step.phase==="draft" && r.evidence.contentSourcesBound!==true)return "Draft not source-bound";
  if(step.phase==="template" && typeof r.evidence.docxPath!=="string")return "DOCX path missing";
  if(step.phase==="format"){
    if(r.evidence.preEditTextHash!==r.evidence.postEditTextHash)return "Formatter modified text";
    if(r.evidence.versionMatched!==true || r.evidence.readBackCompleted!==true)return "No version/read-back proof";
  }
  if(step.phase==="structural_qa"){
    if(r.evidence.mandatoryErrors!==0 || r.evidence.contentUnchanged!==true)return "Mandatory QA or content-diff failure";
  }
  if(step.phase==="visual_qa"){
    if(r.evidence.visuallyReviewed!==true || r.evidence.layoutErrors!==0)return "Visual QA not proven";
  }
  return null;
}
/** Fail-closed, no automatic retries, no release. Inject tool adapter after host authorization. */
export async function executeAdminDocumentPlan(plan:AdminPipelinePlan,adapter:AdminRuntimeAdapter):Promise<AdminPipelineOutcome>{
  const receipts:AdminStageReceipt[]=[];
  for(const step of plan.stages){
    if(step.manualOnly)return {status:"awaiting_human_approval",completed:receipts};
    if(step.skillIds.includes(LEGACY_FORMATTER) || (step.phase==="format" && !step.skillIds.includes(REQUIRED_FORMATTER)))
      return {status:"blocked",blockedAt:step.phase,completed:receipts,reason:"Unsafe or noncanonical skill route"};
    try{
      for(const id of step.skillIds)await adapter.activateSkill(id,step.purpose);
      if(step.effects==="write"){
        if(!plan.request.currentDocumentVersion?.trim())
          return {status:"blocked",blockedAt:step.phase,completed:receipts,reason:"Missing expected document version"};
        const safety=await adapter.authorizeWrite(step,plan.request);
        if(!safety?.approved || !safety.leaseValid || !safety.versionBound)
          return {status:"blocked",blockedAt:step.phase,completed:receipts,reason:"NHD Safety/lease/version binding denied"};
      }
      const receipt=await adapter.executeStep(step,plan.request,receipts);
      const error=receiptError(step,receipt,plan.request);
      if(error)return {status:"blocked",blockedAt:step.phase,completed:receipts,reason:error};
      if(step.phase==="format"){
        const template=receipts.find(x=>x.phase==="template");
        if(!template || template.evidence.normalizedTextHash!==receipt.evidence.preEditTextHash)
          return {status:"blocked",blockedAt:step.phase,completed:receipts,reason:"Template-to-format text hash mismatch"};
      }
      receipts.push(receipt);
    } catch(e) {
      return {status:"blocked",blockedAt:step.phase,completed:receipts,reason:e instanceof Error?e.message:String(e)};
    }
  }
  return {status:"awaiting_human_approval",completed:receipts};
}

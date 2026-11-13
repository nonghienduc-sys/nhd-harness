// Inventory-backed NHD skill registry. No skill files are modified.
// Usage: node scripts/build-admin-skill-registry.mjs [--check]
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, relative, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const skillRoot = resolve(root, 'skills');
const source = readFileSync(resolve(root, 'src/skills.ts'), 'utf8');
const catalog = [...source.matchAll(/\{\s*id:\s*"([^"]+)",\s*category:\s*"(administration|documents|workflow|data|presentation|media)",\s*readiness:\s*"(ready|enhanced)"\s*\}/g)]
  .map((match) => ({ id: match[1], category: match[2], readiness: match[3] }));
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const S = (capability, inputs, outputs, backend, deps = []) => ({ capability, inputs: inputs.split('|'), outputs: outputs.split('|'), backend: backend.split('|'), recommendedSkillDependencies: deps });
// These are workflow contracts/proposed adapters, NOT claims of direct runtime imports.
// Backend names refer to planned execution adapters; existing skill instructions remain authoritative.
const spec = {
  'commune-office-operations': S('commune_workflow','request|dispatch|local_records','workflow_plan|dossier','orchestrator|document_qa','office-records-tracker'),
  'daily-document-workspace': S('document_workspace','artifact|target_folder','organized_artifact|manifest','filesystem'),
  'document-ingest-markitdown': S('document_ingest','pdf|docx|pptx|xlsx|html','markdown|extracted_text','markitdown|filesystem'),
  'docx-generator': S('docx_generate','structured_sections|template','docx','docx_js|filesystem'),
  'excel-professional': S('excel_edit_audit','spreadsheet|instructions','xlsx|audit_report','excel_live|filesystem'),
  'data-analytics-duckdb': S('dataset_analysis','csv|parquet|json|sql','query_results|data_report','duckdb'),
  'design-taste-frontend': S('frontend_design','design_brief|web_source','web_interface|design_audit','frontend_dev'),
  'web-design-guidelines': S('frontend_qa','web_ui|source_code','audit_report','browser_qa'),
  'design-reference-library': S('design_references','design_brief','design_references','filesystem'),
  'image-to-code': S('image_to_web','reference_image|requirements','web_source','frontend_dev|image_analysis'),
  'playwright-cli': S('browser_testing','web_target|test_plan','browser_report|screenshot','playwright'),
  'message-intake-tasks': S('message_intake','message_thread|minutes','tasks|owners|deadlines','document_qa'),
  'agent-security-regression': S('agent_security_testing','agent_trace|attack_cases','security_test_report','test_runner'),
  'mcp-security-audit': S('mcp_security_audit','mcp_metadata|skill_files','audit_report','filesystem|test_runner'),
  'mcp-trace-evaluation': S('trace_evaluation','tool_trace','metrics|audit_report','telemetry'),
  'scientific-research-workflow': S('research_literature','research_question|paper_ids','source_list|provenance','research_search|document_qa'),
  'semantic-code-navigation': S('code_navigation','source_code|symbol_query','symbol_references','typescript_service'),
  'temporal-knowledge-graph': S('temporal_facts','fact|timestamp|source','fact_history','sqlite'),
  'local-semantic-search': S('document_retrieval','documents|search_query','ranked_passages','local_index'),
  'office-archive-filing-pack': S('office_archive','dossier|retention_rule','archive_index|handover_manifest','filesystem'),
  'office-citizen-intake-pack': S('citizen_intake','citizen_request|evidence','intake_record|checklist','document_qa'),
  'office-email-drafter': S('email_draft','email_thread|instructions','email_draft','outlook_read|llm_draft'),
  'office-legal-reference-pack': S('legal_references','source_documents|legal_query','reference_pack','document_qa|legal_sources'),
  'office-records-tracker': S('office_records','incoming_document|outgoing_document','registry_record','filesystem'),
  'office-reporting-pack': S('office_report','metrics|updates','report_draft','llm_draft|docx'),
  'office-scan-ocr-intake': S('office_ocr','scanned_pdf|image','text|structured_record','pdf_document|ocr'),
  'ocr-vietnamese-paddleocr': S('vietnamese_ocr','scan|image','recognized_text','paddleocr'),
  'office-template-library': S('office_templates','template_brief','reusable_template','filesystem|docx'),
  'office-word-writer': S('word_authoring','draft|outline|template','docx','word_live|docx'),
  'office-workflow-qa': S('office_workflow_qa','document|workflow_state','issues|review_report','document_qa'),
  'pdf': S('pdf_processing','pdf|source_document','pdf|extracted_text|render','pdf_document|pdf_renderer'),
  'pdf-layout-pymupdf4llm': S('pdf_layout_extract','pdf','layout_text|tables','pymupdf4llm'),
  'school-office-pack': S('school_admin','school_record|brief','report|workflow_plan','document_qa'),
  'scientific-research-slide-style': S('scientific_slide_design','research_content|slides','styled_slides','pptx|slide_qa'),
  'slide-design': S('slide_design','presentation|style_brief','pptx|review_report','powerpoint_live|pptx'),
  'knowledge-cat-ppt-skill': S('slide_story_planning','presentation_brief|sources','storyboard|speaker_notes','llm_draft'),
  'presentation-skill': S('presentation_authoring','outline|source_assets','pptx|qa_report','pptx|powerpoint_live'),
  'pptx-template-engine': S('pptx_template_engine','template_deck|content','editable_pptx','pptx'),
  'pptxgenjs-authoring': S('pptx_generate','slide_spec','pptx','pptxgenjs'),
  'transcribe': S('audio_transcription','audio|speaker_hints','transcript|speaker_segments','asr'),
  'video-understanding': S('video_analysis','video|url','timeline|summary','video_tools|asr'),
  'media-source-hunter': S('media_discovery','query|storyboard|license_constraints','asset_candidates|rights_review','media_source_discover|media_source_status'),
  'natural-cinematic-media': S('cinematic_media_prompt','creative_brief','media_prompt|qa_report','image_video_prompting'),
  'viet-admin-docx-template-builder': S('admin_template_build','doc_type|rules|fields','docx_template','docx|word_live',['viet-admin-format-checker']),
  'viet-admin-format-checker': S('admin_format_canonical','document|doc_type|legal_sources','resolved_spec|format_audit','document_qa|word_live|docx|pdf_document'),
  'viet-admin-template-library': S('admin_template_library','doc_type|official_template','template_reference','filesystem|docx',['viet-admin-format-checker']),
  'vietnam-admin-documents': S('admin_document_draft','brief|references|doc_type','administrative_draft','llm_draft|docx',['viet-admin-format-checker']),
  'viet-state-document-processing': S('admin_incoming_document_workflow','incoming_document|parent_documents|receiver_role','review_report|gated_draft_docx','pdf_document|docx|terminal|admin_release_gate',['viet-admin-format-checker','vietnam-admin-documents']),
  'word-professional': S('word_advanced','docx|template|edit_request','docx|qa_report','word_live|docx'),
  'vbi-macro-commodity-writer': S('finance_article','economic_sources|brief','article_draft','llm_draft'),
  'skill-chinh-sua-format-van-ban': S('admin_format_legacy','document|doc_type|legal_sources','format_audit','none_disabled')
};

const entries = [];
const cfgPath = 'C:\\ProgramData\\ChatGPTWorkstationBridge\\config.json';
const config = existsSync(cfgPath) ? JSON.parse(readFileSync(cfgPath, 'utf8')) : {};
const disabled = new Set([...(config.disabledSkills ?? []), 'skill-chinh-sua-format-van-ban']);
const registered = new Map(catalog.map((s) => [s.id, s]));
const dirs = readdirSync(skillRoot, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
// Không đếm cache Python và thư mục có tệp đánh dấu .local-only (tài sản chỉ có trên máy, không phân phối công khai).
const recursivelyCountFiles = (dir) => existsSync(join(dir,'.local-only')) ? 0 : readdirSync(dir, {withFileTypes:true}).reduce((n,e) => n + (e.isDirectory() ? (e.name==='__pycache__' ? 0 : recursivelyCountFiles(join(dir,e.name))) : (e.isFile() && !e.name.endsWith('.pyc'))?1:0),0);
for(const id of dirs){
  const meta = registered.get(id);
  const skillPath = resolve(skillRoot,id,'SKILL.md');
  const hasSkill = existsSync(skillPath);
  const text = hasSkill ? readFileSync(skillPath,'utf8').replace(/^\uFEFF/,'') : '';
  const name = text.match(/^name:\s*["']?(.+?)["']?\s*$/m)?.[1]?.replace(/^["']|["']$/g,'') ?? id;
  const description = text.match(/^description:\s*["']?(.+?)["']?\s*$/m)?.[1]?.replace(/^["']|["']$/g,'') ?? '';
  const p = spec[id] ?? S('unclassified_reference','reference','reference','filesystem');
  entries.push({
    id,displayName:name,description,
    registration:meta ? 'nhd_skill_catalog' : 'filesystem_only',
    type:hasSkill?'executable_skill':'resource_pack',
    category:meta?.category ?? 'workflow',
    readiness:meta?.readiness ?? 'not_registered',
    enabled:!!(meta && hasSkill && !disabled.has(id)),
    capability:p.capability,
    io:{inputs:p.inputs,outputs:p.outputs},
    dependencies:{recommendedSkills:p.recommendedSkillDependencies,hardRuntimeDependencies:[]},
    backend:{recommendedAdapters:p.backend,verifiedExecutable:false},
    instructionFile:hasSkill?relative(root,skillPath).replaceAll('\\','/') : null,
    instructionSha256:hasSkill?sha256(readFileSync(skillPath)):null,
    fileCount:recursivelyCountFiles(resolve(skillRoot,id)),
    classificationProvenance:'curated_from_skill_description_and_inventory',
  });
}
const missingInFilesystem=catalog.map(s=>s.id).filter(id=>!dirs.includes(id));
const missingInSpec=entries.filter(s=>s.type==='executable_skill' && !spec[s.id]).map(s=>s.id);
if(missingInFilesystem.length || missingInSpec.length){throw new Error(JSON.stringify({missingInFilesystem,missingInSpec}));}
if(entries.filter(x=>x.enabled && x.capability==='admin_format_legacy').length){throw new Error('Legacy formatter must not be executable');}
const registry = {
 schemaVersion:1,inventoryScope:'D:/ChatGPT-Workstation-MCP/skills',
 requestedHistoricalSkillCount:52,
 inventory:{registeredSkillCount:catalog.length,physicalFolderCount:dirs.length,executableSkillFiles:entries.filter(s=>s.type==='executable_skill').length,enabledSkillCount:entries.filter(s=>s.enabled).length,unregisteredFolders:entries.filter(s=>s.registration==='filesystem_only').map(s=>s.id),unreconciledDifferenceFromHistoricalCount:52-catalog.length},
 note:'Historical 52 count is not verified by current NHD runtime. Unregistered github-tools-pack is resource-only, not an activatable skill.',
 routing:{canonicalAdminFormatter:'viet-admin-format-checker',disabledLegacyIds:['skill-chinh-sua-format-van-ban'],legacyAlias:{'skill-chinh-sua-format-van-ban':'viet-admin-format-checker'},aliasPolicy:'resolve before activation; refuse if target disabled; legacy never executes'},
 classificationPolicy:{io:'inferred workflow contract, subject to per-skill runtime validation',dependencies:'recommended only; no hard coupling inferred',backend:'recommended adapter, NOT verified implementation'},
 skills:entries
};
const out=resolve(root,'registry/skill-capabilities.v1.json');
const bytes=JSON.stringify(registry,null,2)+'\n';
if(process.argv.includes('--check')){
 if(!existsSync(out) || readFileSync(out,'utf8')!==bytes)throw Error('Registry stale; run generator');
 console.log('REGISTRY_CHECK_PASS entries='+entries.length+' enabled='+registry.inventory.enabledSkillCount);
} else {
 mkdirSync(resolve(root,'registry'),{recursive:true});
 writeFileSync(out,bytes,'utf8');
 console.log(JSON.stringify({path:out,sha256:sha256(bytes),inventory:registry.inventory},null,2));
}

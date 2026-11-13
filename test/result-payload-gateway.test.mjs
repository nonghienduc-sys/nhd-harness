import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ResultPayloadGatewayService } from '../dist/result-payload-gateway.js';

test('payload gateway is disabled by default behavior and preserves output identity',()=>{
  const root=mkdtempSync(join(tmpdir(),'nhd-payload-off-'));
  try {
    const gateway=new ResultPayloadGatewayService({enabled:false,artifactRoot:root,thresholdChars:16000});
    const output={structuredContent:{text:'x'.repeat(50000)},content:[{type:'text',text:'x'.repeat(50000)}]};
    const decision=gateway.process('pdf_document',output,{action:'read'},{readOnlyHint:true});
    assert.equal(decision.compacted,false);
    assert.equal(decision.reason,'disabled');
    assert.equal(decision.output,output);
  } finally { rmSync(root,{recursive:true,force:true}); }
});

test('large PDF read uses tool-aware preview, reversible artifact and query-aware evidence pack',()=>{
  const root=mkdtempSync(join(tmpdir(),'nhd-payload-on-'));
  try {
    const gateway=new ResultPayloadGatewayService({enabled:true,artifactRoot:root,thresholdChars:16000,previewStringChars:1200,chunkChars:4000});
    const needle='NEEDLE_MIDDLE_EVIDENCE_2026';
    const pages=Array.from({length:80},(_,i)=>({page:i+1,characters:2400,scanned:false,text:`PAGE-${i+1} `+'section '.repeat(260)+(i===39?needle:'')}));
    const value={path:'D:\\docs\\sample.pdf',pageRange:{start:1,end:80},totalPages:80,pages,usedCharacters:pages.reduce((n,p)=>n+p.text.length,0),truncated:false,nextCursor:null,warnings:[]};
    const output={structuredContent:value,content:[{type:'text',text:JSON.stringify(value,null,2)}]};
    const raw=JSON.stringify(output);
    const decision=gateway.process('pdf_document',output,{action:'read',path:'D:\\docs\\sample.pdf'},{readOnlyHint:true});
    assert.equal(decision.compacted,true);
    assert.ok(decision.artifactPath);
    assert.equal(gateway.readArtifact(decision.artifactPath),raw);
    assert.ok(decision.compactedChars < decision.originalChars*0.08,`expected >=92% reduction, got ${decision.compactedChars}/${decision.originalChars}`);
    const returned=decision.output;
    assert.equal(returned.structuredContent._nhdPayloadGateway.compacted,true);
    assert.equal(returned.structuredContent._nhdPayloadGateway.version,'result-payload-gateway-v4');
    assert.equal(returned.structuredContent._nhdPayloadGateway.retrieval.tool,'context_payload_artifact');
    assert.equal(returned.structuredContent._nhdPayloadGateway.retrieval.artifactId,decision.artifactSha256);
    assert.equal(returned.structuredContent.preview._nhdPreview.strategy,'pdf-first-middle-last-v1');
    assert.ok(returned.content[0].text.length<500,'text content should be a locator, not a duplicate preview');
    const found=gateway.searchArtifact(decision.artifactSha256,needle,4,700);
    assert.ok(found.matches.some((match)=>match.snippet.includes(needle)));
    assert.ok(found.matches.every((match)=>!match.path.startsWith('$.content')),'duplicate content representation should be ignored');
    const pack=gateway.evidencePack(decision.artifactSha256,needle,4,3000,700);
    assert.ok(pack.evidenceText.includes(needle));
    assert.ok(pack.usedChars<=3000);
    const rawAt=raw.indexOf(needle);
    const slice=gateway.readArtifactById(decision.artifactSha256,Math.max(0,rawAt-100),400);
    assert.match(slice.text,/NEEDLE_MIDDLE_EVIDENCE_2026/);
  } finally { rmSync(root,{recursive:true,force:true}); }
});

test('query-aware context recall compacts only when real evidence exists and filters query echo',()=>{
  const root=mkdtempSync(join(tmpdir(),'nhd-payload-recall-'));
  try {
    const gateway=new ResultPayloadGatewayService({enabled:true,artifactRoot:root,thresholdChars:16000,chunkChars:4000});
    const query='solar support ceiling';
    const needle='VERIFIED_EVIDENCE solar support ceiling = 6 million per household';
    const results=Array.from({length:30},(_,i)=>({kind:'fact',id:`fact-${i}`,text:i===17?needle:`background memory ${i} `+'project context '.repeat(90),updatedAt:'2026-10-23T00:00:00.000Z',metadata:{category:'benchmark'},score:30-i}));
    const value={root:'D:\\NHD Projects\\Example',query,count:results.length,results};
    const output={structuredContent:value,content:[{type:'text',text:JSON.stringify(value,null,2)}]};
    const decision=gateway.process('context_recall',output,{root:value.root,query,limit:30},{readOnlyHint:true});
    assert.equal(decision.compacted,true);
    assert.ok(decision.artifactSha256);
    const preview=decision.output.structuredContent.preview;
    assert.equal(preview._nhdPreview.strategy,'query-aware-context-recall-v1');
    assert.ok(preview.evidence.some(item=>item.snippet.includes('VERIFIED_EVIDENCE')));
    assert.ok(preview.evidence.every(item=>item.path.includes('.results[')),'evidence should come from result items, not query echo or duplicate content');
    assert.ok(decision.compactedChars < decision.originalChars*0.35);
    const found=gateway.searchArtifact(decision.artifactSha256,query,8,900);
    assert.ok(found.matches.some(item=>item.snippet.includes('VERIFIED_EVIDENCE')));
    assert.ok(found.matches.every(item=>item.path!=='$.structuredContent.query'));
    assert.ok(found.matches.every(item=>!item.path.startsWith('$.content')));

    const queryless=gateway.process('context_recall',output,{root:value.root},{readOnlyHint:true});
    assert.equal(queryless.compacted,false);
    assert.equal(queryless.reason,'quality-guard-context-recall-missing-query');

    const absent=gateway.process('context_recall',output,{root:value.root,query:'ABSENT_TOKEN_987654321',limit:30},{readOnlyHint:true});
    assert.equal(absent.compacted,false);
    assert.equal(absent.reason,'quality-guard-context-recall-no-evidence');
    assert.equal(absent.output,output);
  } finally { rmSync(root,{recursive:true,force:true}); }
});

test('query-aware Office read returns structured DOCX and XLSX locators',()=>{
  const root=mkdtempSync(join(tmpdir(),'nhd-payload-office-'));
  try {
    const gateway=new ResultPayloadGatewayService({enabled:true,artifactRoot:root,thresholdChars:16000});
    const paragraphs=Array.from({length:240},(_,i)=>i===137?'SPECIAL_OFFICE_EVIDENCE project schedule milestone 20/06/2026':`paragraph ${i} `+'background office text '.repeat(12));
    const docxValue={path:'D:\\docs\\report.docx',kind:'docx',text:paragraphs.join('\n'),paragraphCount:paragraphs.length,tables:[{table:1,rows:[{row:1,cells:[{cell:1,text:'Budget ceiling'},{cell:2,text:'3 billion VND'}]}]}]};
    const docxOutput={structuredContent:docxValue,content:[{type:'text',text:JSON.stringify(docxValue)}]};
    const docx=gateway.process('office_read',docxOutput,{path:docxValue.path,query:'project schedule milestone 20/06/2026'},{readOnlyHint:true});
    assert.equal(docx.compacted,true);
    assert.equal(docx.output.structuredContent.preview._nhdPreview.strategy,'structured-office-evidence-v1');
    assert.ok(docx.output.structuredContent.preview.evidence.some(item=>item.path.startsWith('paragraph:')&&item.snippet.includes('SPECIAL_OFFICE_EVIDENCE')));

    const rows=Array.from({length:400},(_,r)=>[null,`ID-${r}`,r===88?'UNIQUE_XLSX_EVIDENCE':`row-${r} background spreadsheet value repeated for payload size`,r===88?'91 households':'normal background value']);
    const xlsxValue={path:'D:\\docs\\survey.xlsx',kind:'xlsx',parser:'exceljs',sheets:[{name:'DATA',rows}]};
    const xlsxOutput={structuredContent:xlsxValue,content:[{type:'text',text:JSON.stringify(xlsxValue)}]};
    const xlsx=gateway.process('office_read',xlsxOutput,{path:xlsxValue.path,query:'UNIQUE_XLSX_EVIDENCE 91 households'},{readOnlyHint:true});
    assert.equal(xlsx.compacted,true);
    assert.ok(xlsx.output.structuredContent.preview.evidence.some(item=>item.path==='sheet:DATA!R89'&&item.snippet.includes('UNIQUE_XLSX_EVIDENCE')));
  } finally { rmSync(root,{recursive:true,force:true}); }
});
test('quality guard preserves broad Office reads',()=>{
  const root=mkdtempSync(join(tmpdir(),'nhd-payload-quality-'));
  try {
    const gateway=new ResultPayloadGatewayService({enabled:true,artifactRoot:root,thresholdChars:16000,safeTools:['office_read']});
    const large={structuredContent:{text:'x'.repeat(50000)},content:[{type:'text',text:'x'.repeat(50000)}]};
    const office=gateway.process('office_read',large,{path:'D:\\docs\\sample.docx'},{readOnlyHint:true});
    assert.equal(office.compacted,false);
    assert.equal(office.reason,'quality-guard-office-read-missing-query');
  } finally { rmSync(root,{recursive:true,force:true}); }
});

test('gateway bypasses mutation-shaped and image results even when very large',()=>{
  const root=mkdtempSync(join(tmpdir(),'nhd-payload-safe-'));
  try {
    const gateway=new ResultPayloadGatewayService({enabled:true,artifactRoot:root,thresholdChars:16000,safeTools:['pdf_document','sample_mutation']});
    const large={structuredContent:{text:'x'.repeat(50000)},content:[{type:'text',text:'x'.repeat(50000)}]};
    const mutation=gateway.process('sample_mutation',large,{}, {readOnlyHint:false});
    assert.equal(mutation.compacted,false);
    assert.equal(mutation.reason,'mutation-or-destructive');
    const image={structuredContent:{text:'x'.repeat(50000)},content:[{type:'image',data:'a'.repeat(50000),mimeType:'image/png'}]};
    const imageDecision=gateway.process('pdf_document',image,{action:'read'}, {readOnlyHint:true});
    assert.equal(imageDecision.compacted,false);
    assert.equal(imageDecision.reason,'image-result');
  } finally { rmSync(root,{recursive:true,force:true}); }
});

test('artifact retrieval rejects arbitrary ids and never accepts filesystem paths',()=>{
  const root=mkdtempSync(join(tmpdir(),'nhd-payload-id-'));
  try {
    const gateway=new ResultPayloadGatewayService({enabled:true,artifactRoot:root,thresholdChars:16000});
    assert.throws(()=>gateway.readArtifactById('../secret',0,1000),/64-character SHA-256/);
    assert.throws(()=>gateway.searchArtifact('D:\\secret.txt','secret'),/64-character SHA-256/);
    assert.throws(()=>gateway.evidencePack('D:\\secret.txt','secret'),/64-character SHA-256/);
  } finally { rmSync(root,{recursive:true,force:true}); }
});



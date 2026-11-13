import test from "node:test";
import assert from "node:assert/strict";
import JSZip from "jszip";
import { auditAdminDocxBuffer } from "../dist/admin-docx-quality-gate.js";
import { planArtifactWorkflow } from "../dist/artifact-intelligence.js";

async function synthetic({marginLeft=1814,normalSize=26,mottoLine=true,bodySize=26,issuerLine=true,imageLines=false,bodyAlign="both",bodyIndent=567,bodyAfter=120,bodyLine=276}={}) {
  const nativeLine=name=>'<w:r><w:drawing><wp:anchor><wp:docPr name="'+name+'"/><a:graphicData><wps:wsp><wps:spPr><a:prstGeom prst="line"/></wps:spPr></wps:wsp></a:graphicData></wp:anchor></w:drawing></w:r>';
  const imageLine='<w:r><w:drawing><wp:inline><pic:pic><pic:blipFill/></pic:pic></wp:inline></w:drawing></w:r>';
  const leftLine=issuerLine?(imageLines?imageLine:nativeLine("NHD_Line_Duoi_Ten_HTX")):'';
  const rightLine=mottoLine?(imageLines?imageLine:nativeLine("NHD_Line_Duoi_Tieu_Ngu")):'';
  const xml=[
  '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>',
  '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>HỢP TÁC XÃ THỬ NGHIỆM</w:t></w:r>',
  leftLine,
  '</w:p></w:tc><w:tc><w:p><w:r><w:t>CỘNG HÒA XÃ HỘI CHỦ NGHĨA VIỆT NAM</w:t></w:r></w:p>',
  '<w:p><w:r><w:t>Độc lập - Tự do - Hạnh phúc</w:t></w:r>',
  rightLine,'</w:p></w:tc></w:tr></w:tbl>',
  '<w:p><w:pPr><w:jc w:val="'+bodyAlign+'"/><w:ind w:firstLine="'+bodyIndent+'"/><w:spacing w:after="'+bodyAfter+'" w:line="'+bodyLine+'" w:lineRule="auto"/></w:pPr><w:r><w:rPr><w:sz w:val="'+bodySize+'"/></w:rPr><w:t>Điều 1. Nội dung đúng thể thức.</w:t></w:r></w:p>',
  '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1247" w:bottom="1247" w:left="'+marginLeft+'" w:right="1020"/></w:sectPr>',
  '</w:body></w:document>'
  ].join('');
  const styles='<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="paragraph" w:styleId="Normal"><w:rPr><w:rFonts w:ascii="Times New Roman"/><w:sz w:val="'+normalSize+'"/></w:rPr></w:style></w:styles>';
  const zip=new JSZip();zip.file("word/document.xml",xml); zip.file("word/styles.xml",styles);
  return zip.generateAsync({type:"nodebuffer"});
}
test("independent ND30 audit passes structural rules but cannot self-certify visual QA", async()=>{
  const result=await auditAdminDocxBuffer(await synthetic());
  assert.equal(result.structuralPass,true,JSON.stringify(result.errors));
  assert.equal(result.status,"visual_qa_pending");
  assert.equal(result.readyToSign,false);
  assert.equal(result.visualQaRequired,true);
  assert.equal(result.measured.normalSizePt,13);
  assert.ok(result.sha256.length===64);
});
test("gate blocks incorrect margin, 11.5pt Normal and missing motto line",async()=>{
 const out=await auditAdminDocxBuffer(await synthetic({marginLeft:1560,normalSize:23,mottoLine:false}));
 assert.equal(out.status,"blocked");assert.ok(out.errors.includes("left-margin-out-of-range"));
 assert.ok(out.errors.includes("normal-size-not-13-14pt"));assert.ok(out.errors.includes("missing-or-undetected-motto-rule"));
});
test("gate blocks body font size override below 13pt even if Normal is correct",async()=>{
 const out=await auditAdminDocxBuffer(await synthetic({bodySize:22}));
 assert.ok(out.errors.includes("body-text-below-13pt"));
});
test("formal HTX decision gets canonical formatter and mandatory visual QA",()=>{
 const a=planArtifactWorkflow({text:"Tạo quyết định của HTX Nông Dược Vùng Cao Yên Thế, ủy quyền Giám đốc chuyển 44 triệu đối ứng OCOP",target:"quyet_dinh_htx.docx",application:"word"});
 assert.ok(a.recommendedSkills.includes("viet-admin-format-checker"),JSON.stringify(a));
 assert.equal(a.qa.structural,true);assert.equal(a.qa.visual,true);
 assert.ok(a.warnings.some(w=>w.includes("FINAL DOCX QUALITY GATE")));
});
test("explicit NĐ30 in HTX legal document chooses formatting skill without declaring legal applicability",()=>{
 const a=planArtifactWorkflow({text:"Làm giấy ủy quyền cho HTX theo Nghị định 30",target:"giay_uy_quyen.docx",application:"word"});
 assert.ok(a.recommendedSkills.includes("viet-admin-format-checker"));assert.equal(a.qa.visual,true);
 assert.ok(a.warnings.some(w=>w.includes("not automatically")));
});
test("mere cooperative charter review does not force NĐ30",()=>{
 const a=planArtifactWorkflow({text:"Đọc và đánh giá Điều lệ HTX",application:"word"});
 assert.equal(a.artifactType,"legal_structured_document");
 assert.ok(!a.recommendedSkills.includes("viet-admin-format-checker"));
});
test("academic thesis does not pick admin formatter",()=>{
 const a=planArtifactWorkflow({text:"Chỉnh sửa khóa luận NEU",target:"kltn.docx",application:"word"});
 assert.ok(!a.recommendedSkills.includes("viet-admin-format-checker"));
});


test("reproduction: inline picture lines must fail the native Word Shape Line gate",async()=>{
 const a=await auditAdminDocxBuffer(await synthetic({imageLines:true}));
 assert.equal(a.status,"blocked");
 assert.ok(a.errors.includes("picture-substituted-for-native-Word-Shape-Line"),JSON.stringify(a.errors));
 assert.ok(a.errors.includes("missing-or-undetected-motto-rule"));
 assert.ok(a.errors.includes("missing-or-undetected-issuer-rule"));
});

test("strict body formatting gate blocks left alignment even when Shape Lines and font pass",async()=>{
 const a=await auditAdminDocxBuffer(await synthetic({bodyAlign:"left"}));
 assert.equal(a.status,"blocked");
 assert.ok(a.errors.includes("body-paragraphs-not-justified"),JSON.stringify(a.errors));
 assert.equal(a.measured.bodyNotJustified,1);
});
test("strict body formatting gate rejects short first-line indent",async()=>{
 const a=await auditAdminDocxBuffer(await synthetic({bodyIndent:310}));
 assert.ok(a.errors.includes("body-first-line-indent-not-1-or-1.27cm"),JSON.stringify(a.errors));
});
test("strict body formatting gate rejects too-short paragraph gap and line spacing",async()=>{
 const a=await auditAdminDocxBuffer(await synthetic({bodyAfter:60,bodyLine:180}));
 assert.ok(a.errors.includes("body-paragraph-gap-under-6pt"),JSON.stringify(a.errors));
 assert.ok(a.errors.includes("body-line-spacing-outside-1-to-1.5"),JSON.stringify(a.errors));
});

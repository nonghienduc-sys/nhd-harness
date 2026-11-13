/**
 * Synthetic six-type NĐ30 structural fixtures ONLY (not real legal templates).
 * No issued document number/signature/authority is invented.
 * Generates test DOCX files without touching NHD office-* skills or the user's documents.
 */
import { Document, Paragraph, TextRun, AlignmentType, Packer } from 'docx';
import { createHash } from 'node:crypto';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot=resolve(fileURLToPath(new URL('..',import.meta.url)));
const tests=JSON.parse(readFileSync(resolve(repoRoot,'test/fixtures/admin-document-cases.v1.json'),'utf8'));
export const CASES=tests.cases;
const normal=(text,options={})=>new Paragraph({
  alignment:options.center?AlignmentType.CENTER:AlignmentType.JUSTIFIED,
  spacing:{before:0,after:120,line:276},
  indent:options.center?undefined:{firstLine:567},
  children:[new TextRun({text,font:'Times New Roman',size:options.size??26,bold:!!options.bold,color:'000000'})]
});
export async function makeFixture(entry){
  const lines=[
    normal('BẢN KIỂM THỬ – KHÔNG PHÁT HÀNH',{center:true,bold:true,size:24}),
    normal('[CƠ QUAN CHỦ QUẢN]',{center:true,bold:true,size:26}),
    normal('[CƠ QUAN BAN HÀNH]',{center:true,bold:true,size:26}),
    normal('CỘNG HÒA XÃ HỘI CHỦ NGHĨA VIỆT NAM',{center:true,bold:true,size:26}),
    normal('Độc lập - Tự do - Hạnh phúc',{center:true,bold:true,size:28}),
    normal('Số: [CHỜ VĂN THƯ CẤP]',{size:26}),
    normal('[ĐỊA DANH], ngày [..] tháng [..] năm [....]',{size:26}),
  ];
  if(entry.heading)lines.push(normal(entry.heading,{center:true,bold:true,size:28}));
  lines.push(normal(entry.subject,{center:!!entry.heading,bold:true,size:26}));
  for(const line of entry.body)lines.push(normal(line,{size:26}));
  lines.push(normal('Nơi nhận:',{bold:true,size:26}));
  lines.push(normal('- [DANH SÁCH NƠI NHẬN CHƯA XÁC MINH]',{size:26}));
  lines.push(normal('[CHỨC VỤ NGƯỜI KÝ – CHƯA XÁC MINH]',{center:true,bold:true,size:26}));
  lines.push(normal('[HỌ TÊN NGƯỜI KÝ – CHƯA XÁC MINH]',{center:true,size:26}));
  const doc=new Document({
    creator:'NHD Automated Structural Regression',
    title:'TEST ONLY - '+entry.id,
    sections:[{properties:{page:{size:{width:11906,height:16838},margin:{top:1134,bottom:1134,left:1701,right:1134}}},children:lines}],
  });
  return Packer.toBuffer(doc);
}
const invoked=process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url);
if(invoked){
  const dest=resolve(repoRoot,'test-artifacts/admin-regression');
  mkdirSync(dest,{recursive:true});
  const receipt={schemaVersion:1,warning:'SYNTHETIC FIXTURES ONLY; NO VISUAL/LEGAL CERTIFICATION',files:[]};
  for(const entry of CASES){
    const buffer=await makeFixture(entry);
    const path=resolve(dest,entry.file);
    writeFileSync(path,buffer);
    receipt.files.push({id:entry.id,path,bytes:buffer.length,sha256:createHash('sha256').update(buffer).digest('hex')});
  }
  writeFileSync(resolve(dest,'fixture-manifest.json'),JSON.stringify(receipt,null,2)+'\n','utf8');
  console.log(JSON.stringify(receipt,null,2));
}

// Purpose-built synthetic Vietnamese administrative công văn with proper two-column
// national-header/issuing-agency composition for live E2E rendering and QA.
// Never issue: all authority, signature and document-number fields are placeholders.
import {Document,Paragraph,TextRun,Table,TableRow,TableCell,
 AlignmentType,WidthType,BorderStyle,Packer} from 'docx';
const none={style:BorderStyle.NONE,size:0,color:'FFFFFF'};
const tableBorders={top:none,bottom:none,left:none,right:none,insideHorizontal:none,insideVertical:none};
const para=(text,{align='left',bold=false,size=26,after=0,before=0,firstLine=0,italic=false,underline=false,keepWithNext=false}={})=>
 new Paragraph({
  alignment:align==='center'?AlignmentType.CENTER:align==='right'?AlignmentType.RIGHT:align==='justify'?AlignmentType.JUSTIFIED:AlignmentType.LEFT,
  indent:firstLine?{firstLine}:undefined,
  spacing:{before,after,line:320},
  keepWithNext,
  children:[new TextRun({text,font:'Times New Roman',size,bold,italic,underline,color:'000000'})]
 });
const cell=(paragraphs,opts={})=>new TableCell({
 width:{size:opts.width??4250,type:WidthType.DXA},
 margins:{top:0,bottom:0,left:0,right:100},
 borders:tableBorders,
 children:paragraphs
});
export async function makeAdminLayoutFixture(tc){
 if(tc.id!=='cong_van')throw Error('This fixture supports only cong_van');
 const header=new Table({
  columnWidths:[3350,5700],
  width:{size:9050,type:WidthType.DXA},
  borders:tableBorders,
  rows:[new TableRow({children:[
   cell([
    para('[CƠ QUAN CHỦ QUẢN]',{align:'center',bold:true,size:24}),
    para('[CƠ QUAN BAN HÀNH]',{align:'center',bold:true,size:24}),
    para('Số: [CHỜ VĂN THƯ CẤP]',{align:'center',size:26,before:260}),
   ],{width:3350}),
   cell([
    para('CỘNG HÒA XÃ HỘI CHỦ NGHĨA VIỆT NAM',{align:'center',bold:true,size:24}),
    para('Độc lập - Tự do - Hạnh phúc',{align:'center',bold:true,size:26}),
    new Paragraph({indent:{left:900,right:900},spacing:{before:0,after:0,line:60},border:{bottom:{style:BorderStyle.SINGLE,size:6,color:'000000',space:0}},children:[new TextRun({text:' ',font:'Times New Roman',size:26})]}),
    para('[ĐỊA DANH], ngày [..] tháng [..] năm [....]',{align:'right',italic:true,size:26,before:150}),
   ],{width:5700})
  ]})]
 });
 const bottom=new Table({
  columnWidths:[3900,4600],width:{size:8500,type:WidthType.DXA},borders:tableBorders,
  rows:[new TableRow({children:[
   cell([
    para('Nơi nhận:',{bold:true,size:26}),
    para('- [DANH SÁCH NƠI NHẬN CHƯA XÁC MINH]',{size:24}),
   ],{width:3900}),
   cell([
    para('[CHỨC VỤ NGƯỜI KÝ – CHƯA XÁC MINH]',{align:'center',bold:true,size:24}),
    para('[KÝ SAU KHI DUYỆT]',{align:'center',italic:true,size:22,after:200,before:150}),
    para('[HỌ TÊN NGƯỜI KÝ – CHƯA XÁC MINH]',{align:'center',bold:true,size:26,before:160}),
   ],{width:4600})
  ]})]
 });
 const body=[
  para('BẢN KIỂM THỬ – KHÔNG PHÁT HÀNH',{align:'center',bold:true,size:20,after:150}),
  header,
  para(tc.subject,{align:'center',bold:true,size:26,before:350,after:200}),
  ...tc.body.map(x=>para(x,{align:'justify',size:26,firstLine:570,after:140})),
  para('Văn bản này chỉ dùng để kiểm thử tự động và kiểm tra bố cục; không có giá trị ban hành.',{align:'justify',italic:true,size:24,firstLine:570,before:150,after:300}),
  bottom
 ];
 const doc=new Document({
  creator:'NHD Admin E2E Test',
  title:'TEST ONLY - synthetic administrative document',
  sections:[{properties:{page:{size:{width:11906,height:16838},margin:{top:1134,bottom:1134,left:1701,right:1134}}},children:body}]
 });
 return Packer.toBuffer(doc);
}

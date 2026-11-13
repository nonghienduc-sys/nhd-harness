// Independent structural smoke inspector for synthetic administrative DOCX test fixtures.
// Not a normative legal/visual compliance certificate.
import JSZip from 'jszip';
const mm=twip=>Number(twip)/56.6929133858;
const attr=(tag,key)=>new RegExp('\\bw:'+key+'="([^"]+)"').exec(tag)?.[1];
const decode=t=>t.replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&apos;/g,"'");
export function inspectAdminDocxXml(xml, testcase){
 const errors=[];
 const page=xml.match(/<w:pgSz\b[^>]*\/>/)?.[0]??'';
 const margin=xml.match(/<w:pgMar\b[^>]*\/>/)?.[0]??'';
 if(Math.abs(Number(attr(page,'w'))-11906)>2 || Math.abs(Number(attr(page,'h'))-16838)>2)errors.push('page-not-A4');
 for(const [side,min,max] of [['top',20,25],['bottom',20,25],['left',30,35],['right',15,20]]){
  const value=mm(attr(margin,side));
  if(!Number.isFinite(value) || value<min-0.4 || value>max+0.4)errors.push(side+'-margin-out-of-range');
 }
 const runs=[...xml.matchAll(/<w:r(?:\s[^>]*)?>[\s\S]*?<\/w:r>/g)].map(m=>m[0]).filter(s=>/<w:t(?:\s|>)/.test(s));
 if(!runs.length)errors.push('no-text-runs');
 for(const run of runs){
  if(!/<w:rFonts\b[^>]*w:ascii="Times New Roman"/.test(run)){errors.push('run-font-not-Times-New-Roman');break;}
 }
 for(const run of runs){
  const size=Number(/<w:sz w:val="(\d+)"/.exec(run)?.[1]);
  if(!Number.isFinite(size) || size<24 || size>28){errors.push('run-size-out-of-range');break;}
 }
 const txt=[...xml.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)].map(m=>decode(m[1])).join('\n');
 for(const literal of ['CỘNG HÒA XÃ HỘI CHỦ NGHĨA VIỆT NAM','Độc lập - Tự do - Hạnh phúc','Nơi nhận:','[HỌ TÊN NGƯỜI KÝ','[CHỨC VỤ NGƯỜI KÝ','BẢN KIỂM THỬ – KHÔNG PHÁT HÀNH',...testcase.markers]){
   if(!txt.includes(literal))errors.push('missing-marker:'+literal);
 }
 for(const original of testcase.body){
   if(!txt.includes(original))errors.push('missing-body-block:'+original.slice(0,28));
 }
 return {ok:errors.length===0,errors,visibleText:txt,pageSizeTwip:{width:Number(attr(page,'w')),height:Number(attr(page,'h'))},marginsMm:{top:mm(attr(margin,'top')),bottom:mm(attr(margin,'bottom')),left:mm(attr(margin,'left')),right:mm(attr(margin,'right'))},textRunCount:runs.length};
}
export async function inspectAdminDocxBuffer(buffer,testcase){
 const zip=await JSZip.loadAsync(buffer);
 const word=zip.file('word/document.xml');
 if(!word)throw new Error('Missing word/document.xml');
 return inspectAdminDocxXml(await word.async('string'),testcase);
}

// Deterministic DOCX-only backend for synthetic NHD administrative E2E.
import JSZip from 'jszip';
import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
export const sha=b=>createHash('sha256').update(b).digest('hex');
export const fileHash=p=>sha(readFileSync(p));
export const textOf=xml=>[...xml.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)].map(x=>x[1]).join('\n');
export async function xmlFrom(bytes){
 const zip=await JSZip.loadAsync(bytes);
 const file=zip.file('word/document.xml');
 if(!file)throw Error('Invalid DOCX: missing document.xml');
 return file.async('string');
}
export async function changeDocx(bytes,format){
 const zip=await JSZip.loadAsync(bytes);
 const f=zip.file('word/document.xml');
 if(!f)throw Error('Missing word/document.xml');
 const before=await f.async('string');
 const font=format?'Times New Roman':'Arial';
 const size=format?26:22;
 let after=before.replace(/<w:rFonts\b[^>]*\/>/g,t=>t.replace(/w:(ascii|cs|eastAsia|hAnsi)="[^"]*"/g,(_m,k)=>'w:'+k+'="'+font+'"'));
 after=after.replace(/<w:sz w:val="\d+"\/>/g,'<w:sz w:val="'+size+'"/>');
 after=after.replace(/<w:szCs w:val="\d+"\/>/g,'<w:szCs w:val="'+size+'"/>');
 after=after.replace(/<w:pgMar\b[^>]*\/>/g,t=>{
  const margins=format?{top:1134,bottom:1134,left:1701,right:1134}:{top:650,bottom:650,left:650,right:650};
  for(const [k,v] of Object.entries(margins))t=t.replace(new RegExp('w:'+k+'="\\d+"'),'w:'+k+'="'+v+'"');
  return t;
 });
 if(format)after=after.replace(/<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g,block=>{
  if(block.includes('CỘNG HÒA XÃ HỘI CHỦ NGHĨA VIỆT NAM') || block.includes('[CƠ QUAN'))
    return block.replace(/<w:sz w:val="26"\/>/g,'<w:sz w:val="24"/>').replace(/<w:szCs w:val="26"\/>/g,'<w:szCs w:val="24"/>');
  return block;
 });
 if(textOf(before)!==textOf(after))throw Error('Format altered the document text');
 if(before===after)throw Error('No formatting change performed');
 zip.file('word/document.xml',after);
 return zip.generateAsync({type:'nodebuffer',compression:'DEFLATE'});
}
export function writeNew(path,bytes){
 if(existsSync(path))throw Error('Refusing to overwrite existing artifact: '+path);
 writeFileSync(path,bytes,{flag:'wx'});
 if(fileHash(path)!==sha(bytes))throw Error('Write/read-back mismatch');
}
export async function normalizedTextHash(path){return sha(Buffer.from(textOf(await xmlFrom(readFileSync(path))),'utf8'));}

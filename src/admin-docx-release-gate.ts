import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import JSZip from "jszip";
import { copyFileSync, existsSync, linkSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync, renameSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { auditAdminDocxFile, type AdminDocxAudit } from "./admin-docx-quality-gate.js";

export type AdminReview = {
  schemaVersion:1; id:string; candidatePath:string; pdfPath:string;
  docxSha256:string; pdfSha256:string;
  classification:"government_admin"|"cooperative_admin_style";
  formatterSkill:"viet-admin-format-checker"; structural:AdminDocxAudit;
  geometry:{status:string;errors:string[];docPages:number;measurements?:unknown};
  pages:Array<{page:number;pngPath:string;sha256:string}>;
  viewedPages:number[];
  review:null|{verdict:"pass"|"fail";reviewedPages:number[];reviewer:string;notes:string;at:string};
  preparedAt:string;
};
const sha=(b:Uint8Array)=>createHash("sha256").update(b).digest("hex");
const hash=(p:string)=>sha(readFileSync(p));
const hex=()=>randomBytes(12).toString("hex");
const isSha=(s:string)=>/^[a-f0-9]{64}$/.test(s);
function tokens(value:string) { return value.normalize("NFC").toLowerCase().match(/[\p{L}\p{N}]+/gu)??[]; }
async function assertSameDocumentText(docx:string,pdfText:string) {
  const zip=await JSZip.loadAsync(readFileSync(docx));
  const docXml=await zip.file("word/document.xml")?.async("string");
  if(!docXml)throw new Error("ADMIN_RELEASE_BLOCKED: missing DOCX XML");
  const text=[...docXml.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)]
    .map(m=>m[1].replace(/&amp;/g,"&").replace(/&lt;/g,"<").replace(/&gt;/g,">").replace(/&quot;/g,'"').replace(/&apos;/g,"'")).join(" ");
  const a=tokens(text),b=tokens(pdfText);
  if(a.length<50)throw new Error("ADMIN_RELEASE_BLOCKED: insufficient DOCX body for proof");
  const counts=new Map<string,number>();
  for(const w of b)counts.set(w,(counts.get(w)??0)+1);
  let missed=0;
  for(const w of a){
    const n=counts.get(w)??0;
    if(n<1) missed++; else counts.set(w,n-1);
  }
  if(missed>0)throw new Error("ADMIN_RELEASE_BLOCKED: PDF does not reproduce DOCX text; unmatched tokens="+missed);
}

const geometricalRenderer=String.raw`
import sys,os,json,hashlib,unicodedata,fitz
src,outdir=sys.argv[1:3]
doc=fitz.open(src)
if not 1<=len(doc)<=200:raise RuntimeError('invalid page count')
os.makedirs(outdir,exist_ok=True)
pages=[]
for i,p in enumerate(doc):
    img=p.get_pixmap(matrix=fitz.Matrix(1.35,1.35),alpha=False)
    filename=os.path.abspath(os.path.join(outdir,'page-%03d.png'%(i+1)))
    img.save(filename)
    with open(filename,'rb') as f:h=hashlib.sha256(f.read()).hexdigest()
    pages.append(dict(page=i+1,pngPath=filename,sha256=h))
def norm(t):return unicodedata.normalize('NFC',t).strip()
page=doc[0]
texts=[]
for block in page.get_text('dict')['blocks']:
    for line in block.get('lines',[]):
        txt=norm(''.join(sp.get('text','') for sp in line['spans']))
        if txt:texts.append((txt,fitz.Rect(line['bbox'])))
issuer=next(((t,r) for t,r in texts if any(k in t for k in ['HỢP TÁC XÃ','ỦY BAN NHÂN DÂN','HỘI ĐỒNG NHÂN DÂN']) and r.y0<125),None)
motto=next(((t,r) for t,r in texts if 'Độc lập - Tự do - Hạnh phúc' in t and r.y0<130),None)
errors=[]
measured={}
if not issuer:errors.append('issuer-text-missing')
if not motto:errors.append('motto-text-missing')
if issuer and motto:
    eligible=[(t,r) for t,r in texts if r.x0<295 and 50<r.y0<125 and r.y0>=issuer[1].y0-2 and r.y0<issuer[1].y1+42 and t!='Số:']
    issuerbottom=max((r.y1 for t,r in eligible if r.y0<105),default=issuer[1].y1)
    lines=[]
    for d in page.get_drawings():
        r=d.get('rect')
        if r and r.height<1.6 and 40<=r.width<250 and 65<r.y0<175:lines.append(r)
    left=next((r for r in sorted(lines,key=lambda r:r.x0) if r.x0<295),None)
    right=next((r for r in sorted(lines,key=lambda r:r.x0) if r.x0>=295),None)
    measured=dict(issuerBottom=round(issuerbottom,2),mottoBottom=round(motto[1].y1,2))
    if not left:errors.append('issuer-line-not-rendered')
    else:
        if not .325<=left.width/issuer[1].width<=.525:errors.append('issuer-line-width')
        if not 2.5<=left.y0-issuerbottom<=12.5:errors.append('issuer-line-gap')
        if abs((left.x0+left.x1-issuer[1].x0-issuer[1].x1)/2)>8:errors.append('issuer-line-centre')
    if not right:errors.append('motto-line-not-rendered')
    else:
        if abs(right.width-motto[1].width)>8:errors.append('motto-line-width')
        if not 2.5<=right.y0-motto[1].y1<=12.5:errors.append('motto-line-gap')
        if abs((right.x0+right.x1-motto[1].x0-motto[1].x1)/2)>8:errors.append('motto-line-centre')
text='\n'.join(p.get_text() for p in doc)
print(json.dumps(dict(status='PASS' if not errors else 'FAIL',errors=errors,docPages=len(doc),measurements=measured,pages=pages,pdfText=text),ensure_ascii=True))
`;
function exact(path:string,ext:string) {
  const abs=resolve(path);
  if(extname(abs).toLowerCase()!==ext||!existsSync(abs)||!statSync(abs).isFile())
    throw new Error("ADMIN_RELEASE_BLOCKED: missing "+ext+" file "+abs);
  return abs;
}
export function validateAdminReleaseProof(r:AdminReview) {
  const errors:string[]=[];
  if(r.formatterSkill!=="viet-admin-format-checker")errors.push("canonical-skill-absent");
  if(!r.structural.structuralPass||r.structural.sha256!==r.docxSha256)errors.push("structural-audit-failed-or-stale");
  if(r.geometry.status!=="PASS"||r.geometry.errors.length)errors.push("geometry-not-verified");
  if(!isSha(r.docxSha256)||!isSha(r.pdfSha256))errors.push("document-hashes-invalid");
  if(r.geometry.docPages<1||r.pages.length!==r.geometry.docPages)errors.push("rendered-pages-incomplete");
  if(r.pages.some((p,i)=>p.page!==i+1||!isSha(p.sha256)))errors.push("page-sha-invalid");
  if((r.viewedPages??[]).length!==r.pages.length || r.pages.some(p=>!(r.viewedPages??[]).includes(p.page)))
    errors.push("page-image-not-actually-retrieved");
  if(!r.review||r.review.verdict!=="pass")errors.push("visual-qa-not-approved");
  if(r.review){
    const numbers=r.review.reviewedPages;
    if(numbers.length!==r.pages.length || r.pages.some((p)=>!numbers.includes(p.page)))errors.push("visual-qa-pages-incomplete");
  }
  return {pass:errors.length===0,errors};
}
type Pending={reviewId:string;target:string;docSha:string;tokenHash:string;expiry:number};
/**
 * Pending publish previews are persisted on disk (HMAC-signed, token stored only as a hash)
 * because the MCP HTTP transport is stateless: each request may construct a fresh gate
 * instance, and the server may restart between preview and apply.
 */
export class AdminDocxReleaseGate {
  readonly reviewDir:string;
  private readonly pendingDir:string;
  private readonly secret:Buffer;
  constructor(reviewDir:string){
    this.reviewDir=resolve(reviewDir);mkdirSync(this.reviewDir,{recursive:true});
    const secretFile=join(this.reviewDir,".review-hmac-key");
    if(!existsSync(secretFile)) {
      try {writeFileSync(secretFile,randomBytes(32),{flag:"wx",mode:0o600});}catch(e){if(!existsSync(secretFile))throw e;}
    }
    this.secret=readFileSync(secretFile);
    if(this.secret.length!==32)throw new Error("ADMIN_RELEASE_BLOCKED: invalid review signing key");
    this.pendingDir=join(this.reviewDir,".pending-publish");mkdirSync(this.pendingDir,{recursive:true});
  }
  private signature(r:AdminReview){return createHmac("sha256",this.secret).update(JSON.stringify(r)).digest("hex");}
  private pendingSignature(p:Pending){return createHmac("sha256",this.secret).update("pending:"+JSON.stringify(p)).digest("hex");}
  private pendingFile(actionId:string){
    if(!/^[0-9a-f]{24}$/.test(actionId))throw new Error("ADMIN_RELEASE_BLOCKED: invalid action id");
    return join(this.pendingDir,actionId+".json");
  }
  private savePending(actionId:string,p:Pending){
    writeFileSync(this.pendingFile(actionId),JSON.stringify({pending:p,signature:this.pendingSignature(p)})+"\n",{flag:"wx",mode:0o600});
  }
  /** Atomically claims a pending preview: rename succeeds for exactly one consumer. */
  private consumePending(actionId:string):Pending|null{
    let path:string;
    try{path=this.pendingFile(actionId);}catch{return null;}
    const claimed=path+".claimed-"+hex();
    try{renameSync(path,claimed);}catch{return null;}
    try{
      const env=JSON.parse(readFileSync(claimed,"utf8")) as {pending:Pending;signature:string};
      const mac=this.pendingSignature(env.pending);
      if(!/^[a-f0-9]{64}$/.test(env.signature??"")||!timingSafeEqual(Buffer.from(mac),Buffer.from(env.signature)))
        throw new Error("ADMIN_RELEASE_BLOCKED: pending preview integrity mismatch");
      return env.pending;
    }finally{rmSync(claimed,{force:true});}
  }
  private prunePending(){
    try{
      for(const name of readdirSync(this.pendingDir)){
        const full=join(this.pendingDir,name);
        try{if(Date.now()-statSync(full).mtimeMs>3_600_000)rmSync(full,{force:true});}catch{/* ignore */}
      }
    }catch{/* ignore */}
  }
  private filename(reviewId:string){
    if(!/^[0-9a-f]{24}$/.test(reviewId))throw new Error("ADMIN_RELEASE_BLOCKED: invalid review id");
    return join(this.reviewDir,reviewId,"review.json");
  }
  private load(id:string):AdminReview {
    const path=this.filename(id);
    if(!existsSync(path))throw new Error("ADMIN_RELEASE_BLOCKED: missing review receipt");
    const envelope=JSON.parse(readFileSync(path,"utf8")) as {receipt:AdminReview;signature:string};
    const r=envelope.receipt;
    if(!r || r.id!==id || r.schemaVersion!==1)throw new Error("ADMIN_RELEASE_BLOCKED: receipt mismatch");
    const mac=this.signature(r);
    if(!/^[a-f0-9]{64}$/.test(envelope.signature??"") ||
       !timingSafeEqual(Buffer.from(mac),Buffer.from(envelope.signature)))
      throw new Error("ADMIN_RELEASE_BLOCKED: review receipt integrity mismatch");
    return r;
  }
  private save(r:AdminReview) {
    const path=this.filename(r.id);mkdirSync(dirname(path),{recursive:true});
    const temp=path+".pending-"+hex();
    writeFileSync(temp,JSON.stringify({receipt:r,signature:this.signature(r)},null,2)+"\n",{flag:"wx"});
    try{renameSync(temp,path);}finally{if(existsSync(temp))rmSync(temp,{force:true});}
  }
  private verifyFiles(r:AdminReview){
    if(hash(exact(r.candidatePath,".docx"))!==r.docxSha256)throw new Error("ADMIN_RELEASE_BLOCKED: DOCX mutated since receipt");
    if(hash(exact(r.pdfPath,".pdf"))!==r.pdfSha256)throw new Error("ADMIN_RELEASE_BLOCKED: PDF mutated since receipt");
    for(const p of r.pages)
      if(hash(exact(p.pngPath,".png"))!==p.sha256)throw new Error("ADMIN_RELEASE_BLOCKED: rendered page "+p.page+" changed");
  }
  async prepare(candidatePath:string,pdfPath:string,classification:AdminReview["classification"]) {
    const docx=exact(candidatePath,".docx"),pdf=exact(pdfPath,".pdf");
    const structural=await auditAdminDocxFile(docx);
    if(!structural.structuralPass)throw new Error("ADMIN_RELEASE_BLOCKED: "+structural.errors.join(", "));
    const reviewId=hex(),outdir=join(this.reviewDir,reviewId);
    mkdirSync(outdir,{recursive:true});
    const proc=spawnSync("python",["-c",geometricalRenderer,pdf,outdir],
      {encoding:"utf8",timeout:120_000,maxBuffer:3_000_000,windowsHide:true});
    if(proc.error||proc.status!==0)throw new Error("ADMIN_RELEASE_BLOCKED: render failure "+String(proc.error?.message||proc.stderr||proc.status).slice(0,600));
    let report:{status:string;errors:string[];docPages:number;measurements:unknown;pages:AdminReview["pages"];pdfText:string};
    try{report=JSON.parse(proc.stdout.trim());}catch{throw new Error("ADMIN_RELEASE_BLOCKED: invalid render result");}
    if(report.status!=="PASS"||report.errors.length)throw new Error("ADMIN_RELEASE_BLOCKED: PDF geometry "+report.errors.join(", "));
    await assertSameDocumentText(docx,report.pdfText);
    const r:AdminReview={schemaVersion:1,id:reviewId,candidatePath:docx,pdfPath:pdf,docxSha256:structural.sha256,
      pdfSha256:hash(pdf),formatterSkill:"viet-admin-format-checker",classification,
      structural,geometry:{status:report.status,errors:report.errors,docPages:report.docPages,measurements:report.measurements},
      pages:report.pages,viewedPages:[],review:null,preparedAt:new Date().toISOString()};
    this.verifyFiles(r);this.save(r);
    return {reviewId,status:"visual_review_required",docxSha256:r.docxSha256,pdfSha256:r.pdfSha256,renderedPages:r.pages,
      legalApproval:false,readyToSign:false};
  }
  viewPage(id:string,pageNumber:number) {
    const r=this.load(id);this.verifyFiles(r);
    const page=r.pages.find(p=>p.page===pageNumber);
    if(!page)throw new Error("ADMIN_RELEASE_BLOCKED: page not in verified render");
    if(!r.review && !(r.viewedPages??[]).includes(pageNumber)){
      r.viewedPages=[...(r.viewedPages??[]),pageNumber].sort((a,b)=>a-b);
      this.save(r);
    }
    return {reviewId:id,page:pageNumber,sha256:page.sha256,mimeType:"image/png" as const,
      data:readFileSync(page.pngPath).toString("base64")};
  }
  review(id:string,verdict:"pass"|"fail",pages:number[],notes:string,reviewer:string) {
    const r=this.load(id);this.verifyFiles(r);
    if(r.review)throw new Error("ADMIN_RELEASE_BLOCKED: already reviewed");
    const selected=[...new Set(pages)].sort((a,b)=>a-b);
    if(verdict==="pass" && ((r.viewedPages??[]).length!==r.pages.length || r.pages.some(p=>!(r.viewedPages??[]).includes(p.page))))
      throw new Error("ADMIN_RELEASE_BLOCKED: every page image must be opened through office_admin_release_view_page before approval");
    if(verdict==="pass"&&(selected.length!==r.pages.length||r.pages.some(p=>!selected.includes(p.page))))
      throw new Error("ADMIN_RELEASE_BLOCKED: must review every page");
    if(!reviewer.trim()||!notes.trim())throw new Error("ADMIN_RELEASE_BLOCKED: reviewer and findings required");
    r.review={verdict,reviewedPages:selected,reviewer:reviewer.trim().slice(0,100),
      notes:notes.trim().slice(0,2000),at:new Date().toISOString()};
    this.save(r);
    return {reviewId:id,status:verdict==="pass"?"approved":"rejected",reviewedPages:selected};
  }
  previewPublish(reviewId:string,output:string) {
    const r=this.load(reviewId);this.verifyFiles(r);const proof=validateAdminReleaseProof(r);
    if(!proof.pass)throw new Error("ADMIN_RELEASE_BLOCKED: "+proof.errors.join(", "));
    if(existsSync(join(this.reviewDir,reviewId,"publish.json")))
      throw new Error("ADMIN_RELEASE_BLOCKED: review already used for publication");
    const target=resolve(output);
    if(extname(target).toLowerCase()!==".docx"||existsSync(target))
      throw new Error("ADMIN_RELEASE_BLOCKED: output must be a NEW DOCX (never overwrite)");
    const actionId=hex(),confirmationToken=randomBytes(24).toString("hex");
    this.prunePending();
    this.savePending(actionId,{reviewId,target,docSha:r.docxSha256,tokenHash:sha(Buffer.from(confirmationToken)),expiry:Date.now()+300_000});
    return {actionId,confirmationToken,target,expectedSha256:r.docxSha256,expiresInSeconds:300};
  }
  applyPublish(actionId:string,confirmationToken:string) {
    const p=this.consumePending(String(actionId));
    if(!p)throw new Error("ADMIN_RELEASE_BLOCKED: preview missing or already consumed");
    if(Date.now()>p.expiry)throw new Error("ADMIN_RELEASE_BLOCKED: preview expired");
    if(!timingSafeEqual(Buffer.from(sha(Buffer.from(String(confirmationToken)))),Buffer.from(p.tokenHash)))
      throw new Error("ADMIN_RELEASE_BLOCKED: invalid token");
    const r=this.load(p.reviewId);this.verifyFiles(r);const proof=validateAdminReleaseProof(r);
    if(!proof.pass||p.docSha!==r.docxSha256)throw new Error("ADMIN_RELEASE_BLOCKED: evidence stale");
    if(existsSync(join(this.reviewDir,r.id,"publish.json")))
      throw new Error("ADMIN_RELEASE_BLOCKED: review already published");
    if(existsSync(p.target))throw new Error("ADMIN_RELEASE_BLOCKED: concurrent output exists");
    mkdirSync(dirname(p.target),{recursive:true});
    const temp=join(dirname(p.target),".nhd-release-"+hex()+".docx");
    try{
      copyFileSync(r.candidatePath,temp);
      if(hash(temp)!==r.docxSha256)throw new Error("ADMIN_RELEASE_BLOCKED: copy mismatch");
      // Exclusive link makes an existing target impossible to overwrite.
      linkSync(temp,p.target);unlinkSync(temp);
      if(hash(p.target)!==r.docxSha256)throw new Error("ADMIN_RELEASE_BLOCKED: destination readback mismatch");
    }finally{if(existsSync(temp))rmSync(temp,{force:true});}
    const receipt={schemaVersion:1,reviewId:r.id,outputPath:p.target,outputSha256:hash(p.target),
      docxSha256:r.docxSha256,pdfSha256:r.pdfSha256,pageSha256:r.pages.map(x=>x.sha256),
      geometry:r.geometry.status,visualReview:r.review,publishedAt:new Date().toISOString(),
      readyToSign:false,legalAuthorityVerified:false};
    const receiptPath=join(this.reviewDir,r.id,"publish.json");
    try{
      writeFileSync(receiptPath,JSON.stringify(receipt,null,2)+"\n",{flag:"wx"});
    }catch(error){
      // Do not leave an unreceipted managed publication if receipt persistence fails.
      if(existsSync(p.target) && hash(p.target)===r.docxSha256)unlinkSync(p.target);
      throw error;
    }
    return {...receipt,receiptPath};
  }
  status(id:string){
    const r=this.load(id);let stale=false;try{this.verifyFiles(r);}catch{stale=true;}
    const proof=validateAdminReleaseProof(r);
    const published=join(this.reviewDir,id,"publish.json");
    let publishedHashMatch:null|boolean=null;
    if(existsSync(published)){
      try{
        const receipt=JSON.parse(readFileSync(published,"utf8")) as {outputPath:string;outputSha256:string};
        publishedHashMatch=hash(exact(receipt.outputPath,".docx"))===receipt.outputSha256 && receipt.outputSha256===r.docxSha256;
        if(!publishedHashMatch)stale=true;
      }catch{publishedHashMatch=false;stale=true;}
    }
    return {reviewId:id,status:stale?"stale":publishedHashMatch?"published":proof.pass?"approved":"blocked",errors:proof.errors,
      docxSha256:r.docxSha256,pdfSha256:r.pdfSha256,renderedPages:r.pages.length,
      reviewedPages:r.review?.reviewedPages??[],viewedPages:r.viewedPages??[],publishedHashMatch,readyToSign:false};
  }
}


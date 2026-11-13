import JSZip from "jszip";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

export type AdminDocxAudit = {
  mode: "nd30_style";
  structuralPass: boolean;
  status: "blocked" | "visual_qa_pending";
  visualQaRequired: true;
  readyToSign: false;
  sha256: string;
  errors: string[];
  warnings: string[];
  measured: {
    a4: boolean;
    marginsMm: Record<string, number | null>;
    normalFont: string | null;
    normalSizePt: number | null;
    mottoRuleDetected: boolean;
    issuerRuleDetected: boolean;
    bodyBelow13Pt: number;
    bodyProseCount: number;
    bodyNotJustified: number;
    bodyIndentInvalid: number;
    bodySpacingInvalid: number;
    bodyLineSpacingInvalid: number;
  };
};
const unescapeXml = (s: string) => s.replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h,16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
  .replace(/&amp;/g,"&").replace(/&lt;/g,"<").replace(/&gt;/g,">")
  .replace(/&quot;/g,'"').replace(/&apos;/g,"'");
const val = (tag: string, name: string): string | null =>
  new RegExp('\\bw:' + name + '="([^"]+)"').exec(tag)?.[1] ?? null;
const allText = (xml: string): string =>
  [...xml.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)].map(m=>unescapeXml(m[1])).join(" ");
// Word Shape Line is a native drawingML <wps:wsp> with a:prstGeom="line".
 // An inline picture (<pic:pic>) is NEVER evidence of a genuine Shape Line.
const nativeLineShapes = (xml: string): string[] =>
  [...xml.matchAll(/<wp:anchor\b[\s\S]*?<\/wp:anchor>/g)]
    .map(m=>m[0])
    .filter(anchor=>/<wps:wsp\b/.test(anchor) && /<a:prstGeom\b[^>]*prst="line"/.test(anchor));
const paragraphs = (xml: string): string[] => [...xml.matchAll(/<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g)].map(m=>m[0]);
function asMm(v: string | null): number | null {
  if (!v || !Number.isFinite(Number(v))) return null;
  return Math.round(Number(v) / 56.6929133858 * 100) / 100;
}

/**
 * Independent, offline, non-destructive OOXML audit. ND30 style only:
 * this does not establish statutory applicability to a cooperative,
 * semantic correctness, signatory authority, or actual visual alignment.
 * A separate PDF/PNG visual receipt is ALWAYS needed for final approval.
 */
export async function auditAdminDocxBuffer(bytes: Uint8Array): Promise<AdminDocxAudit> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const zip = await JSZip.loadAsync(bytes);
  const doc = zip.file("word/document.xml");
  const styles = zip.file("word/styles.xml");
  if (!doc || !styles) throw new Error("Invalid DOCX: missing document.xml or styles.xml");
  const xml = await doc.async("string");
  const css = await styles.async("string");
  const sect = [...xml.matchAll(/<w:sectPr(?:\s[^>]*)?>[\s\S]*?<\/w:sectPr>/g)].map(m=>m[0]);
  if (!sect.length) errors.push("missing-page-section");
  let a4 = true;
  const mm: Record<string,number|null> = {top:null,bottom:null,left:null,right:null};
  for (const sec of sect) {
    const page = sec.match(/<w:pgSz\b[^>]*\/?>/)?.[0] ?? "";
    const mar = sec.match(/<w:pgMar\b[^>]*\/?>/)?.[0] ?? "";
    if (Math.abs(Number(val(page,"w"))-11906)>3 || Math.abs(Number(val(page,"h"))-16838)>3) {
      a4=false; errors.push("page-not-A4");
    }
    for (const [side,min,max] of [["top",20,25],["bottom",20,25],["left",30,35],["right",15,20]] as const) {
      const measured = asMm(val(mar,side));
      mm[side]=measured;
      if(measured===null || measured<min-0.35 || measured>max+0.35)
        errors.push(side+"-margin-out-of-range");
    }
  }
  const normal = [...css.matchAll(/<w:style\b[^>]*w:styleId="Normal"[^>]*>[\s\S]*?<\/w:style>/g)][0]?.[0] ?? "";
  const defaultRun = css.match(/<w:rPrDefault(?:\s[^>]*)?>[\s\S]*?<\/w:rPrDefault>/)?.[0] ?? "";
  const normalFonts = (normal.match(/<w:rFonts\b[^>]*\/>/)?.[0] ?? defaultRun.match(/<w:rFonts\b[^>]*\/>/)?.[0] ?? "");
  const font = val(normalFonts,"ascii") ?? val(normalFonts,"hAnsi");
  const sizeTag = normal.match(/<w:sz\b[^>]*\/>/)?.[0] ?? defaultRun.match(/<w:sz\b[^>]*\/>/)?.[0] ?? "";
  const size = Number(val(sizeTag,"val")) / 2;
  if(!font || font.toLowerCase()!=="times new roman") errors.push("normal-font-not-Times-New-Roman");
  if(!Number.isFinite(size) || size<13 || size>14) errors.push("normal-size-not-13-14pt");
  // Direct body overrides under 13 are noncompliant; header/table text uses separate ranges.
  const bodyXml=xml.replace(/<w:tbl(?:\s[^>]*)?>[\s\S]*?<\/w:tbl>/g,"");
  let below13 = 0;
  let bodyProseCount = 0;
  let bodyNotJustified = 0;
  let bodyIndentInvalid = 0;
  let bodySpacingInvalid = 0;
  let bodyLineSpacingInvalid = 0;
  for (const para of paragraphs(bodyXml)) {
    if(!allText(para).trim())continue;
    const heading=allText(para).trim();
    if (/^(QUYẾT ĐỊNH|GIẤY ỦY QUYỀN|BÁO CÁO|THÔNG BÁO|TỜ TRÌNH|KẾ HOẠCH)$/.test(heading)) continue;
    const overrides=[...para.matchAll(/<w:sz\b[^>]*w:val="(\d+)"[^>]*\/>/g)].map(m=>Number(m[1])/2);
    if(overrides.some(v=>v<13))below13++;
    // Check semantic body prose, not national motto, headings, signature or Nơi nhận.
    const content=heading;
    const explicitBody=/^(Căn cứ\s|Điều\s+\d+\.|[1-9]\.\s+(?:Công việc|Bên thụ hưởng|Chứng từ|Hoàn trả))/i.test(content);
    const longProse=content.length>=78 &&
      !/^(Về việc|Ghi chú kiểm tra|Nơi nhận|Kính gửi)/i.test(content) &&
      !/^[\p{Lu}\d\s.,:;()–\-/]+$/u.test(content);
    if (!(explicitBody || longProse)) continue;
    bodyProseCount++;
    const pPr=para.match(/<w:pPr(?:\s[^>]*)?>[\s\S]*?<\/w:pPr>/)?.[0] ?? "";
    const jc=pPr.match(/<w:jc\b[^>]*\/?>/)?.[0] ?? "";
    if(val(jc,"val")!=="both")bodyNotJustified++;
    const ind=pPr.match(/<w:ind\b[^>]*\/?>/)?.[0] ?? "";
    const lineStart=Number(val(ind,"firstLine"));
    // Data field labels may stay flush-left; full legal prose must start 1cm or 1.27cm in.
    if (explicitBody && (!Number.isFinite(lineStart) || lineStart<545 || lineStart>750))bodyIndentInvalid++;
    const spacing=pPr.match(/<w:spacing\b[^>]*\/?>/)?.[0] ?? "";
    const after=Number(val(spacing,"after"));
    if(!Number.isFinite(after) || after<120)bodySpacingInvalid++;
    const line=Number(val(spacing,"line"));
    const lineRule=val(spacing,"lineRule");
    if(!Number.isFinite(line) || line<240 || line>360 ||
        (lineRule!==null && lineRule!=="auto"))bodyLineSpacingInvalid++;
  }
  if(below13)errors.push("body-text-below-13pt");
  if(bodyNotJustified)errors.push("body-paragraphs-not-justified");
  if(bodyIndentInvalid)errors.push("body-first-line-indent-not-1-or-1.27cm");
  if(bodySpacingInvalid)errors.push("body-paragraph-gap-under-6pt");
  if(bodyLineSpacingInvalid)errors.push("body-line-spacing-outside-1-to-1.5");
  const headerTable=xml.match(/<w:tbl(?:\s[^>]*)?>[\s\S]*?<\/w:tbl>/)?.[0] ?? "";
  const hParas=paragraphs(headerTable);
  const mottoParagraph=hParas.find(x=>allText(x).includes("Độc lập - Tự do - Hạnh phúc"))??"";
  const issuerParagraph=hParas.find(x=>/HỢP TÁC XÃ|ỦY BAN|HỘI ĐỒNG|SỞ |PHÒNG |BỘ /.test(allText(x)))??"";
  const nativeLines=nativeLineShapes(xml);
  const hasMottoLine=nativeLines.some(line=>/name="NHD_Line_Duoi_Tieu_Ngu"/.test(line));
  const hasIssuerLine=nativeLines.some(line=>/name="NHD_Line_Duoi_Ten_HTX"/.test(line));
  // Other official templates may call them "Line 1"/"Line 2". Require two
  // genuine native Shape Lines; visual QA checks which line belongs to which label.
  const motto=!!mottoParagraph && (hasMottoLine || nativeLines.length>=2);
  const issuer=!!issuerParagraph && (hasIssuerLine || nativeLines.length>=2);
  if(!motto)errors.push("missing-or-undetected-motto-rule");
  if(!issuer)errors.push("missing-or-undetected-issuer-rule");
  if(nativeLines.length<2 && (/<pic:pic\b/.test(mottoParagraph) || /<pic:pic\b/.test(issuerParagraph)))
    errors.push("picture-substituted-for-native-Word-Shape-Line");
  const text=allText(xml);
  for(const marker of ["CỘNG HÒA XÃ HỘI CHỦ NGHĨA VIỆT NAM","Độc lập - Tự do - Hạnh phúc"]){
    if(!text.includes(marker))errors.push("missing:"+marker);
  }
  if(!/((Số:|Số\s*:)\s*[0-9]+\/|\[SỐ VĂN BẢN\])/.test(text))
    warnings.push("document-number-not-independently-verified");
  warnings.push("Mandatory: export PDF then run qa_admin_pdf_geometry.py --mode verify for true issuer/motto line width and position; inspect all rendered pages. Shape existence alone is not visual QA.");
  warnings.push("Verify scope, template precedence, charter authority, numbering register and signer before release.");
  const sha256=createHash("sha256").update(bytes).digest("hex");
  return {
    mode:"nd30_style",structuralPass:errors.length===0,
    status:errors.length?"blocked":"visual_qa_pending",
    visualQaRequired:true,readyToSign:false,sha256,
    errors:[...new Set(errors)],warnings,
    measured:{
      a4,marginsMm:mm,normalFont:font,normalSizePt:Number.isFinite(size)?size:null,
      mottoRuleDetected:motto,issuerRuleDetected:issuer,bodyBelow13Pt:below13,
      bodyProseCount,bodyNotJustified,bodyIndentInvalid,bodySpacingInvalid,bodyLineSpacingInvalid,
    },
  };
}
export async function auditAdminDocxFile(path: string): Promise<AdminDocxAudit> {
  return auditAdminDocxBuffer(await readFile(path));
}


# -*- coding: utf-8 -*-
"""NHD: DOCX-derived PDF visual geometry QA for government-style issuer/motto lines.
Use --mode plan before Word COM correction, then --mode verify on the final rendered PDF.
Neither mode claims legal approval, nor substitutes for a complete page visual review.
"""
import argparse, fitz, json, math, pathlib, hashlib, unicodedata, sys

def normalize(s): return unicodedata.normalize("NFC",s).strip()
def measure(pdf):
    doc=fitz.open(pdf)
    if not doc.page_count: raise ValueError("empty PDF")
    p=doc[0]
    textlines=[]
    for b in p.get_text("dict")["blocks"]:
        for ln in b.get("lines", []):
            txt=normalize("".join(sp.get("text","") for sp in ln["spans"]))
            if txt: textlines.append({"text":txt,"rect":fitz.Rect(ln["bbox"])})
    issuer=next((x for x in textlines if ("HỢP TÁC XÃ" in x["text"] or "ỦY BAN NHÂN DÂN" in x["text"] or "HỘI ĐỒNG NHÂN DÂN" in x["text"]) and x["rect"].y0<115),None)
    motto=next((x for x in textlines if "Độc lập - Tự do - Hạnh phúc" in x["text"] and x["rect"].y0<115),None)
    if not issuer or not motto:raise ValueError("issuer or motto not found in top page header")
    issuerlines=[x for x in textlines if x["rect"].x0<295 and 50<x["rect"].y0<115 and x["rect"].y0>=issuer["rect"].y0-2 and x["rect"].y0<issuer["rect"].y1+30 and x["text"] not in ("Số:",)]
    issuerbottom=max((x["rect"].y1 for x in issuerlines if x["rect"].y0<96),default=issuer["rect"].y1)
    lines=[]
    for item in p.get_drawings():
        r=item.get("rect")
        if r and r.height<1.6 and 40<=r.width<240 and 85<r.y0<150:
            lines.append(r)
    lines.sort(key=lambda z:z.x0)
    actualIssuer=next((z for z in lines if z.x0<295),None)
    actualMotto=next((z for z in lines if z.x0>=295),None)
    ratio=0.45
    target={
        "issuer": {"x":round(issuer["rect"].x0 + issuer["rect"].width*(1-ratio)/2,2),
                   "y":round(issuerbottom+6.0,2),
                   "width":round(issuer["rect"].width*ratio,2)},
        "motto": {"x":round(motto["rect"].x0,2),"y":round(motto["rect"].y1+7.5,2),
                  "width":round(motto["rect"].width,2)}
    }
    details={"docPages":len(doc),"issuerText":issuer["text"],"issuerTextBox":[round(z,2) for z in issuer["rect"]],
             "issuerBottom":round(issuerbottom,2),
             "mottoText":motto["text"],"mottoBox":[round(z,2) for z in motto["rect"]],
             "targets":target,"actual":{},"errors":[]}
    for name,r in (("issuer",actualIssuer),("motto",actualMotto)):
        details["actual"][name]=None if r is None else {"x":round(r.x0,2),"y":round(r.y0,2),"width":round(r.width,2)}
        if r is None:details["errors"].append(name+"-native-line-missing");continue
        t=target[name]
        gap=r.y0-(issuerbottom if name=="issuer" else motto["rect"].y1)
        centerDiff=abs((r.x0+r.x1)/2 - (t["x"]+t["width"]/2))
        if not 2.5<=gap<=12.5: details["errors"].append(name+"-line-vertical-gap-out-of-range")
        if centerDiff>7.5: details["errors"].append(name+"-line-horizontal-centre-out-of-range")
        if name=="issuer":
            actualRatio=r.width/issuer["rect"].width
            if not (0.325<=actualRatio<=0.525):details["errors"].append("issuer-line-length-not-1-3-to-1-2")
        elif abs(r.width-motto["rect"].width)>8: details["errors"].append("motto-line-length-not-text-width")
    return details

def main():
    ap=argparse.ArgumentParser();ap.add_argument("--pdf",required=True);ap.add_argument("--mode",choices=("plan","verify"),default="verify");ap.add_argument("--json")
    args=ap.parse_args()
    receipt=measure(args.pdf)
    receipt["pdfSha256"]=hashlib.sha256(pathlib.Path(args.pdf).read_bytes()).hexdigest()
    receipt["status"]="PASS" if not receipt["errors"] else "FAIL"
    result=json.dumps(receipt,ensure_ascii=True,indent=2)
    if args.json:pathlib.Path(args.json).write_text(result+"\n",encoding="utf-8")
    print(result)
    return 2 if args.mode=="verify" and receipt["errors"] else 0

if __name__=="__main__":sys.exit(main())


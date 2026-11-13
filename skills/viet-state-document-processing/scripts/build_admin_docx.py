# -*- coding: utf-8 -*-
"""NHD: dung DOCX van ban hanh chinh nha nuoc (the thuc ND 30/2020/ND-CP) tu file spec JSON.

Cach dung (qua NHD Harness terminal_preview/terminal_execute):
    python -I build_admin_docx.py <spec.json> <out.docx>

- Chi tao DU THAO. Khong bao gio ghi de file da co.
- Gach duoi ten co quan va tieu ngu la Word Shape Line that (wp:anchor + wps:wsp + prstGeom line),
  dung yeu cau cua office_admin_nd30_audit va office_admin_release_prepare.
- Moi doan than bai deu GHI TRUC TIEP jc=both, thut dau dong, cach doan, gian dong
  (gate khong chap nhan gia tri ke thua tu style).
- Bang dau/cuoi co tblGrid + tblW co dinh (neu khong LibreOffice chia deu cot -> quoc hieu xuong dong).
- In receipt JSON ASCII (console Windows cp1252 khong in duoc tieng Viet).
Xem references/spec-schema.md cho cau truc spec, references/gate-lessons.md cho cac loi da gap.
"""
import sys, json, hashlib
from pathlib import Path
from docx import Document
from docx.shared import Pt, Cm
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.enum.table import WD_TABLE_ALIGNMENT
from docx.oxml import parse_xml, OxmlElement
from docx.oxml.ns import qn
from PIL import ImageFont

if len(sys.argv) != 3:
    sys.exit('usage: build_admin_docx.py <spec.json> <out.docx>')
SPEC = Path(sys.argv[1]); OUT = Path(sys.argv[2])
if OUT.suffix.lower() != '.docx':
    sys.exit('output must be .docx')
if OUT.exists():
    sys.exit('Refusing to overwrite existing output: create a new versioned file name (v2, v3, ...)')
spec = json.loads(SPEC.read_text(encoding='utf-8'))
OUT.parent.mkdir(parents=True, exist_ok=True)

FONT = 'Times New Roman'
BOLD_TTF = r'C:\Windows\Fonts\timesbd.ttf'
QH = 'CỘNG HÒA XÃ HỘI CHỦ NGHĨA VIỆT NAM'
TN = 'Độc lập - Tự do - Hạnh phúc'
PH = '....................'
BODY_SPACING = float(spec.get('line_spacing', 1.15))
BODY_AFTER = float(spec.get('paragraph_after_pt', 6))
INDENT = float(spec.get('first_line_indent_cm', 1.27))
if not (1.0 <= BODY_SPACING <= 1.5): sys.exit('line_spacing must be 1.0-1.5')
if BODY_AFTER < 6: sys.exit('paragraph_after_pt must be >= 6')
if not (0.96 <= INDENT <= 1.32): sys.exit('first_line_indent_cm must be 1.0-1.27')

def text_width_emu(text, size_pt):
    f = ImageFont.truetype(BOLD_TTF, 1000)
    return int(round(f.getlength(text) / 1000.0 * size_pt * 12700))

doc = Document()
sec = doc.sections[0]
sec.page_width, sec.page_height = Cm(21.0), Cm(29.7)
sec.top_margin, sec.bottom_margin = Cm(2.0), Cm(2.0)
sec.left_margin, sec.right_margin = Cm(3.0), Cm(2.0)
sec.header_distance = Cm(1.0)
sec.different_first_page_header_footer = True
st = doc.styles['Normal']
st.font.name = FONT; st.font.size = Pt(14)
st.element.rPr.rFonts.set(qn('w:eastAsia'), FONT); st.element.rPr.rFonts.set(qn('w:cs'), FONT)
st.paragraph_format.space_after = Pt(BODY_AFTER); st.paragraph_format.space_before = Pt(0)
st.paragraph_format.line_spacing = BODY_SPACING

_sid = [100]
def shape_line(paragraph, width_emu, offset_pt):
    _sid[0] += 1; sid = _sid[0]
    xml = (
        '<w:r xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:drawing>'
        '<wp:anchor xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" '
        'distT="0" distB="0" distL="114300" distR="114300" simplePos="0" relativeHeight="%d" '
        'behindDoc="0" locked="0" layoutInCell="1" allowOverlap="1"><wp:simplePos x="0" y="0"/>'
        '<wp:positionH relativeFrom="column"><wp:align>center</wp:align></wp:positionH>'
        '<wp:positionV relativeFrom="paragraph"><wp:posOffset>%d</wp:posOffset></wp:positionV>'
        '<wp:extent cx="%d" cy="0"/><wp:effectExtent l="0" t="0" r="0" b="0"/><wp:wrapNone/>'
        '<wp:docPr id="%d" name="Line %d"/><wp:cNvGraphicFramePr/>'
        '<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">'
        '<a:graphicData uri="http://schemas.microsoft.com/office/word/2010/wordprocessingShape">'
        '<wps:wsp xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"><wps:cNvCnPr/>'
        '<wps:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="%d" cy="0"/></a:xfrm>'
        '<a:prstGeom prst="line"><a:avLst/></a:prstGeom>'
        '<a:ln w="9525"><a:solidFill><a:srgbClr val="000000"/></a:solidFill></a:ln></wps:spPr>'
        '<wps:bodyPr/></wps:wsp></a:graphicData></a:graphic></wp:anchor></w:drawing></w:r>'
    ) % (251659264 + sid, int(offset_pt * 12700), width_emu, sid, sid, width_emu)
    paragraph._p.append(parse_xml(xml))

def fmt(p, align=WD_ALIGN_PARAGRAPH.JUSTIFY, after=None, before=0, first=None, spacing=None, keep=False):
    f = p.paragraph_format
    p.alignment = align
    f.space_after = Pt(BODY_AFTER if after is None else after)
    f.space_before = Pt(before)
    if first is not None: f.first_line_indent = Cm(first)
    f.line_spacing = BODY_SPACING if spacing is None else spacing  # luon ghi truc tiep
    if keep: f.keep_with_next = True
    return p

def run(p, text, bold=False, italic=False, size=None):
    r = p.add_run(text); r.bold, r.italic = bold, italic; r.font.name = FONT
    if size: r.font.size = Pt(size)
    return r

def cell_para(cell, text, size, bold=False, italic=False, after=0, before=0, first=False, align=WD_ALIGN_PARAGRAPH.CENTER):
    p = cell.paragraphs[0] if first else cell.add_paragraph()
    fmt(p, align=align, after=after, before=before, spacing=1.0)
    if text: run(p, text, bold=bold, italic=italic, size=size)
    return p

def no_borders(tbl):
    b = OxmlElement('w:tblBorders')
    for e in ('top', 'left', 'bottom', 'right', 'insideH', 'insideV'):
        el = OxmlElement('w:' + e); el.set(qn('w:val'), 'nil'); b.append(el)
    tbl._tbl.tblPr.append(b)

def fixed_widths(tbl, widths_cm):
    tbl.autofit = False
    tblPr = tbl._tbl.tblPr
    lay = OxmlElement('w:tblLayout'); lay.set(qn('w:type'), 'fixed'); tblPr.append(lay)
    for row in tbl.rows:
        for c, w in zip(row.cells, widths_cm): c.width = Cm(w)
    for gc, w in zip(tbl._tbl.tblGrid.findall(qn('w:gridCol')), widths_cm):
        gc.set(qn('w:w'), str(int(round(w * 567))))
    old = tblPr.find(qn('w:tblW'))
    if old is not None: tblPr.remove(old)
    tw = OxmlElement('w:tblW'); tw.set(qn('w:w'), str(int(round(sum(widths_cm) * 567)))); tw.set(qn('w:type'), 'dxa')
    tblPr.append(tw)

# ---------------- Phan dau: co quan / quoc hieu ----------------
hdr_spec = spec['header']
L_W, R_W = hdr_spec.get('column_widths_cm', [6.3, 9.7])
chu_quan = hdr_spec.get('co_quan_chu_quan', [])        # in hoa, dung, khong dam
ban_hanh = hdr_spec['co_quan_ban_hanh']                # in hoa, dam; gach duoi dong cuoi
if not ban_hanh: sys.exit('header.co_quan_ban_hanh is required')
qh_w = text_width_emu(QH, 12)
if qh_w >= Cm(R_W - 0.4): sys.exit('Quoc hieu 12pt does not fit right column; widen column_widths_cm[1]')

hdr = doc.add_table(rows=1, cols=2); hdr.alignment = WD_TABLE_ALIGNMENT.CENTER
no_borders(hdr); fixed_widths(hdr, [L_W, R_W])
lc, rc = hdr.rows[0].cells
first = True
for t in chu_quan:
    cell_para(lc, t, 13, first=first); first = False
last = None
for t in ban_hanh:
    last = cell_para(lc, t, 13, bold=True, first=first); first = False
ref_line = hdr_spec.get('issuer_rule_reference', ban_hanh[0])
ag_line_w = int(text_width_emu(ref_line, 13) * float(hdr_spec.get('issuer_rule_ratio', 0.4)))
shape_line(last, ag_line_w, float(hdr_spec.get('issuer_rule_offset_pt', 21)))
# Dong So/ky hieu phai bat dau >= 105 pt tu mep trang, neu khong gate tinh nham la ten co quan.
cell_para(lc, hdr_spec['so_ky_hieu'], 13, before=float(hdr_spec.get('so_before_pt', 24)))
if spec.get('trich_yeu_cong_van'):          # Cong van: "V/v ..." duoi so ky hieu, co chu 12
    for i, t in enumerate(spec['trich_yeu_cong_van']):
        cell_para(lc, t, 12, before=6 if i == 0 else 0)

cell_para(rc, QH, 12, bold=True, first=True)
p_tn = cell_para(rc, TN, 13, bold=True)
tn_w = text_width_emu(TN, 13)
shape_line(p_tn, tn_w, float(hdr_spec.get('motto_rule_offset_pt', 22.5)))
cell_para(rc, hdr_spec['dia_danh_ngay'], 14, italic=True, before=float(hdr_spec.get('date_before_pt', 25)))

# ---------------- Ten loai + trich yeu ----------------
if spec.get('ten_loai'):
    p = doc.add_paragraph(); fmt(p, align=WD_ALIGN_PARAGRAPH.CENTER, before=18, after=0, spacing=1.0)
    run(p, spec['ten_loai'], bold=True)
    for t in spec.get('trich_yeu', []):
        p = doc.add_paragraph(); fmt(p, align=WD_ALIGN_PARAGRAPH.CENTER, after=0, spacing=1.0)
        run(p, t, bold=True)
    p = doc.add_paragraph(); fmt(p, align=WD_ALIGN_PARAGRAPH.CENTER, after=12, spacing=1.0)
    p.paragraph_format.left_indent = Cm(6.25); p.paragraph_format.right_indent = Cm(6.25)
    pb = OxmlElement('w:pBdr'); bt = OxmlElement('w:bottom')
    for k, v in (('w:val', 'single'), ('w:sz', '6'), ('w:space', '1'), ('w:color', '000000')): bt.set(qn(k), v)
    pb.append(bt); p._p.get_or_add_pPr().append(pb); run(p, ' ', size=4)

if spec.get('kinh_gui'):
    kg = spec['kinh_gui']
    if len(kg) == 1:
        p = doc.add_paragraph(); fmt(p, align=WD_ALIGN_PARAGRAPH.CENTER, before=12, after=12, spacing=1.0)
        run(p, 'Kính gửi: '); run(p, kg[0])
    else:
        p = doc.add_paragraph(); fmt(p, align=WD_ALIGN_PARAGRAPH.CENTER, before=12, after=0, spacing=1.0)
        run(p, 'Kính gửi:')
        for i, t in enumerate(kg):
            q = doc.add_paragraph(); fmt(q, align=WD_ALIGN_PARAGRAPH.LEFT, after=12 if i == len(kg) - 1 else 0, spacing=1.0)
            q.paragraph_format.left_indent = Cm(5.0); run(q, '- ' + t)

# ---------------- Than bai ----------------
for b in spec['body']:
    p = doc.add_paragraph()
    if 'h' in b:            # de muc: dam, giu voi doan sau
        fmt(p, first=INDENT, keep=True); run(p, b['h'], bold=True, italic=bool(b.get('italic')))
    elif 'runs' in b:       # [[text, bold, italic], ...]
        fmt(p, first=INDENT)
        for t, bo, it in b['runs']: run(p, t, bold=bo, italic=it)
    else:
        fmt(p, first=INDENT, keep=bool(b.get('keep'))); run(p, b['p'], bold=bool(b.get('bold')), italic=bool(b.get('italic')))

# ---------------- Noi nhan / khoi ky ----------------
ky = spec['signature']
ft = doc.add_table(rows=1, cols=2); ft.alignment = WD_TABLE_ALIGNMENT.CENTER
no_borders(ft); fixed_widths(ft, spec.get('footer_column_widths_cm', [8.0, 8.0]))
nc, sc = ft.rows[0].cells
if spec.get('noi_nhan'):
    p = nc.paragraphs[0]; fmt(p, align=WD_ALIGN_PARAGRAPH.LEFT, after=0, before=6, spacing=1.0)
    run(p, 'Nơi nhận:', bold=True, italic=True, size=12)
    for t in spec['noi_nhan']:
        q = nc.add_paragraph(); fmt(q, align=WD_ALIGN_PARAGRAPH.LEFT, after=0, spacing=1.0); run(q, t, size=11)
first = True
for t in ky.get('quyen_han', []):          # vd ["TM. ỦY BAN NHÂN DÂN"] hoac ["KT. CHỦ TỊCH"]
    cell_para(sc, t, 14, bold=True, first=first, before=6 if first else 0); first = False
cell_para(sc, ky.get('chuc_vu', PH), 14, bold=True, first=first, before=6 if first else 0)
for _ in range(int(ky.get('blank_lines', 4))): cell_para(sc, '', 14)
cell_para(sc, ky.get('ho_ten', PH), 14, bold=True)

# ---------------- So trang: giua, phia tren, tu trang 2 ----------------
hp = sec.header.paragraphs[0]; hp.alignment = WD_ALIGN_PARAGRAPH.CENTER
r = hp.add_run(); r.font.size = Pt(14); r.font.name = FONT
for tag, txt in (('begin', None), (None, 'PAGE'), ('end', None)):
    if tag:
        e = OxmlElement('w:fldChar'); e.set(qn('w:fldCharType'), tag); r._r.append(e)
    else:
        e = OxmlElement('w:instrText'); e.set(qn('xml:space'), 'preserve'); e.text = txt; r._r.append(e)

doc.save(OUT)
all_text = json.dumps(spec, ensure_ascii=False)
print(json.dumps({'status': 'DRAFT_DOCX_CREATED', 'docx': str(OUT),
                  'sha256': hashlib.sha256(OUT.read_bytes()).hexdigest(),
                  'placeholders_remaining': all_text.count('....'),
                  'motto_line_cm': round(tn_w / 360000, 3), 'issuer_line_cm': round(ag_line_w / 360000, 3),
                  'next': 'export PDF -> office_admin_release_prepare -> view every page -> review'},
                 ensure_ascii=True, indent=2))

# Spec JSON cho scripts/build_admin_docx.py

```jsonc
{
  "doc_type": "ke_hoach | cong_van | bao_cao | thong_bao | to_trinh | quyet_dinh",
  "header": {
    "co_quan_chu_quan": ["UBND TỈNH ..."],          // tùy chọn, in hoa, không đậm
    "co_quan_ban_hanh": ["ỦY BAN NHÂN DÂN", "XÃ ...."], // bắt buộc, in hoa, đậm; gạch dưới dòng cuối
    "so_ky_hieu": "Số: ......../KH-UBND",
    "dia_danh_ngay": "...., ngày ...... tháng ...... năm 2026",
    // tùy chọn: column_widths_cm [6.3, 9.7], so_before_pt 24, date_before_pt 25,
    // issuer_rule_reference, issuer_rule_ratio 0.4, issuer_rule_offset_pt 21, motto_rule_offset_pt 22.5
  },
  "ten_loai": "KẾ HOẠCH",            // null/bỏ với công văn
  "trich_yeu": ["dòng 1", "dòng 2"],  // dưới tên loại, đậm, có gạch ngắn
  "trich_yeu_cong_van": ["V/v ..."], // chỉ cho công văn: dưới Số, 12 pt
  "kinh_gui": ["Sở ..."],            // 1 nơi: cùng dòng; nhiều nơi: gạch đầu dòng
  "body": [
    {"p": "Căn cứ ...;", "italic": true},
    {"h": "I. MỤC ĐÍCH, YÊU CẦU"},          // đề mục đậm, keep-with-next
    {"p": "Đoạn văn thường."},
    {"runs": [["Chữ ", false, false], ["đậm", true, false]]}
  ],
  "noi_nhan": ["- Như trên;", "- Lưu: VT, ...."],
  "signature": {"quyen_han": ["TM. ỦY BAN NHÂN DÂN"], "chuc_vu": "CHỦ TỊCH", "ho_ten": "....", "blank_lines": 4},
  // tùy chọn: line_spacing 1.15 (1.0-1.5), paragraph_after_pt 6 (>=6), first_line_indent_cm 1.27, footer_column_widths_cm [8,8]
}
```

Placeholder dùng chuỗi `....................`. Builder đếm số `....` còn lại trong receipt.

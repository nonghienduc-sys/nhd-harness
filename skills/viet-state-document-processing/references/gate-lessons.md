# Bài học từ office_admin_release_prepare (đã gặp thật, CV 1499 v1→v6)

| Lỗi gate / hiện tượng | Nguyên nhân | Cách sửa (builder đã làm sẵn) |
|---|---|---|
| Quốc hiệu bị xuống 2 dòng trong PDF | Bảng không có tblGrid/tblW, LibreOffice chia đều cột | `fixed_widths`: tblLayout fixed + gridCol + tblW dxa; cột phải 9.7 cm, quốc hiệu 12 pt |
| "Số/ký hiệu" bị coi là một phần tên cơ quan | Dòng Số nằm quá sát (y0 < 105 pt) | `so_before_pt` = 24; ngày tháng `date_before_pt` = 25 |
| Thiếu gạch dưới tên cơ quan / tiêu ngữ | Dùng border đoạn hoặc ký tự "___" | Word Shape Line thật (wp:anchor + prstGeom line). Cơ quan: rộng 0.4 × độ rộng "ỦY BAN NHÂN DÂN" 13 pt đậm, offset 21 pt. Tiêu ngữ: rộng = độ rộng chữ tiêu ngữ, offset 22.5 pt |
| Đoạn thân bài "không căn đều / thiếu thụt đầu dòng / giãn dòng" | Giá trị kế thừa từ style, gate đọc pPr trực tiếp | `fmt()` luôn ghi jc=both, firstLine 1.27 cm, after ≥ 6 pt, line 1.15 auto trên từng đoạn |
| Số trang ở trang 1 | Không bật different first page | `different_first_page_header_footer = True`, trường PAGE giữa header |
| release_apply báo "preview missing" | Bug harness HTTP stateless (đã sửa v0.24.21) | Pending preview lưu đĩa có HMAC; nếu tái diễn, kiểm tra `runtime_identity` |
| Tên cơ quan Sở/Phòng bị nhận diện sai | Gate chỉ biết ỦY BAN NHÂN DÂN / HỘI ĐỒNG NHÂN DÂN / HỢP TÁC XÃ | Ghi rõ trong review; báo người dùng, không sửa văn bản để lách gate |

Nguyên tắc: khi gate báo lỗi, sửa **spec hoặc builder** rồi dựng version mới; không chỉnh tay PDF, không bỏ qua bước view_page.

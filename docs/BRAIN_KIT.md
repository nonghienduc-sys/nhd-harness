# Brain Kit — tri thức chung và tri thức riêng

Brain Kit trả về luật nền, quy trình phù hợp nhất, cổng kiểm, bài học đã duyệt, memory và trạng thái dự án bằng một lời gọi `brain_start`.

## Hai kho

- **Công khai:** `knowledge/` trong repository. Chỉ chứa quy tắc/mẫu giả, không có tên người, đường dẫn cá nhân, số liên hệ hay secret.
- **Riêng:** `knowledgeLocalDir` trong config, mặc định `<DATA_DIR>/knowledge-local`. Giá trị riêng ghi đè tệp công khai trùng `id`; không commit kho riêng.

Mỗi kho có `luat_nen.md` (luôn nạp, tối đa 1.500 ký tự), `quy_trinh/<id>.md`, `bai_hoc/<id>.md`, `memory/<id>.md`, `cong.json`. Có thể đặt thêm `ky_thi/cau_hoi.json` và `phan_hoi.jsonl` ở kho riêng.

## Front matter và quy trình

Tệp Markdown bắt đầu bằng `---`, metadata theo các khóa trong đặc tả, kết thúc khối bằng `---`. Tên tệp phải trùng `id`. Ví dụ:

```yaml
---
id: kiem_tra_bao_cao
ten: Kiểm tra báo cáo
tu_khoa: [báo cáo, rà soát]
khi_nao: Khi cần kiểm báo cáo
buoc:
  - so: 1
    viec: Đọc dữ liệu
  - so: 2
    viec: Kiểm nội dung
    cong: [kiem_noi_dung]
---
```

Bài học dùng `trang_thai: da_duyet` mới xuất hiện; nâng trạng thái phải theo quy trình duyệt riêng. Memory dùng `loai: user|feedback|project|reference`, `mo_ta` và thân Markdown; cấm bí mật/định danh. Công cụ `tri_thuc` hỗ trợ `list`, `get`, `search` và `write_memory` (hai bước preview/apply, chỉ kho riêng).

## Nạp memory Claude

Chạy `node scripts/nap-claude-memory.mjs --tu "<Claude memory dir>" --den "<private knowledge dir>/memory" --dry-run`, kiểm kết quả rồi bỏ `--dry-run` để ghi. Script bỏ `MEMORY.md`, `_archive`, làm sạch email, số điện thoại, secret và CCCD; đặt tên theo id ổn định nên chạy lại không nhân đôi. Giữ nội dung liên kết `[[...]]` và đọc front matter `name`, `description`, `metadata.type`.

CLI: `node dist/brain-kit-cli.js brain_start "soạn báo cáo rà soát chính sách" --json`. Có thể đặt `NHD_KNOWLEDGE_LOCAL_DIR` để trỏ kho riêng cho CLI. Tri thức không phải quyền hạn; tuân thủ preview, xác nhận và các cổng an toàn của harness.

## Vòng học P7

Sau nghiệm thu có lỗi, nghiem_thu.py ghi mỗi lỗi thành một dòng phản hồi cấu trúc trong kho riêng phan_hoi.jsonl (trừ khi bật --khong-ghi-phan-hoi). Chỉ ghi mã lỗi, quy trình và mã receipt, không chép nội dung văn bản hoặc định danh.

Tool MCP bai_hoc hỗ trợ analyze (gom số lỗi), propose (đề xuất khi lỗi lặp ít nhất hai lần), list, approve và reject. Hai thao tác duyệt bắt buộc task_run được ủy quyền mức high cùng giao dịch phase=preview rồi phase=apply với action_id và confirmation_token; brain không được tự duyệt. Bài học da_duyet được nạp qua brain_start. Nếu mã lỗi được SelfEvolutionEngine hỗ trợ, approval còn ghi metadata verified vào engine hiện có, không tự sửa skill.

CLI chỉ đọc: node dist/brain-kit-cli.js bai_hoc analyze --json hoặc bai_hoc list --json.
Chấm kỳ thi: python -I -X utf8 D:\NHD Nghiem Thu\cham_ky_thi.py D:\NHD Nghiem Thu\_tri_thuc --json (đặt dấu ngoặc kép quanh đường dẫn có khoảng trắng). Điểm được ghi nối vào ky_thi/ket_qua.jsonl.

Tri thức và bài học chỉ là dữ liệu tham khảo, không tự cấp quyền xóa, gửi, commit hoặc cutover.

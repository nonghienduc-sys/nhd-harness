# NHD Word Direct Execution Policy — v0.18.2

## Mục tiêu

Loại bỏ hai nguồn chậm/lỗi đã quan sát trong workflow TOEIC:

1. PowerShell quoting / nested `-Command` / dynamic evaluation.
2. Windows PowerShell 5.1 tự đoán sai encoding của `.ps1` UTF-8 không BOM.

Đồng thời bảo đảm các task Word đơn giản không đi vòng qua Terminal/COM khi Office Live đã biểu đạt được thao tác.

## Chính sách route

### Word Direct bắt buộc khi biểu đạt được

Các thao tác Word routine sau phải ưu tiên Office Live:

- append cuối tài liệu;
- insert tại con trỏ;
- replace selection/paragraph;
- font/đậm/nghiêng/gạch chân/màu chữ;
- paragraph formatting, spacing, indent, alignment;
- page setup đã được Office Live hỗ trợ;
- save qua Office Live.

Nếu ChatGPT cố gửi một Word COM routine tương đương vào Terminal, `TerminalService.preview()` fail-closed với `DIRECT_WORD_ROUTE_REQUIRED` trước khi process được tạo.

### PowerShell fallback chỉ cho thao tác Word thật sự chưa hỗ trợ

Ví dụ các cấu trúc phức tạp như table/shape/header/footer/field/content-control có thể vẫn cần fallback. Word fallback được clamp tối đa 30 giây, bất kể caller yêu cầu timeout lớn hơn.

## PowerShell UTF-8 runner

Terminal dùng hybrid launch để tránh overhead không cần thiết: command ASCII thông thường giữ `-Command` trực tiếp; command có Unicode và mọi standalone `.ps1` dùng UTF-16LE Base64 `-EncodedCommand` với preamble UTF-8 cho stdin/stdout.

Standalone `.ps1` fallback được Node đọc bằng UTF-8 trước, loại BOM nếu có, rồi chính nội dung script được encode trực tiếp vào `-EncodedCommand`. Vì vậy Windows PowerShell không tự đọc file và không còn cơ hội diễn giải UTF-8 không BOM thành ANSI.

Để giữ runner xác định, `.ps1` chỉ được phép gọi như một standalone script không đối số, ví dụ:

```powershell
& 'D:\path\fallback.ps1'
```

Nested `powershell -File ...` hoặc `.ps1` kèm arguments bị block với `POWERSHELL_SCRIPT_RUNNER_REQUIRED`. Nếu cần tham số, caller phải tạo một standalone self-contained fallback script hoặc nâng capability Office Live thay vì đẩy quoting/encoding xuống shell.

## Dynamic evaluation bị cấm

`Invoke-Expression` và alias `IEX` bị chặn ở Terminal preview, kể cả khi xuất hiện trong nội dung `.ps1` fallback. Không có automatic retry sau block/failure.

## Word formatting coverage bổ sung

`WordFormatSpec` có thêm:

```text
fontColorHex: #RRGGBB
```

Điều này cho phép workflow TOEIC giữ nguyên màu tiêu đề/đáp án đúng/đáp án sai/nhãn giải thích mà vẫn chạy hoàn toàn qua Word Live Direct.

## QA không đổi

Direct Word vẫn giữ:

```text
fingerprint target
→ preview/token transaction nội bộ
→ apply đúng một lần
→ exact text verify
→ per-block format verify
→ working-state update
→ visible Office QA (fail-closed nếu document identity không khớp)
```

Tối ưu tốc độ không được phép bỏ bước QA.

## Tests v0.18.2

Các regression mới kiểm tra:

- `Invoke-Expression` / `IEX` bị block;
- routine Word COM bị redirect trước execution;
- unsupported Word fallback bị clamp 30 giây;
- UTF-8 `.ps1` không BOM giữ đúng `Tiếng Việt – HS-482`;
- generic PowerShell Unicode output giữ đúng UTF-8;
- nested/argument-bearing `.ps1` bị block;
- Direct Word rich blocks chấp nhận `fontColorHex`.


## Stale connector schema compatibility (v0.18.3)

ChatGPT có thể giữ snapshot schema của một MCP connector trong suốt vòng đời chat. Khi runtime đã có `office_live_append`/`office_live_insert_at_cursor` nhưng chat cũ chỉ biết cặp `office_live_preview_edit` + `office_live_apply_edit`, NHD dùng compatibility fast lane thay vì đi vòng qua filesystem/Terminal.

Compatibility route tái sử dụng shape cũ `replace_selection(text)` với prefix nội bộ `NHD_WORD_DIRECT_V1:`. Payload là base64url JSON chứa `mode`, rich `blocks`, và `cursorOffset`. Server chỉ kích hoạt route khi prefix khớp tuyệt đối; mọi `replace_selection` thông thường giữ nguyên contract legacy yêu cầu selection không rỗng.

Sau decode, payload được chuyển thành chính operation V2 `word_append` hoặc `word_insert_at_cursor`, chạy cùng fingerprint/preview/apply-once/text+format verification/visual-QA như Direct Fast Lane mới. Prefix sai hoặc payload lỗi bị fail-closed trước khi chạm Word.

Mục tiêu của compatibility route chỉ là bỏ `.mjs + filesystem + terminal` trong một chat có schema cache cũ. Nó không ẩn, xóa hay thay đổi filesystem/Terminal/browser/PDF/OCR/video capabilities; các domain khác giữ nguyên tool surface. Chat mới có schema hiện hành vẫn dùng `office_live_append` / `office_live_insert_at_cursor` trực tiếp.

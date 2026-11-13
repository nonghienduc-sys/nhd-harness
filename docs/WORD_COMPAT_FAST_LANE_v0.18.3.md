# NHD Word Compatibility Fast Lane — v0.18.3

## Mục tiêu

Bỏ đường vòng `.mjs → filesystem → terminal → /mcp` cho các chat ChatGPT đã cache schema MCP cũ, nhưng không xóa hay làm yếu bất kỳ capability tổng quát nào.

## Vấn đề

Runtime v0.18.2 đã có `office_live_append` và `office_live_insert_at_cursor`, nhưng một chat đã mount connector trước khi hai tool này xuất hiện có thể vẫn chỉ thấy `office_live_preview_edit` và `office_live_apply_edit`. Đây là cache schema phía client/chat, không phải thiếu tool ở runtime.

## Compatibility Fast Lane

Hai tool cũ được giữ nguyên schema và hành vi. Chỉ khi `replace_selection.text` bắt đầu bằng prefix chính xác `NHD_WORD_DIRECT_V1:` thì server mới giải mã base64url JSON có dạng:

```json
{
  "mode": "append | insert_at_cursor",
  "blocks": [{"text":"...","format":{}}],
  "cursorOffset": 0
}
```

Payload sau decode được chuyển thành operation V2 chuẩn `word_append` hoặc `word_insert_at_cursor`. Nó dùng cùng fingerprint target, one-time preview token, apply exactly once, exact text verification, per-block formatting verification và visual QA như Direct Word tool mới.

## Backward compatibility

- `replace_selection` thông thường vẫn yêu cầu selection không rỗng và giữ nguyên contract v0.5.
- Prefix sai/payload lỗi fail-closed trước khi chạm Word.
- Chat mới vẫn ưu tiên `office_live_append` / `office_live_insert_at_cursor` trực tiếp.
- Chat schema cũ dùng `office_live_preview_edit → office_live_apply_edit` với envelope, không cần filesystem hay Terminal.

## Capability isolation

Không có tool nào bị xóa hoặc ẩn. Filesystem, Terminal, Browser, PDF/OCR, Video, Cốc Cốc, Excel, PowerPoint, durable task và MCP development giữ nguyên. Terminal vẫn là fallback cho thao tác Word thật sự ngoài capability Office Live.

## Lý do không đổi toàn bộ transport trong bản này

Stateful MCP + `notifications/tools/list_changed` có thể cải thiện discovery cho client hỗ trợ, nhưng thay đổi transport toàn server có blast radius lớn hơn và không bảo đảm ép một chat đã cache schema làm mới ngay. Compatibility Fast Lane giải quyết trực tiếp bottleneck hiện tại với phạm vi thay đổi nhỏ và có regression isolation.

## Deployment health parity

`/api/health` now exposes the same immutable Governor runtime policy used inside MCP `workstation_health`. The supervised cutover helper verifies that policy together with version, 104-tool registry, Word Direct tools, representative filesystem/Terminal/PDF/Cốc Cốc capabilities, OCR redundancy and 41/41 skill readiness before accepting v0.18.3. `src/server.ts` is included in both candidate snapshots and rollback restoration.

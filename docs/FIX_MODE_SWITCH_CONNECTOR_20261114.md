# NHD Harness — Kiểm tra đồng bộ công cụ chuyển chế độ (14/11/2026)

## Lỗi được xác nhận
- Trong production NHD v0.24.34, giao thức MCP ở `http://127.0.0.1:39104/mcp` trả 100 công cụ trong `tools/list`.
- Công cụ `harness_mode` hiện diện ở vị trí 0 của danh sách. Schema chính xác: `action: status|select|verify`, `mode: harness|self|direct`, `task_run_id`, `confirmed`.
- Gọi `harness_mode action=status` từ MCP local đã thành công, nhận `mode=self`, `modeNumber=2`, `scope=shared-core-runtime`, `directExecution=true`.
- Trong danh sách công cụ được phiên ChatGPT đang mở cấp cho plugin NHD Harness chỉ có 99 công cụ. So sánh hai danh sách cho thấy **công cụ thiếu duy nhất là `harness_mode`**. Đây không phải lỗi ở policy BRAIN_ONLY và không phải do giới hạn cắt 99 tool cuối danh sách, bởi `harness_mode` đứng đầu danh sách MCP.
- Do đó khi Chế độ 1 bật, Brain bị hạn chế bởi BRAIN_ONLY và không thấy công cụ chuyển chế độ; trong Chế độ 2, có thể dùng Terminal truy cập MCP nội bộ để chuyển về Chế độ 1. Vấn đề thuộc lớp **khám phá/đồng bộ tool schema của plugin ChatGPT**.

## Thao tác sửa đã thực hiện
- Tìm đúng plugin private `NHD Harness` của người dùng, plugin id `plugin_asdk_app_6af6b8e969048191bc464b6248ee6624`.
- Kiểm tra manifest hiện tại, giữ nguyên App binding, tên, mô tả và cấu hình.
- Cập nhật phiên bản plugin từ 1.0.0 lên **1.0.1**, release `pluginrel_6af78d2b30c88191a57a50d55dddd301`, nhằm tái phát hành metadata và tạo điều kiện làm mới công cụ được khám phá.
- Kiểm tra lại plugin metadata: **1.0.1** chính thức.
- Kiểm tra lại danh sách công cụ trong **phiên ChatGPT hiện tại**: vẫn 99, chưa có `harness_mode`. Không giả định việc cập nhật metadata là đủ để làm mới một phiên ChatGPT đã mở.

## Ranh giới và bước kiểm tra còn lại
1. **Chưa nghiệm thu qua ChatGPT tool invocation**: cần mở phiên ChatGPT mới hoặc làm mới kết nối plugin NHD Harness để kiểm tra xem `harness_mode` xuất hiện hay chưa. Không thể thay đổi danh sách công cụ được cấp cho phiên chat đang mở từ phía mã nguồn Windows.
2. Nếu phiên mới vẫn chỉ có 99 công cụ, cần làm mới schema tại lớp cấu hình App SDK/plugin connector của ChatGPT (hoặc kết nối lại plugin), chứ không thêm đường tắt ẩn qua `task_run`, `tool_governor` hoặc cho phép Terminal trong BRAIN_ONLY.
3. Khi công cụ xuất hiện, chạy thử **1→2→1** qua chính `harness_mode`, dùng task đang chạy, ủy quyền moderate và `confirmed=true`, kiểm tra `runtime/brain-mode.json` và quyền `fs_read` sau từng lượt.
4. Production backend vẫn **v0.24.34**; candidate **v0.24.35-d4e9be6fbf71** đã được staged trước đó cho tính năng handoff worker, không liên quan trực tiếp lỗi thiếu công cụ và chưa cutover.
5. Không thay đổi safety policy, không reboot, không thay đổi chế độ hiện tại `self`.

## Phán quyết
**Plugin metadata: UPDATED 1.0.1.**
**Khả năng chuyển chế độ trong MCP backend: PASS.**
**Khả năng chuyển chế độ hai chiều ngay từ phiên ChatGPT hiện tại: NOT YET VERIFIED, tool list stale.**


## Cập nhật xử lý thực tế — ChatGPT Plugin UI
- Mở đúng `https://chatgpt.com/settings/plugins-settings/plugin_asdk_app_6af6b8e969048191bc464b6248ee6624` trong Cốc Cốc đăng nhập bằng chính tài khoản sử dụng NHD Harness.
- Giao diện xác nhận plugin **NHD Harness v1.0.1**, kết nối OAuth hiện có, endpoint `https://mcp.nhdmcp.io.vn/mcp`.
- Đã **bấm nút "Làm mới công cụ"** trong mục Quản lý ứng dụng ("Load the latest tools from the app's MCP server") bằng công cụ Cốc Cốc DOM. Công cụ báo `ok: true` cho thao tác click; không có xác nhận độc lập về số lượng tool sau khi backend đồng bộ.
- Sau đó chọn "Thử trong trò chuyện", giao diện mở một tab soạn trò chuyện mới với plugin NHD Harness đã chọn.
- Tại phiên chat cũ, danh sách công cụ vẫn cố định 99 và thiếu `harness_mode`. Đây là bộ công cụ được host gắn với phiên; cập nhật app không đồng nghĩa hot reload cùng phiên.
- Đã thử thực hiện kiểm tra từ tab mới nhưng NHD Cốc Cốc DOM trả timeout trên tab nền; cố gắng kích hoạt tab bị chặn bởi chính sách `Background mode cannot activate/switch a host Cốc Cốc tab`. **Không lách cơ chế bảo vệ foreground, không gửi tin nhắn thử nghiệm.**
- Bằng chứng nguồn về cơ chế refresh: OpenAI Help Center `https://help.openai.com/en/articles/12584461-developer-mode-and-full-mcp-connectors-in-chatgpt` và OpenAI Plugins docs `https://developers.openai.com/plugins/deploy/connect-chatgpt`. Hai nguồn đều chỉ rõ cần Refresh và mở conversation mới để kiểm tra thay đổi MCP tool.
- **Nghiệm thu chưa hoàn tất:** cần xác thực một lần bằng chat mới đã mở sẵn, gọi `harness_mode action=status` rồi thử chuyển 1→2→1 qua task-scoped authorization. Không khẳng định lỗi đã được sửa cho đến khi có biên nhận từ phiên ChatGPT mới.
- Không cập nhật mã nguồn, không chuyển production, không thay đổi chế độ hiện tại.

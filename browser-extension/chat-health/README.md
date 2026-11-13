# NHD MCP Chat Health Sensor

Browser extension (Manifest V3) dành cho Chromium/Cốc Cốc/Edge để đo hiệu năng tab `chatgpt.com` và gửi telemetry cục bộ về NHD MCP.

## Telemetry được gửi
- Conversation path/id (không có nội dung chat)
- Số conversation turn ước tính từ DOM
- Interaction latency / INP proxy từ Event Timing
- FPS cửa sổ gần nhất
- JavaScript heap nếu trình duyệt cung cấp `performance.memory`
- DOM node count
- Long tasks >= 50 ms trong 60 giây gần nhất
- Thời lượng session kể từ khi sensor bắt đầu theo dõi conversation

Sensor chỉ report khi tab ChatGPT đang visible để tránh background throttling làm sai FPS.

## Không thu thập
- Prompt hoặc câu trả lời
- Text trong conversation
- File / attachment
- Cookie, token, password hoặc credential
- Lịch sử trình duyệt ngoài tab ChatGPT

## Cài thủ công trên Chromium/Cốc Cốc
1. Mở trang quản lý Extensions của trình duyệt.
2. Bật Developer mode.
3. Chọn **Load unpacked**.
4. Chọn thư mục `browser-extension/chat-health`.
5. Mở hoặc reload `https://chatgpt.com/`.
6. Dashboard NHD MCP > Chat Health sẽ nhận telemetry sau vài giây nếu backend đang chạy phiên bản có `/api/chat-health/report`.

Endpoint mặc định: `http://127.0.0.1:39100`. Có thể đổi trong Options của extension nhưng chỉ chấp nhận localhost.

## Đo tốc độ ChatGPT Plus (ước tính)

Từ bản mở rộng 2026-11-08, chỉ trên `chatgpt.com`, script `stream-speed-observer.js` theo dõi các thay đổi của phản hồi đang sinh để ước tính thời gian đến văn bản đầu tiên (TTFV), ký tự/giây và token/giây quy đổi từ ký tự/4. Không lấy token ẩn hoặc thông tin từ API OpenAI. Kết quả phản hồi một lần, tab nền hoặc không thấy rõ lúc kết thúc được đánh dấu độ tin cậy thấp.

Dữ liệu bộ đo **không gồm nội dung prompt, đáp án hay URL cuộc trò chuyện**. Lưu tối đa 2000 dòng metadata trong `chrome.storage.local`; có thể xuất CSV/JSONL tại Options và đồng bộ về NHD localhost. Khi backend hỗ trợ route `/api/benchmarks/response-speed/sample`, dữ liệu cũng được lưu tại `D:\NHD Projects\Model Benchmark MCP\ChatGPT Plus UI`.

Bật/tắt, gắn nhãn model và nhóm tác vụ trong Options. Chỉ tính những phản hồi **bắt đầu sau khi extension được kích hoạt**; không khôi phục lại tốc độ của câu trả lời cũ. Bộ quan sát chỉ theo dõi thay đổi DOM của ChatGPT và không quét định kỳ khi không có câu đang trả lời.

# Playbook runner: con trỏ bước và cổng kiểm

Brain khởi đầu bằng brain_start để chọn quy trình. Gọi MCP quy_trinh_chay với op=start, quy_trinh_id, muc_tieu, và bien là bản đồ biến đầu vào. start tạo pb-UUID. op=next trả bước hiện tại, lệnh cổng đã thay biến (chỉ hiển thị), cổng còn thiếu biến và các bài học da_duyet. Brain thực hiện công việc; gọi op=done_step, run_id, so, ghi_chu và bổ sung bien nếu cần. Bước không có cổng tiến ngay. Bước có cổng được thực thi bằng TerminalService (preview + execute); đánh giá qua chính verifyReceiptChecks (exit, regex, timeout), ghi lại output 2000 ký tự cuối + thời điểm. Nếu trượt, con trỏ đứng yên; brain sửa và gọi lại đúng bước. Không được bỏ qua bước. Bước cuối hoàn thành thì tạo receipt và nghiệm thu bằng công cụ độc lập. op=status, op=list và op=abort cho phép theo dõi hoặc hủy run (không xóa chứng cứ).

Trạng thái nằm ở DATA_DIR/playbook-runs/pb-UUID.json: cùng vùng dữ liệu bền với các dịch vụ NHD khác, tách khỏi repo công khai và kho tri thức. Mỗi lần chỉnh có ghi tệp tạm rồi thay tên nguyên tử; khóa .lock bảo vệ khỏi hai brain cùng tiến bước, tự thu hồi khóa quá 10 phút. Tạo runner mới với cùng dataDir khôi phục đúng con trỏ. Quy trình/bước được snapshot khi start; danh mục cổng và bài học được tải mới mỗi lần dùng.

cong.json là nguồn duy nhất cấp mẫu lệnh; biến từ brain chỉ thay placeholder, không nhận nguyên lệnh. Giá trị biến chứa dấu ngoặc kép/nháy, pipe, redirect, dấu chấm phẩy, nối lệnh, dollar, backtick, xuống dòng, phần trăm đều bị từ chối. Thiếu biến: từ chối trước khi chạy. CWD lấy thư mục chứa bien.tep (nếu là đường dẫn tuyệt đối) hoặc cwd từ cổng, nếu không có tep dùng cwd tiến trình. Timeout mặc định 300 giây; timeout_s của cổng có thể tùy biến 1–1800 giây. TerminalService vẫn áp dụng policy/authorization/confirmation; trường hợp yêu cầu xác nhận riêng thì runner dừng, không tự cấp quyền.

CLI dùng chung runner:
- node dist/brain-kit-cli.js quy_trinh_chay list --json
- node dist/brain-kit-cli.js quy_trinh_chay start --quy-trinh-id ID --muc-tieu "..." --bien '{"tep":"..."}'
- node dist/brain-kit-cli.js quy_trinh_chay next --run-id pb-...
- node dist/brain-kit-cli.js quy_trinh_chay done_step --run-id pb-... --so 1

Không commit, push, cutover, restart hoặc thay đổi version trong P6.

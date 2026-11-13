// 2026-11-13: Việt hóa nhãn giao diện theo kiểu khớp CHÍNH XÁC cả nút văn bản.
// Chỉ thay nhãn tĩnh/trạng thái; tên sản phẩm (MCP, Word, PowerShell, OCR...) giữ nguyên.
// Không đụng tới .path, code, pre, input, textarea hay dữ liệu người dùng (tên tab chat, tên dự án).
(() => {
  const VI = {
    // Thanh bên / tiêu đề
    'Task Runs': 'Tác vụ', 'Token & Chat Health': 'Token & sức khỏe chat', 'Office & Files': 'Office & tệp',
    'Desktop & Intake': 'Máy tính & tiếp nhận', 'Skills & Tools': 'Kỹ năng & công cụ', 'This machine': 'Máy này',
    'MCP Online': 'MCP đang chạy', 'All systems operational': 'Mọi hệ thống hoạt động bình thường',
    'Tools & Skills': 'Công cụ & kỹ năng', 'Connections': 'Kết nối', 'Activity': 'Hoạt động',
    'Security & Permissions': 'Bảo mật & quyền', 'Machine & Runtime': 'Máy & môi trường chạy', 'Automation': 'Tự động hóa',
    'Files & Microsoft Office': 'Tệp & Microsoft Office', 'Projects theo task': 'Dự án theo tác vụ',
    'Chat Health & Token Monitor': 'Theo dõi sức khỏe chat & token', 'Memory health': 'Tình trạng bộ nhớ',
    'Background + Isolated Agent': 'Nền + Agent cách ly',
    // Eyebrow
    'CROSS-CHAT MEMORY': 'BỘ NHỚ XUYÊN CHAT', 'CONNECTION CENTER': 'TRUNG TÂM KẾT NỐI', 'WORKSPACE': 'KHÔNG GIAN LÀM VIỆC',
    'COMPUTER ACCESS': 'TRUY CẬP MÁY TÍNH', 'AUTOMATION': 'TỰ ĐỘNG HÓA', 'DUAL EXECUTION LANES': 'HAI LUỒNG THỰC THI',
    'CAPABILITIES': 'NĂNG LỰC', 'AUDIT': 'NHẬT KÝ', 'SECURITY': 'BẢO MẬT', 'SETTINGS': 'CÀI ĐẶT', 'PROJECTS': 'DỰ ÁN',
    'MULTI-TAB CHAT PERFORMANCE': 'HIỆU NĂNG NHIỀU TAB CHAT', 'CHAT TABS': 'CÁC TAB CHAT', 'SELECTED TAB': 'TAB ĐANG CHỌN',
    'HISTORY': 'LỊCH SỬ', 'PERFORMANCE': 'HIỆU NĂNG', 'MEMORY PRESSURE': 'ÁP LỰC BỘ NHỚ', 'CONTEXT SIZE': 'KÍCH THƯỚC NGỮ CẢNH',
    'HANDOFF QUEUE': 'HÀNG ĐỢI BÀN GIAO', 'DURABLE PLAN': 'KẾ HOẠCH BỀN VỮNG', 'UPGRADE PLAN': 'KẾ HOẠCH NÂNG CẤP',
    'DURABLE MULTI-PHASE PLAN': 'KẾ HOẠCH NHIỀU GIAI ĐOẠN', 'RESULT PAYLOAD TELEMETRY': 'KÍCH THƯỚC KẾT QUẢ CÔNG CỤ',
    'GITHUB RELEASES': 'BẢN PHÁT HÀNH GITHUB',
    // Chỉ số
    'Tracked tabs': 'Tab theo dõi', 'Active now': 'Đang hoạt động', 'Handoff ready': 'Sẵn sàng bàn giao', 'Critical': 'Nguy cấp',
    'Lowest score': 'Điểm thấp nhất', 'Average score': 'Điểm trung bình', 'Max est. tokens': 'Token ước tính cao nhất',
    'Avg est. tokens': 'Token ước tính TB', 'Chat / Tab': 'Chat / tab', 'Score': 'Điểm', 'Level': 'Mức', 'Presence': 'Hiện diện',
    'Turns': 'Lượt', 'Est. tokens': 'Token ước tính', 'Last seen': 'Thấy lần cuối', 'Last seen:': 'Thấy lần cuối:',
    'First seen:': 'Thấy lần đầu:', 'Long tasks': 'Tác vụ dài', 'Session': 'Phiên', 'Context tokens (est.)': 'Token ngữ cảnh (ước tính)',
    'User tokens (est.)': 'Token người dùng (ước tính)', 'Assistant tokens (est.)': 'Token trợ lý (ước tính)', 'Budget used': 'Đã dùng ngân sách',
    'Archive tab': 'Lưu trữ tab', 'Health Score': 'Điểm sức khỏe', 'Estimated tokens': 'Token ước tính', 'Auto checkpoint': 'Tự lưu checkpoint',
    'Handoff threshold': 'Ngưỡng bàn giao', 'Token realtime': 'Token thời gian thực', 'User': 'Người dùng', 'Assistant': 'Trợ lý',
    'Context budget': 'Ngân sách ngữ cảnh', 'Pending actions': 'Hành động chờ', 'Memory & Resume': 'Bộ nhớ & tiếp tục',
    'Memory status': 'Trạng thái bộ nhớ', 'Projects': 'Dự án', 'Unresolved': 'Chưa giải quyết', 'Documents': 'Tài liệu', 'Decisions': 'Quyết định',
    'Active project root': 'Thư mục dự án đang dùng', 'Checkpoint policy': 'Chính sách checkpoint', 'Resume strategy': 'Cách tiếp tục',
    'Edit session': 'Phiên chỉnh sửa', 'Latest QA': 'Kiểm tra gần nhất', 'Updated': 'Cập nhật',
    'Tool result size': 'Kích thước kết quả công cụ', 'Recent calls': 'Lượt gọi gần đây', 'Result chars': 'Số ký tự kết quả',
    'Latency': 'Độ trễ', 'Budget': 'Ngân sách', 'Tool': 'Công cụ', 'Action': 'Hành động', 'Status': 'Trạng thái',
    'UI windows': 'Cửa sổ UI', 'Inbox roots': 'Thư mục inbox', 'PDF render': 'Dựng PDF', 'Screen sources': 'Nguồn chụp màn hình',
    'Displays': 'Màn hình', 'Companion status': 'Trạng thái companion', 'Active tasks': 'Tác vụ đang chạy', 'Paused tasks': 'Tác vụ tạm dừng',
    'Pending approvals': 'Chờ phê duyệt', 'Background': 'Nền', 'Isolated Agent': 'Agent cách ly', 'Scheduler': 'Bộ điều phối',
    'Start Isolated Agent': 'Khởi động Agent cách ly', 'Stop Isolated Agent': 'Dừng Agent cách ly', 'Terminal safety:': 'An toàn terminal:',
    'MCP Tool Registry': 'Danh mục công cụ MCP', 'Instance ID': 'Mã phiên bản', 'Data directory': 'Thư mục dữ liệu', 'Root': 'Thư mục gốc', 'Mode': 'Chế độ',
    'File write': 'Ghi tệp', 'Screen Access': 'Truy cập màn hình', 'Desktop Navigation': 'Điều hướng desktop',
    'Visual click fallback': 'Nhấp theo hình ảnh (dự phòng)', 'Document Intake': 'Tiếp nhận tài liệu', 'OAuth pairing': 'Ghép nối OAuth',
    'Duplicate NHD MCP Guard': 'Chống trùng NHD MCP', 'Harness Clients': 'Client harness', 'Remote Cloudflare MCP': 'MCP từ xa (Cloudflare)',
    'OpenAI Private Tunnel': 'Đường hầm riêng OpenAI', 'tunnel-client not installed': 'chưa cài tunnel-client',
    'Remote MCP — Cloudflare': 'MCP từ xa — Cloudflare', 'Waiting for 3 more low-score sample(s).': 'Chờ thêm 3 mẫu điểm thấp.',
    // Trạng thái
    'Online': 'Trực tuyến', 'Offline': 'Ngoại tuyến', 'ONLINE': 'TRỰC TUYẾN', 'OFFLINE': 'NGOẠI TUYẾN', 'Healthy': 'Tốt', 'HEALTHY': 'TỐT',
    'Growing': 'Đang tăng', 'Handoff': 'Bàn giao', 'Handoff recommended': 'Nên bàn giao', 'Handoff now': 'Bàn giao ngay', 'Watch': 'Theo dõi',
    'Ready': 'Sẵn sàng', 'Available': 'Sẵn có', 'Unavailable': 'Không khả dụng', 'Checking': 'Đang kiểm tra', 'Active': 'Đang hoạt động',
    'Off': 'Tắt', 'Auto ON': 'Tự động: BẬT', 'None': 'Không có', 'No': 'Không', 'Due': 'Đến hạn',
    'completed': 'đã xong', 'expired': 'hết hạn', 'idle': 'rảnh', 'stale': 'cũ', 'running': 'đang chạy', 'paused': 'tạm dừng',
    'failed': 'thất bại', 'cancelled': 'đã hủy', 'planned': 'đã lên kế hoạch', 'success': 'thành công', 'verified': 'đã xác minh',
    'active': 'đang hoạt động', 'normal': 'bình thường',
  };
  const SKIP = 'script,style,code,pre,textarea,input,.path,.project-path,.detail pre,[data-no-vi]';
  const tr = node => {
    const raw = node.nodeValue; const key = raw && raw.trim();
    if (!key || key.length > 60 || !Object.prototype.hasOwnProperty.call(VI, key)) return;
    const p = node.parentElement; if (!p || p.closest(SKIP)) return;
    node.nodeValue = raw.replace(key, VI[key]);
  };
  const walk = root => {
    if (root.nodeType === 3) return tr(root);
    if (root.nodeType !== 1) return;
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT); let n;
    while ((n = w.nextNode())) tr(n);
  };
  walk(document.body);
  new MutationObserver(ms => { for (const m of ms) { if (m.type === 'characterData') tr(m.target); else m.addedNodes.forEach(walk); } })
    .observe(document.body, { childList: true, subtree: true, characterData: true });
})();

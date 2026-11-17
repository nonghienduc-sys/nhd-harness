# Word Live song song nhiều tài liệu — 0.24.38

## Mục đích

Word Live hỗ trợ sửa nhiều DOCX khác nhau cùng lúc. Mỗi tệp có một PowerShell worker riêng và một tiến trình WINWORD riêng do NHD Harness tạo. Các bước mở Word COM được điều phối bằng mutex ngắn để xác nhận PID, còn thao tác chỉnh sửa diễn ra song song. Không ảnh hưởng Word hay tài liệu người dùng đang mở.

**Tương thích:** không truyền tham số path, Word/Excel/PowerPoint tiếp tục dùng phiên Office đang mở theo hành vi cũ; tuyệt đối không đóng phiên của người dùng.

## Cách gọi

Các tool office_live_read, office_live_preview_edit, office_live_apply_edit, office_live_transaction hỗ trợ đường dẫn tuyệt đối DOCX qua tham số path khi application=word.

- office_live_read(application=word, path=C:\path\to\file.docx, read_only=true): mở/kiểm tra tài liệu mẫu trong phiên độc lập.
- office_live_preview_edit(application=word, path=C:\path\to\file.docx, operation=...): lấy fingerprint trước khi sửa.
- office_live_apply_edit(action_id=..., confirmation_token=..., path=C:\path\to\file.docx): path phải trùng đường dẫn đã preview; chỉ áp dụng đúng một lần.
- office_live_transaction(application=word, path=C:\path\to\file.docx, operations=[...]): giao dịch gồm nhiều thao tác, kiểm tra fingerprint từng bước.
- office_live_close(path=C:\path\to\file.docx): chỉ đóng phiên Word do Harness sở hữu. Thay đổi chưa word_save bị hủy.
- office_live_sessions(): liệt kê path, PID WINWORD, PID worker, lúc mở, lần sử dụng cuối.

Các thao tác word_replace_paragraph, word_format_paragraphs, word_save và các thao tác Word Live V2 khác chỉ chạy trên tài liệu được chỉ định. read_only=true dùng cho mẫu; mọi lệnh sửa và lưu bị từ chối với WORD_LIVE_READ_ONLY. Đóng phiên trước khi đổi chế độ mở.

## Giới hạn song song

Mặc định tối đa **4** phiên; cấu hình NHD_WORD_LIVE_MAX_INSTANCES trước khi khởi động companion (1–32). Khi hết chỗ, chờ tối đa 60 giây theo NHD_WORD_LIVE_POOL_WAIT_MS, sau đó trả WORD_LIVE_POOL_BUSY. Các yêu cầu cùng đường dẫn được chuẩn hóa realpath/không phân biệt hoa thường và xếp hàng tuần tự; các tệp khác nhau xử lý song song. Sau mỗi tệp luôn gọi close để nhường chỗ.

Tự đóng khi rảnh 10 phút theo NHD_WORD_LIVE_IDLE_MS (mặc định 600000 ms), khi lỗi/timeout hoặc lúc Harness dừng. Không tự lặp thao tác thất bại hoặc có kết quả chưa rõ.

## Lỗi và khóa tệp

- Trước khi tạo phiên, bridge cũ đọc danh sách Documents hiện mở của Word người dùng. Tệp trùng đường dẫn sẽ bị từ chối, không sửa hoặc đóng Word người dùng.
- WORD_LIVE_FILE_IN_USE: tệp đang bị chiếm. Trước khi mở Word, kiểm tra tệp bằng .NET FileShare.None, tránh hộp thoại File In Use; nếu có tệp khóa Word thì kèm chủ khóa khi đọc được.
- stale_lock=true: có tệp ~$ nhưng tài liệu gốc không còn bị giữ. Chỉ cảnh báo; chỉ xóa tệp khóa cũ nếu truyền remove_stale_lock=true.
- WORD_LIVE_POOL_BUSY: vượt giới hạn số phiên và thời gian chờ.
- WORD_LIVE_READ_ONLY: tài liệu mở chỉ đọc không được sửa/lưu.
- WORD_LIVE_OPERATION_TIMEOUT, WORD_LIVE_START_TIMEOUT, WORD_LIVE_SHARED_INSTANCE: không phát lại thao tác; dọn phiên xác định được.

Phiên có path chạy ẩn, không chụp cửa sổ Word của người dùng để làm QA. Kiểm tra máy dựa trên COM/XML; định dạng cần QA trực quan riêng khi phát hành tài liệu.

## Bảo vệ Word của người dùng và dọn mồ côi

- Chỉ đóng hoặc dừng đúng PID WINWORD mà Harness tạo và đã xác thực PID **cùng thời điểm StartTime**; không bao giờ dừng theo tên WINWORD, không chạm vào Word người dùng.
- Worker dùng COM riêng, Visible=false, DisplayAlerts=0, Documents.Open với ConfirmConversions=false, AddToRecentFiles=false và ReadOnly theo cờ; worker path không gọi GetActiveObject. Hàm inspect/edit được dùng chung với bridge cũ bằng cách truyền word/doc, không sao chép nghiệp vụ.
- Word ẩn thường không có HWND, vì vậy nhận PID bằng chênh lệch danh sách WINWORD trước/sau tạo COM trong mutex khởi tạo. Nếu không xuất hiện đúng một tiến trình mới, không đóng PID không xác định.
- Sổ phiên lưu ngoài kho tại %LOCALAPPDATA%\nhd-harness\word-live-sessions.json; có path, PID worker, PID WINWORD, StartTime, chủ phiên, lúc mở/lần dùng cuối. Khi khởi động và định kỳ, dọn chỉ các bản ghi mồ côi có chủ tiến trình đã kết thúc, PID còn mang tên WINWORD và StartTime khớp.
- Đóng có kiểm soát Document.Close(false), Word.Quit(), giải phóng COM; nếu quá hạn chỉ dừng PID thuộc chính phiên đó đã xác thực. Không lưu nếu chưa có word_save.

## Cách dùng với nhiều tab ChatGPT

Mỗi tab phụ trách một tệp DOCX khác nhau, luôn truyền path và kiểm tra lại path trả về. Preview trước khi apply hoặc dùng transaction, lưu qua word_save, cuối cùng gọi office_live_close(path). Với tài liệu mẫu dùng read_only=true và đóng sau đọc.

## Kiểm chứng độc lập trong worktree

Chạy lần lượt ở thư mục worktree, không khởi động lại production:

1. npm run build
2. node --test test/*.test.mjs
3. cmd /c "set NHD_WORD_LIVE_REAL=1&& node --test test/word-live-parallel-real.test.mjs"

Test thật tạo bốn DOCX trong thư mục tạm của hệ điều hành, ghi PID Word trước/sau, đo khoảng thời gian chạy chồng nhau, chỉnh sửa và lưu độc lập, kiểm tra XML, không rò WINWORD hay tệp khóa, không đóng Word có sẵn; kiểm tra khóa đang sử dụng, khóa cũ và timeout.

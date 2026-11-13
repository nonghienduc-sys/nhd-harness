---
name: "skill chỉnh sửa format văn bản"
description: "Dùng khi cần kiểm tra, chuẩn hóa, sửa format hoặc tạo cấu trúc trình bày cho văn bản Việt Nam trong Word. Skill luôn phân loại tài liệu và xác định mẫu/quy định chuyên ngành trước; Nghị định 30/2020/NĐ-CP chỉ là rule pack nền hoặc fallback khi thực sự áp dụng."
---

# Skill chỉnh sửa format văn bản

## Mục tiêu

Biến yêu cầu như "chỉnh file đang mở cho đúng quy định", "format văn bản này", "làm đúng mẫu", "rà thể thức", "sửa theo Nghị định 30" thành một quy trình có thể kiểm chứng, không áp một mẫu chung cho mọi tài liệu.

Skill này ưu tiên **đúng nguồn điều chỉnh trước, đẹp sau**.

## Nguyên tắc bắt buộc

1. **Không mặc định mọi văn bản đều theo Nghị định 30.**
2. Trước khi sửa, phải xác định:
   - loại tài liệu;
   - họ tài liệu;
   - có mẫu bắt buộc hay không;
   - văn bản/quy định chuyên ngành nào điều chỉnh;
   - Nghị định 30 áp dụng trực tiếp, bổ trợ hay không áp dụng.
3. Nếu có **mẫu bắt buộc cụ thể**, mẫu đó ưu tiên ở phần nó quy định.
4. Quy định chuyên ngành ưu tiên hơn rule chung ở phần có xung đột.
5. Không tự bịa số văn bản, căn cứ pháp lý, cơ quan ban hành, chức danh, người ký, mức độ khẩn/mật.
6. Nếu người dùng chỉ yêu cầu format thì **không tự ý sửa nội dung**.
7. Không tuyên bố hoàn thành chỉ vì thao tác Word đã chạy. Phải đọc lại cấu trúc và thực hiện visual QA.
8. Khi không xác định chắc nguồn điều chỉnh, đánh dấu cần xác minh; nếu có khả năng thay đổi theo thời gian thì tra nguồn chính thức trước khi áp dụng.

## Thứ tự ưu tiên quy tắc

P1. Mẫu/biểu mẫu bắt buộc cụ thể ban hành kèm văn bản, thủ tục, thể lệ hoặc chương trình.  
P2. Quy định chuyên ngành trực tiếp: luật/nghị định/thông tư/quyết định/hướng dẫn ngành.  
P3. Quy định của chương trình, thủ tục, cuộc thi, đề án hoặc cơ chế cụ thể.  
P4. Quy định địa phương/cơ quan có thẩm quyền đối với hồ sơ đó.  
P5. Nghị định 30 và các quy tắc hành chính chung khi thuộc phạm vi áp dụng hoặc dùng làm fallback.  
P6. Quy chế nội bộ hợp lệ của tổ chức.  
P7. Best practice trình bày, chỉ được dùng khi không trái các tầng trên.

Không được dùng P5-P7 để ghi đè P1-P4.

## Workflow bắt buộc

### A. INSPECT
- Đọc file Word hiện tại bằng Office Live/Office Read.
- Ghi nhận path, loại ứng dụng, số trang/section/paragraph/table, header/footer, page setup và các vùng chữ quan trọng.
- Không sửa ở bước này.

### B. CLASSIFY
Đọc `registry/document-families.yaml`, `registry/document-types.yaml` và `core/document-classifier.yaml`.
Trả về nội bộ:
- family;
- document_type;
- detected_template;
- confidence;
- evidence.

### C. LEGAL RESOLVE
Đọc `core/legal-source-resolver.yaml`, `core/rule-priority-engine.yaml`, `registry/specialized-router.yaml` và `sources/source-registry.yaml`.
Xác định:
- primary source;
- mandatory template;
- specialized rules;
- NĐ30 scope;
- unresolved conflicts.

Nếu route trùng một rule pack chuyên ngành, đọc pack đó **trước khi** dùng NĐ30. Hiện có các pack: Khởi nghiệp Bắc Ninh 2026, đăng ký HTX, MTQG 2026-2030, hỗ trợ phát triển sản xuất nông nghiệp và biểu mẫu đầu tư Việt Nam.

Áp dụng `validators/source-freshness-policy.yaml` để chặn mẫu sai năm, sai giai đoạn, nguồn hết hiệu lực một phần hoặc nguồn chỉ mới được xác minh tại một thời điểm.

Nếu tài liệu có "Mẫu số", "ban hành kèm theo", thuộc thủ tục/chương trình chuyên ngành, hồ sơ dự thi, hồ sơ xin hỗ trợ, đầu tư, tài chính, nông nghiệp, giáo dục hoặc biểu mẫu có thể thay đổi: phải ưu tiên kiểm tra nguồn chính thức.

### D. BUILD RESOLVED DOCUMENT SPEC
Dùng `core/resolved-document-spec.yaml`.
Mỗi quy tắc phải biết:
- giá trị áp dụng;
- nguồn;
- mức ưu tiên;
- mandatory/advisory;
- rule nào bị override.

### E. AUDIT BEFORE EDIT
Dùng `validators/validation-policy.yaml`.
Phân lỗi thành:
- ERROR: trái rule bắt buộc;
- WARNING: khác mẫu/khả năng sai hoặc thiếu nguồn;
- INFO: khuyến nghị trình bày.

### F. APPLY
Sửa từ ngoài vào trong:
1. page/section setup;
2. header/footer/page number;
3. các khối nhận diện văn bản;
4. tên loại/tiêu đề/trích yếu;
5. body;
6. lists/tables;
7. signature;
8. nơi nhận/phụ lục;
9. save.

Ưu tiên thao tác semantic component, không dựa cứng vào "paragraph 1, paragraph 2..." nếu có thể.

### G. VERIFY
- đọc lại Word sau khi sửa;
- so khớp với Resolved Document Spec;
- bảo đảm nội dung không bị mất/đổi ngoài phạm vi yêu cầu.

### H. VISUAL QA
- chụp cửa sổ Word hoặc export PDF;
- kiểm tra ít nhất trang đầu, trang có bảng/phần chuyển trang và trang chữ ký/cuối;
- phát hiện lệch dòng, tràn trang, header/footer sai, chữ ký trôi, bảng vỡ, khoảng trắng bất thường;
- nếu sai: tự sửa và QA lại.

Chỉ báo "hoàn thành" sau khi structural QA và visual QA đều đạt hoặc nêu rõ phần còn chưa xác minh.

## Cổng kiểm tra Word Shape Line (bắt buộc khi chọn trình bày NĐ30)

- Đường kẻ dưới tiêu ngữ và tên cơ quan phải là **native Word Shape Line** (Word Shapes.AddLine, msoLine / Type=9) khi người dùng yêu cầu Shape Line.
- **Không tạo ảnh PNG/JPEG rồi chèn bằng InlineShapes.AddPicture** để giả lập đường kẻ; dù ảnh nhìn giống đường kẻ, đó không phải đối tượng Line của Word.
- Nếu đường kẻ neo bên trong bảng mà bị Word dịch vị trí, chuyển anchor sang đoạn ngoài bảng; căn tọa độ theo trang, sau đó xuất PDF và kiểm tra lại. Mọi thay đổi chiều rộng cột phải được QA lại vì Shape có thể bị dịch hoặc biến mất.
- Chạy công cụ office_admin_nd30_audit: phát hiện wp:anchor + wps:wsp + a:prstGeom prst="line"; ảnh wp:inline + pic:pic không được coi là hợp lệ. Tiếp tục Visual QA để xác định chính xác vị trí tương đối so với chữ.
- Chỉ khi cả kiểm tra cấu trúc và hình ảnh đều đạt mới được tuyên bố hoàn thành về định dạng.

## Chặn lỗi thân văn bản và vị trí đường kẻ

- Cổng cấu trúc office_admin_nd30_audit phải phát hiện đoạn thân văn bản không Justify, thụt đầu dòng sai, đoạn sau dưới 6 pt và giãn dòng ngoài 1–1,5.
- Cổng hình ảnh PDF scripts/qa_admin_pdf_geometry.py phải đo vị trí và độ dài hai line so với glyph thật của tên cơ quan và tiêu ngữ; chỉ có đủ 2 shape không được coi là đạt.
- Header table có phantom cells phải chuẩn hóa một cách có kiểm tra trước khi dựng lại Shape; tránh Word COM Save tự thêm cột và làm xuống dòng quốc hiệu.
- Khi thử nghiệm chưa đạt: giữ file gốc và ghi trạng thái NEEDS_REVIEW, không tự nhận đã hoàn thành.

## Cổng phát hành thống nhất (bắt buộc, không được bỏ qua)

Tất cả văn bản DOCX hành chính ở trạng thái bản cuối phải qua tuyến quản lý:
1. Soạn/sửa bản nháp bằng Word Live, Word COM hoặc Python, không gọi đây là bản phát hành.
2. Xuất PDF chính xác từ DOCX ứng viên.
3. Gọi office_admin_release_prepare để kiểm tra căn lề/Justify/Shape, so khớp nội dung DOCX–PDF, đo hình học đường kẻ và xuất PNG của **từng trang** gắn hash.
4. Gọi office_admin_release_view_page cho TỪNG trang, kiểm tra ảnh trang đầu, trang chữ ký và toàn bộ trang trung gian. Gọi office_admin_release_review với danh sách đầy đủ các trang và nhận xét có căn cứ.
5. Gọi office_admin_release_status op=preview rồi office_admin_release_apply; bước phát hành chỉ tạo file mới, không ghi đè bản đang mở.
6. Lưu receipt liên kết docxSha256, pdfSha256, hash ảnh từng trang và review. Nếu file thay đổi, thiếu PDF, trang chưa duyệt hay không tạo được receipt thì **FAIL CLOSED**.
7. Việc phát hành kỹ thuật không thay thế thẩm quyền ký, ghi số, công chứng hoặc yêu cầu cơ quan tiếp nhận.

Không gọi office_admin_nd30_audit đơn lẻ là bằng chứng phát hành; nó chỉ là một phần của cổng thống nhất.

## Quy tắc Nghị định 30

Khi Nghị định 30 áp dụng, đọc `legal-rules/nd30/core.yaml`. Không dùng kiến thức nhớ mơ hồ để áp rule.

Đối với văn bản có mẫu đặc thù:
- bố cục và trường dữ liệu của mẫu bắt buộc được giữ;
- NĐ30 chỉ bổ sung phần mà mẫu/quy định chuyên ngành không quy định và không xung đột.

## Các trường hợp phải tách route

- Văn bản Đảng: không dùng NĐ30 như nguồn chính; cần rule pack riêng.
- Văn bản quy phạm pháp luật: cần hệ quy tắc riêng.
- Văn bản tố tụng/chuyên ngành có mẫu bắt buộc: theo mẫu và quy định chuyên ngành.
- Văn bản doanh nghiệp/HTX nội bộ: xác định căn cứ tổ chức và mẫu nội bộ trước; NĐ30 chỉ dùng nếu người dùng yêu cầu hoặc có căn cứ phù hợp.

## Tài nguyên chính

- `core/document-classifier.yaml`
- `core/legal-source-resolver.yaml`
- `core/rule-priority-engine.yaml`
- `core/resolved-document-spec.yaml`
- `registry/document-families.yaml`
- `registry/document-types.yaml`
- `registry/specialized-router.yaml`
- `legal-rules/nd30/core.yaml`
- `legal-rules/specialized/startup/bac-ninh/2026/rules.yaml`
- `legal-rules/specialized/cooperatives/registration/rules.yaml`
- `legal-rules/specialized/mtqg/2026-2030/rules.yaml`
- `legal-rules/specialized/agriculture/production-support/rules.yaml`
- `legal-rules/specialized/investment/vietnam/rules.yaml`
- `validators/validation-policy.yaml`
- `validators/source-freshness-policy.yaml`
- `sources/official-domains.yaml`
- `sources/source-registry.yaml`
- `workflows/reformat-current-word.md`
- `workflows/legal-resolve-specialized.md`

## Tiêu chuẩn hoàn thành

Một task format chỉ được coi là hoàn thành khi:
- xác định được loại văn bản hoặc nêu rõ confidence thấp;
- nguồn điều chỉnh đã được resolve đủ mức cần thiết;
- không có xung đột chưa xử lý ở rule bắt buộc;
- file đã được đọc lại sau sửa;
- visual QA đã thực hiện;
- không làm mất nội dung;
- các ERROR bắt buộc bằng 0, trừ phần người dùng chủ động giữ nguyên.

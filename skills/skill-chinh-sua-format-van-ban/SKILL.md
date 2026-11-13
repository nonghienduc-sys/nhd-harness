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
Đọc `core/legal-source-resolver.yaml` và `core/rule-priority-engine.yaml`.
Xác định:
- primary source;
- mandatory template;
- specialized rules;
- NĐ30 scope;
- unresolved conflicts.

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
- `legal-rules/nd30/core.yaml`
- `validators/validation-policy.yaml`
- `sources/official-domains.yaml`
- `workflows/reformat-current-word.md`

## Tiêu chuẩn hoàn thành

Một task format chỉ được coi là hoàn thành khi:
- xác định được loại văn bản hoặc nêu rõ confidence thấp;
- nguồn điều chỉnh đã được resolve đủ mức cần thiết;
- không có xung đột chưa xử lý ở rule bắt buộc;
- file đã được đọc lại sau sửa;
- visual QA đã thực hiện;
- không làm mất nội dung;
- các ERROR bắt buộc bằng 0, trừ phần người dùng chủ động giữ nguyên.

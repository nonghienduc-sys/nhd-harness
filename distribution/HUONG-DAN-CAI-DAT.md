# Hướng dẫn cài ChatGPT Workstation MCP

## Yêu cầu

- Windows 10 hoặc Windows 11 64-bit.
- Máy có kết nối Internet.
- Microsoft Office desktop nếu muốn điều khiển Word, Excel, PowerPoint hoặc đọc Outlook.
- Tài khoản ChatGPT Web có chức năng kết nối MCP tùy chỉnh.

## Cài đặt

1. Chạy file `ChatGPT-Workstation-MCP-Setup-*.exe` trong gói.
2. Nếu Windows SmartScreen xuất hiện, kiểm tra tên file và SHA-256 trong `SHA256SUMS.txt`, sau đó chọn chạy nếu file khớp. Bản thử nghiệm chưa có chữ ký số thương mại.
3. Chọn thư mục cài đặt và hoàn tất. Ứng dụng sẽ tạo shortcut và tự chạy khi đăng nhập Windows.
4. Mở dashboard tại `http://127.0.0.1:39100/`.
5. Kiểm tra File, Terminal, Office, Skills và Màn hình; tắt quyền nào không muốn cấp.
6. Bấm `Bật tunnel`. Máy mới mặc định dùng Quick Tunnel và dashboard sẽ hiện URL MCP tạm thời.
7. Trong ChatGPT Web, thêm MCP bằng URL có dạng `https://...trycloudflare.com/mcp`.
8. Khi trang cấp quyền xuất hiện, nhập pairing code đang hiển thị trên dashboard cục bộ.

## Lưu ý bảo mật

- Không gửi pairing code, OAuth token hoặc file cấu hình tunnel cho người khác.
- Mỗi máy có dữ liệu, mã ghép nối và phiên OAuth riêng.
- Ghi file và PowerShell phải qua preview/xác nhận. Khi Screen Access đang bật, ChatGPT được tự chụp màn hình; mọi lần chụp đều được ghi Activity.
- Outlook chỉ được tìm kiếm và đọc; không có công cụ gửi, xóa hoặc di chuyển thư.
- Trước khi cho ChatGPT chụp màn hình, đóng hoặc che mật khẩu, token và dữ liệu riêng tư.
- `Dừng khẩn cấp` sẽ khóa ghi file, PowerShell, chụp màn hình và dừng tunnel.

## Tên miền cố định

Quick Tunnel thay đổi URL khi khởi động lại. Muốn có URL cố định, người cài cần tạo Cloudflare Named Tunnel của riêng họ hoặc được chủ tên miền cấp một hostname riêng. Không dùng chung credential tunnel giữa nhiều máy.

## Gỡ cài đặt

Vào Windows Settings > Apps > Installed apps, chọn `ChatGPT Workstation MCP` và bấm Uninstall. Dữ liệu cục bộ của người dùng được lưu riêng trong thư mục ứng dụng của Windows để tránh trộn với máy khác.

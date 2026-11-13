# NHD Dual Execution Lanes — Background + Isolated Agent

## Mục tiêu

NHD MCP có hai lane chạy đồng thời dưới cùng Task Runtime/Risk Policy:

- **Background**: chạy trên Windows session của người dùng nhưng không được giành foreground input.
- **Isolated Agent**: chạy browser/GUI trong Windows Sandbox riêng, có desktop/mouse/keyboard của guest và không thao tác desktop host.

Mode thuộc về **task step**, không khóa cả task. Một task có thể Background → handoff → Isolated → handoff → Background.

## Quy tắc Background

Background là mặc định cho files, non-GUI terminal, Office Direct, Cốc Cốc DOM nền, PDF/OCR, local AI và project memory.

Background **không được**:

- inject chuột/bàn phím host;
- activate/switch cửa sổ host;
- coordinate-click trên host;
- tự chuyển foreground tab Cốc Cốc;
- dùng visual desktop fallback để hoàn thành task.

Nếu step cần canvas, drag/drop, native dialog, visual/foreground interaction hoặc desktop GUI thì route sang Isolated. Nếu Isolated offline thì pause/fail; không fallback sang host GUI.

## Isolated Agent

Provider đầu tiên: **Windows Sandbox**.

Sandbox mặc định:

- RAM 3072 MB;
- vGPU off;
- network on;
- clipboard/printer/audio/video redirection off;
- built-in Edge làm browser Agent;
- Agent Companion Node chạy trong guest;
- UI Automation + guest-only mouse/keyboard cho desktop GUI.

Host chỉ map ba vùng:

1. `isolated-agent` → read-only;
2. thư mục Node runtime → read-only;
3. `D:\NHD-Agent-Exchange` → read/write.

Không map toàn bộ ổ D vào guest.

## Command / Artifact Bus

`D:\NHD-Agent-Exchange`

- `commands/`: host → guest command JSON;
- `responses/`: guest → host response JSON;
- `screenshots/`: screenshot guest;
- `state/`: browser profile/state của guest;
- `tasks/<task-id>/<handoff-id>/input|output`: artifact handoff;
- `heartbeat.json`: health heartbeat 1 giây/lần.

Command timeout không được replay tự động.

## Resource locks

Resource lock hỗ trợ `read`, `write`, `exclusive`.

- read + read: cho phép song song;
- write/exclusive xung đột với lock từ task/lane khác;
- lock có TTL và ownership theo `taskRunId + lane`.

Dùng canonical resource key, ví dụ:

- `file:D:/NHD Projects/CMC/report.xlsx`
- `office:word:report.docx`
- `browser:host:coccoc:tab-123`
- `browser:isolated:agent-01`
- `project:D:/NHD Projects/TOEIC Reading - Đức`

## Scheduler

Mặc định trên máy 16 GB RAM:

- Background: tối đa 2 worker;
- Isolated: tối đa 1 Agent;
- Sandbox memory: 3 GB.

Background và Isolated được phép chạy đồng thời nếu không giữ lock xung đột.

## Risk policy

Isolation không làm giảm policy.

- navigation an toàn: low;
- ordinary commit/submit/save/download: moderate task authorization;
- sensitive external action: high task authorization + đúng objective scope;
- password/file-upload/payment-sensitive fields: blocked ở phiên bản đầu;
- arbitrary JavaScript từ ChatGPT: không expose;
- critical actions: vẫn cần critical confirmation theo NHD Risk Policy.

## Ví dụ TOEIC + công việc

- Session host: người dùng học TOEIC. MCP Background đọc Word/project memory, chấm bài, cập nhật error log, tạo bài bằng Office Direct.
- Windows Sandbox: Isolated Agent chạy một task web/GUI khác bằng Edge/UIA.
- Hai lane dùng chung Task Runtime, checkpoint, resource lock và artifact bus nhưng không dùng chung chuột/focus.

## Failure behavior

- Sandbox offline: Isolated step dừng/pause, không chuyển sang host desktop.
- Command timeout: không replay action; re-observe trạng thái rồi mới quyết định.
- Resource busy: step chờ hoặc route step khác; không ghi đè tài nguyên.
- Host Emergency Stop: dừng/pause task và không tiếp tục GUI tự động.

## Prerequisite Windows Sandbox

Windows 11 Pro cần optional feature `Containers-DisposableClientVM`. Script `scripts/setup-isolated-agent.ps1` kiểm tra feature, chỉ enable khi chạy elevated và báo rõ nếu reboot cần thiết. Không tự reboot máy.

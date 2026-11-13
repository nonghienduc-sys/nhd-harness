# NHD Isolated Agent Direct Transport v0.21

## Mục tiêu

v0.21 thay realtime control plane của Isolated Agent từ polling JSON qua mapped folder sang một tiến trình Microsoft WinApp CLI sống lâu, nối stdin/stdout trực tiếp giữa host MCP và Node agent trong Windows Sandbox.

Mapped folder vẫn được giữ cho bootstrap heartbeat, artifact lớn, screenshot desktop và task handoff; nó không còn nằm trên đường điều khiển realtime.

## Kiến trúc

```text
ChatGPT
  -> NHD MCP host
  -> IsolatedAgentService
  -> persistent winapp.exe target exec sandbox
  -> stdin/stdout NDJSON
  -> C:\NHD\Node\node.exe C:\NHD\Agent\agent.mjs --stdio
  -> Browser CDP / guest UIA
```

Sandbox LogonCommand chạy `agent.mjs --bootstrap` chỉ để phát heartbeat qua mapped folder. Khi host cần làm việc, IsolatedAgentService mở một WinApp stdio session riêng và giữ nó sống trong suốt phiên Agent.

## Protocol

Mỗi dòng stdout trong stdio mode là một JSON envelope:

- `ready`: agent version, session id, heartbeat metadata.
- `heartbeat`: trạng thái busy/browser mỗi giây.
- `response`: id, ok, result/error, elapsedMs.

Host gửi mỗi command thành một dòng JSON có `kind=command`, id duy nhất, type, payload và taskRunId.

Nếu timeout, pipe error, WinApp exit hoặc trạng thái giao nhận mơ hồ xảy ra, command đang chờ bị reject và **không bao giờ tự replay**.

## Browser lane

Browser riêng của Isolated Agent chạy Edge headless với:

- CDP port 9224;
- profile `browser-profile-v2`;
- `--headless=new`;
- `--disable-gpu`;
- viewport 1280x900.

DOM snapshot/inspect/click/fill/press và screenshot dùng CDP trong guest. Không phụ thuộc màn hình interactive của Windows Sandbox và không activate desktop host.

## Desktop lane

Desktop UIA vẫn chạy trong guest qua `desktop.ps1`. v0.21 chuẩn hóa BoundingRectangle NaN/Infinity thành null để JSON luôn hợp lệ. Desktop UIA vẫn có overhead khoảng 2–3 giây/lần vì PowerShell được tạo cho mỗi command; đây là bottleneck độc lập, không phải direct transport.

## Benchmark candidate trên máy hiện tại

So với mapped-folder command bus cũ khoảng 15–16 giây tail latency mỗi command:

| Operation | v0.21 candidate |
| --- | ---: |
| Direct transport startup | 203 ms |
| `system.ping` avg / p95 | 0.77 / 1.10 ms |
| `browser.status` avg | 5.57 ms |
| `browser.snapshot` avg | 7.42 ms |
| `browser.inspect` avg | 5.70 ms |
| `browser.screenshot` avg | 43.84 ms |
| `browser.navigate` | 2.18 s incl. page load |
| `desktop.list` | 2.71 s |

Raw persistent stdio probe: 30 round trips average 0.71 ms, p50 0.47 ms, p95 0.70 ms.

## Safety invariants

v0.21 không thay đổi NHD risk policy:

- Background vẫn cấm host foreground input.
- Isolated GUI không fallback sang host desktop.
- password/file-upload/payment-sensitive fields vẫn blocked.
- ordinary commit cần moderate task authorization.
- sensitive external action cần high authorization và objective scope.
- arbitrary JavaScript từ ChatGPT không được expose.
- ambiguous/interrupted action không được replay tự động.
- không mở firewall port mới.

## Rollback

Pre-v0.21 snapshot:

`D:\ChatGPT-Workstation-MCP\deploy-backups\isolated-stdio-v021-pre-20261010-1128`

Candidate benchmark:

`D:\ChatGPT-Workstation-MCP\deploy-backups\isolated-stdio-v021-candidate-benchmark.json`

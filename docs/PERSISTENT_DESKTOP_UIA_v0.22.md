# NHD MCP v0.22 — Persistent Desktop UIA Worker

## Goal

Remove the dominant per-command PowerShell startup cost from Isolated Desktop UI Automation while preserving Windows Sandbox isolation and all existing host-side risk/task authorization.

## Previous v0.21 path

```text
Host MCP
  -> WinApp persistent stdio
    -> guest agent
      -> spawn powershell.exe for every desktop.list / inspect / action / screenshot
        -> load UIAutomation assemblies
        -> execute one request
        -> exit
```

Verified historical desktop.list latency was roughly 2.87 s, with later user smoke around 5.15 s.

## v0.22 architecture

```text
Host MCP
  -> WinApp persistent stdio
    -> direct guest agent (non-interactive execution context)
      -> persistent loopback NDJSON client
        -> 127.0.0.1:9235 inside the guest only
          -> bootstrap agent started by Windows Sandbox LogonCommand
            -> persistent PowerShell UIA worker
              -> interactive Sandbox desktop UI Automation tree
```

The bootstrap agent owns the UIA worker because WinApp `target exec` can run in a non-rendered/non-interactive execution context whose UIAutomation root does not expose the interactive Sandbox windows. The direct agent remains the low-latency transport endpoint but delegates desktop requests to the bootstrap interactive session.

## Worker protocol

`desktop-worker.ps1` is started once per Sandbox session. It loads:

- UIAutomationClient
- UIAutomationTypes
- System.Drawing
- System.Windows.Forms

It accepts newline-delimited JSON over stdin and emits newline-delimited JSON over stdout. Supported actions are bounded to:

- `ping`
- `list`
- `inspect`
- `action`
- `screenshot`

No arbitrary PowerShell/script command is accepted.

## UI caches

The persistent worker maintains:

- top-level window cache keyed by native window handle;
- ephemeral selector cache keyed by random `iso-uia-*` IDs;
- selector TTL of 5 minutes;
- AutomationElement references for low-latency follow-up actions.

Selectors are window-bound and fail closed when stale.

## Safety

Unchanged host authority:

- host MCP still classifies and authorizes `desktop.action`;
- sensitive/password/payment-like fields remain blocked;
- click-point remains high-risk;
- no host desktop fallback is permitted;
- timeout/disconnect after possible delivery is never automatically replayed;
- browser security behavior remains unchanged.

The loopback bridge binds only to `127.0.0.1` inside the ephemeral Sandbox and accepts only the bounded desktop action vocabulary.

## Lifecycle

- `--bootstrap`: starts the persistent UIA worker in the interactive LogonCommand session, starts the loopback bridge, then emits heartbeat.
- `--stdio`: connects to the interactive bridge and proxies desktop requests; browser CDP remains local to the direct agent path.
- shutdown: pending requests are rejected and never replayed.

## Telemetry

Host isolated status exposes `desktopWorker`, including persistent/online state, bridge mode, worker PID/version where available, startup latency and last round-trip latency.

## Candidate performance

Before the interactive-session bridge correction, the persistent worker proved the process-lifecycle optimization itself:

- worker startup: ~3.3–4.4 s once per session;
- warm desktop.list p50: ~3 ms;
- warm desktop.list p95: ~4–7 ms;
- browser.status remained ~5 ms warm;
- same worker PID reused across repeated requests.

The final production gate requires a fresh Sandbox so the updated bootstrap LogonCommand owns the worker and a real interactive window can be listed/inspected.

## Rollback

Pre-v0.22 snapshot:

`D:\ChatGPT-Workstation-MCP\deploy-backups\persistent-uia-v022-pre-20261010-1705`

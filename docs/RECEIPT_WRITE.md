# Sealing receipts and preventing hidden Word leaks

Use the MCP tool **receipt_write** instead of calculating SHA-256 in ChatGPT:

- Input: path (absolute path to JSON receipt), receipt (object with files entries containing absolute path and optional metadata), optional task_run_id.
- For each files entry, the tool validates existence and adds/replaces sha256. It adds sealed_at and, when called in a durable task, task_run_id.
- JSON is UTF-8 without BOM and is atomically replaced. Secret-looking keys and credential strings are rejected.
- In the same task, a later Terminal command that changes a sealed file returns a RECEIPT_STALE warning. Re-run checks and seal a new receipt after the last write.
- Optional environment NHD_SO_THOI_GIAN points to a CSV ledger. When set, receipt_write writes or completes one row; without it, no ledger path is implied. The existing BOM and unrelated rows are retained.

Terminal commands on Windows automatically check for new hidden WINWORD processes on completion, timeout or command failure. Newly created hidden processes that descend from the command, or started during the command as Word COM servers, get up to ten seconds to exit before selective termination. Pre-existing PIDs and Word processes with visible titles are never terminated. The result includes word_cleanup { killed, kept, errors }.

Use word_cleanup: false in terminal_preview or terminal_session_preview to turn cleanup off for that command, or set NHD_WORD_CLEANUP=0 to disable globally. On other platforms cleanup is disabled. The logic lives in src/word-cleanup.ts and can be tested with a mock process provider.

Do not restart a live Harness just to activate these changes. A running server must load the new build before the real Word COM test can be performed.

## Word page gate

When the owner configures an absolute NHD_KIEM_TRANG path, or the default local page-check script exists, a completed receipt must have both fresh real terminal checks for every .docx or .docm (case-insensitive). The gate is disabled when no absolute script is configured. Receipt content cannot toggle it. Blocked/KET/failed receipts and receipts without Word files are unaffected.

Run these separately, replacing the quoted paths with the configured script, the absolute Word file or its parent directory, and the output directory:

    python "<pageGateScript>" kiem "<file-or-directory>" --ra "<output-directory>"
    python "<pageGateScript>" so "<file-or-directory>" --ra "<output-directory>"

The allowed interpreter is python, python.exe or py, with optional -I and -X utf8. No extra flags or shell chaining/redirection. Each check must have real Harness evidence of exit 0, no timeout, and its own exact DAT line (KIEM_TRANG: DAT or KIEM_TRANG_SO: DAT), regardless of caller-supplied regex. A check only covers the specified file or its descendants at a directory boundary. Changes after the check started (or completed if start time is unavailable) require a new check. A missing or stale check raises RECEIPT_PAGE_CHECK_REQUIRED before any receipt or ledger is written.

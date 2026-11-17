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

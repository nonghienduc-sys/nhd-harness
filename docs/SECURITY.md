# Security

All existing security invariants remain active. Files stay under configured roots, secret paths and symlink/junction traversal are blocked, and files/terminal/Office writes remain previewed with one-time five-minute tokens. Source hashes are checked immediately before apply, backups are created, and Emergency Stop disables write, terminal, screen, desktop navigation, document intake, OCR and tunnel operations.

Project memory, OOXML, PDF text, source code, web snapshots, email, terminal output and skills are untrusted data. They must never cause commands to execute, change allowed roots, reveal secrets or bypass confirmation.

Legal web imports require HTTPS and preview/apply. Official-source candidates are marked separately from ordinary references; imported material is not a legal conclusion or a confirmed decision.

## Desktop navigation boundary

Desktop navigation is an owner-controlled read-only workflow capability. Windows UI Automation is used first. Selectors expire after five minutes and do not survive a new inspection. The companion blocks recognizable controls related to sending, deleting, removing, uploading or attaching a new file, authentication, passwords, payments, transfers and calls. Opening or downloading a document already received remains allowed. Typing into recognizable message-composition controls is blocked, and Enter is not an available key action.

Some applications hide semantic controls. `visualDesktopEnabled` permits click fallback only within the selected top-level window using normalized coordinates. Immediately before clicking, `AutomationElement.FromPoint()` verifies that the point still belongs to the selected window and rejects password or recognizable dangerous controls. Hit-test metadata is returned and every click is separately audited, but generic application frames may still lack a detailed semantic name; every action must therefore be followed by screen or UI inspection. The dashboard presents visual fallback as a separate permission and Emergency Stop disables it immediately.

The companion authentication secret is process-local and is never returned by the dashboard configuration API. Dashboard and management endpoints remain localhost-only.

## Intake boundary

Document Intake does not add the user profile to normal filesystem roots. It reads only explicit `intakeRoots`, blocks symlink/junction traversal, sensitive filenames, temporary downloads and unsupported extensions, and waits for size stability before returning a file. The source file is never modified by intake or PDF reading.

# Migration from v0.3.1 to v0.4.0

No existing global SQLite table, OAuth client/token record, project `.nhd` state, filesystem root, tunnel setting, Office behavior, Screen behavior, skill, or existing MCP tool is removed.

On first v0.4.0 load, missing configuration fields receive defaults:

- `desktopEnabled: true`
- `visualDesktopEnabled: true`
- `intakeEnabled: true`
- `ocrEnabled: true`
- `intakeRoots`: existing `%USERPROFILE%\Downloads` and `%USERPROFILE%\Documents\Zalo Received Files`

Review these owner permissions and intake paths on the localhost dashboard. Disable visual fallback when semantic UI Automation alone is preferred.

The tunnel Start/Stop choice is now persistent. A tunnel that the owner explicitly starts will return after a normal app restart. Stop and Emergency Stop persist the disabled state, so the backend never reopens remote access against the owner's last choice.

ChatGPT Web caches tool schemas. After the local runtime reports `0.4.0`, refresh/update the MCP connection or reconnect it so `tools/list` changes from 46 to 52 tools.

OCR being enabled does not imply that a local OCR engine exists. The Tools page marks `pdf_document` as partial when native PDF reading/rendering works but Tesseract or required language data is unavailable.

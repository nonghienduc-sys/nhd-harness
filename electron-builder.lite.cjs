"use strict";
// Reproducible lite installer. Explicit allowlist excludes personal runtime data,
// heavyweight optional venvs and deployment state. Do not broaden to runtime/**/*.
const manifest = require("./package.json");
module.exports = {
  ...manifest.build,
  directories: { ...manifest.build.directories, output: "release-lite" },
  files: [
    "dist/**/*", "electron/**/*", "dashboard/**/*",
    "browser-extension/**/*", "isolated-agent/**/*", "office/**/*",
    "workers/**/*", "skills/**/*",
    "runtime/cloudflared.exe", "runtime/python-embed/**/*", "package.json",
    "!**/*.bak", "!**/*.backup", "!**/*.log",
    "!**/*.sqlite", "!**/*.sqlite-*", "!**/*.db",
    "!**/.env*", "!**/secrets*", "!**/config.json", "!**/release-state.json"
  ],
  win: { ...manifest.build.win, target: ["nsis"], artifactName: "NHD-Harness-Lite-${version}.${ext}" },
  nsis: { ...manifest.build.nsis }
};

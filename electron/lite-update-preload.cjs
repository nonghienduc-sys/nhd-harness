"use strict";
const { contextBridge, ipcRenderer } = require("electron");
// Do not expose Node/Electron APIs, paths, input parameters or arbitrary IPC.
const allowed = () => {
  try { return new URL(globalThis.location.href).origin === "http://127.0.0.1:39100"; }
  catch { return false; }
};
if (allowed()) {
  contextBridge.exposeInMainWorld("nhdUpdater", Object.freeze({
    status: () => ipcRenderer.invoke("nhd:update:status"),
    checkAndInstall: () => ipcRenderer.invoke("nhd:update:prompt")
  }));
}

import { existsSync } from "node:fs";
import { resolve } from "node:path";

const DEFAULT_NHD_PYTHON = "D:\\NHD-Runtimes\\Python\\mcp-venv\\Scripts\\python.exe";

// Full NHD venv takes precedence on development machines. Lite bundles only
// the official Python embeddable runtime needed by the pure Background Turbo worker.
export function resolveNhdPython(): string {
  const configured = String(process.env.NHD_PYTHON_PATH ?? "").trim();
  if (configured && existsSync(configured)) return configured;
  if (existsSync(DEFAULT_NHD_PYTHON)) return DEFAULT_NHD_PYTHON;
  const embedded = resolve(process.cwd(), "runtime", "python-embed", "python.exe");
  if (existsSync(embedded)) return embedded;
  return configured || "python";
}
export function defaultNhdPythonPath(): string { return DEFAULT_NHD_PYTHON; }

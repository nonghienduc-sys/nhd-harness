import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, statSync } from "node:fs";
import { win32 } from "node:path";
import { isPathWithinRoots } from "./resource-guard.js";

export type FixedDrive = { path: string; label: string; sizeBytes: number | null; isSystem: boolean };

export function listFixedDrives(): FixedDrive[] {
  let records: any[] = [];
  try {
    const raw = execFileSync("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-Command",
      "Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | Select-Object DeviceID,VolumeName,Size | ConvertTo-Json -Compress",
    ], { encoding: "utf8", timeout: 8000, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] }).trim();
    const parsed = raw ? JSON.parse(raw) : [];
    records = Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    // A missing CIM provider must not prevent the dashboard from loading.
  }
  const systemDrive = String(process.env.SystemDrive || (process.env.SystemRoot || "C:\\Windows").slice(0, 2)).toUpperCase();
  const drives = records.filter((item) => /^[A-Za-z]:$/.test(String(item?.DeviceID ?? "")))
    .map((item) => ({
      path: String(item.DeviceID).toUpperCase() + "\\",
      label: String(item.VolumeName || ""),
      sizeBytes: Number.isFinite(Number(item.Size)) ? Number(item.Size) : null,
      isSystem: String(item.DeviceID).toUpperCase() === systemDrive,
    }));
  if (drives.length) return drives.sort((a, b) => a.path.localeCompare(b.path));
  return ["C:\\", "D:\\"].filter((path) => existsSync(path))
    .map((path) => ({ path, label: "", sizeBytes: null, isSystem: path.slice(0, 2).toUpperCase() === systemDrive }));
}

export function validateRoots(input: unknown): string[] {
  if (!Array.isArray(input) || input.length === 0 || input.length > 20)
    throw new Error("Danh sách phải có từ 1 đến 20 ổ hoặc thư mục.");
  const paths: string[] = [];
  for (const value of input) {
    if (typeof value !== "string" || !value.trim()) throw new Error("Mỗi đường dẫn phải là chuỗi không rỗng.");
    const raw = value.trim();
    if (raw.startsWith("\\\\") || raw.startsWith("//"))
      throw new Error("Không cho phép đường dẫn UNC, mạng hoặc thiết bị.");
    if (!/^[A-Za-z]:[\\/]/.test(raw) || raw.slice(2).includes(":") || /[\x00-\x1f*?]/.test(raw))
      throw new Error("Phải dùng đường dẫn ổ đĩa tuyệt đối hợp lệ (ví dụ C:\\).");
    const normalized = win32.resolve(raw);
    if (!existsSync(normalized)) throw new Error("Đường dẫn không tồn tại: " + raw);
    if (!statSync(normalized).isDirectory()) throw new Error("Đường dẫn không phải thư mục: " + raw);
    // Check every ancestor, not just the final component, to reject junction traversal.
    let step = normalized;
    for (;;) {
      if (lstatSync(step).isSymbolicLink())
        throw new Error("Không cho phép thư mục liên kết (symlink/junction): " + raw);
      const parent = win32.dirname(step);
      if (parent === step) break;
      step = parent;
    }
    paths.push(normalized);
  }
  const unique = new Map<string, string>();
  for (const path of paths) if (!unique.has(path.toLowerCase())) unique.set(path.toLowerCase(), path);
  const ordered = [...unique.values()].sort((a, b) => a.length - b.length);
  const cleaned: string[] = [];
  for (const path of ordered) if (!isPathWithinRoots(path, cleaned)) cleaned.push(path);
  return cleaned;
}

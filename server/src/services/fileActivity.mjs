import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

const MAX_ACTIVITY_PATHS = 2000;
const WINDOWS_ACTIVITY_SCRIPT = String.raw`$source = @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
public static class DiskLensRestartManager {
  [StructLayout(LayoutKind.Sequential)] struct RM_UNIQUE_PROCESS { public uint dwProcessId; public long ProcessStartTime; }
  enum RM_APP_TYPE { Unknown = 0, MainWindow = 1, OtherWindow = 2, Service = 3, Explorer = 4, Console = 5, Critical = 1000 }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct RM_PROCESS_INFO {
    public RM_UNIQUE_PROCESS Process;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=256)] public string AppName;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=64)] public string ServiceName;
    public RM_APP_TYPE AppType;
    public uint AppStatus;
    public uint SessionId;
    [MarshalAs(UnmanagedType.Bool)] public bool Restartable;
  }
  [DllImport("rstrtmgr.dll", CharSet=CharSet.Unicode)] static extern int RmStartSession(out uint handle, uint flags, StringBuilder key);
  [DllImport("rstrtmgr.dll", CharSet=CharSet.Unicode)] static extern int RmRegisterResources(uint handle, uint fileCount, string[] files, uint appCount, IntPtr apps, uint serviceCount, IntPtr services);
  [DllImport("rstrtmgr.dll", CharSet=CharSet.Unicode)] static extern int RmGetList(uint handle, out uint needed, ref uint count, [In,Out] RM_PROCESS_INFO[] affected, ref uint reasons);
  [DllImport("rstrtmgr.dll")] static extern int RmEndSession(uint handle);
  public static string[] Find(string[] files) {
    if (files == null || files.Length == 0) return new string[0];
    uint session;
    StringBuilder key = new StringBuilder(33);
    int status = RmStartSession(out session, 0, key);
    if (status != 0) throw new Win32Exception(status);
    try {
      status = RmRegisterResources(session, (uint)files.Length, files, 0, IntPtr.Zero, 0, IntPtr.Zero);
      if (status != 0) throw new Win32Exception(status);
      uint needed, count = 0, reasons = 0;
      RM_PROCESS_INFO[] processes = new RM_PROCESS_INFO[0];
      status = RmGetList(session, out needed, ref count, processes, ref reasons);
      if (status == 234 && needed > 0) {
        processes = new RM_PROCESS_INFO[needed];
        count = needed;
        status = RmGetList(session, out needed, ref count, processes, ref reasons);
      }
      if (status != 0) throw new Win32Exception(status);
      string[] pids = new string[count];
      for (int i = 0; i < count; i++) pids[i] = processes[i].Process.dwProcessId.ToString();
      return pids;
    } finally { RmEndSession(session); }
  }
}
'@
Add-Type -TypeDefinition $source
$paths = [Console]::In.ReadToEnd() | ConvertFrom-Json
$pids = [DiskLensRestartManager]::Find([string[]]$paths)
ConvertTo-Json -InputObject @($pids) -Compress`;

async function collectFiles(targetPath, type, budget) {
  const files = [];
  const stack = [{ targetPath, type }];
  let truncated = false;
  let inaccessible = false;
  while (stack.length) {
    const current = stack.pop();
    if (current.type === "file") {
      files.push(current.targetPath);
      if (files.length >= budget) { truncated = stack.length > 0; break; }
      continue;
    }
    let handle;
    try { handle = await fs.opendir(current.targetPath, { bufferSize: 32 }); }
    catch { inaccessible = true; continue; }
    try {
      for await (const entry of handle) {
        if (entry.isSymbolicLink()) continue;
        const entryPath = path.join(current.targetPath, entry.name);
        if (entry.isDirectory()) stack.push({ targetPath: entryPath, type: "directory" });
        else if (entry.isFile()) stack.push({ targetPath: entryPath, type: "file" });
        if (stack.length + files.length >= budget) { truncated = true; break; }
      }
    } catch { inaccessible = true; }
    finally { await handle.close().catch(() => {}); }
    if (truncated) break;
  }
  return { files, truncated, inaccessible };
}

function runWindowsActivityCheck(files) {
  return new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_ACTIVITY_SCRIPT], {
      windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill(), 8000);
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; if (stdout.length > 32768) child.kill(); });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; if (stderr.length > 32768) child.kill(); });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(stderr.trim() || "Restart Manager query failed."));
      try {
        const pids = JSON.parse(stdout.trim() || "[]");
        resolve([...new Set((Array.isArray(pids) ? pids : [pids]).map(Number).filter((pid) => Number.isInteger(pid) && pid > 0))]);
      } catch { reject(new Error("Restart Manager returned an invalid result.")); }
    });
    child.stdin.end(JSON.stringify(files));
  });
}

/** Best-effort preflight; only Windows Restart Manager provides reliable local file-owner data here. */
export async function checkFilesystemActivity(targets, { platform = process.platform } = {}) {
  if (platform !== "win32") return { status: "unsupported", checkedPaths: 0, processIds: [], message: "Reliable open-handle detection is unavailable on this platform." };
  const files = [];
  let truncated = targets.length > 100;
  let inaccessible = false;
  for (const target of targets.slice(0, 100)) {
    const remaining = MAX_ACTIVITY_PATHS - files.length;
    if (remaining <= 0) { truncated = true; break; }
    if (target.type === "file") {
      files.push(path.resolve(target.path));
      continue;
    }
    const result = await collectFiles(path.resolve(target.path), "directory", remaining);
    files.push(...result.files);
    truncated ||= result.truncated;
    inaccessible ||= result.inaccessible;
  }
  if (!files.length) {
    return {
      status: truncated || inaccessible ? "partial" : "clear",
      checkedPaths: 0, processIds: [],
      message: truncated ? "The folder is larger than the bounded activity-check limit." : inaccessible ? "Some folder contents could not be checked." : "No files were found in the selection.",
    };
  }
  try {
    const processIds = await runWindowsActivityCheck(files);
    const status = processIds.length ? "in-use" : truncated || inaccessible ? "partial" : "clear";
    return {
      status, checkedPaths: files.length, processIds,
      message: processIds.length ? "Windows reports open file handles in the selected items." : truncated ? "Checked a bounded portion; some files were not reached." : inaccessible ? "Some folder contents could not be checked." : "No active file handles were found.",
    };
  } catch {
    return { status: "unavailable", checkedPaths: files.length, processIds: [], message: "Windows could not complete the open-handle check." };
  }
}

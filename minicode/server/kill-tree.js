import childProcess from "node:child_process"

// proc.kill() only signals the named process. Anything it spawned (nested
// powershell, node, dev servers, …) survives and can keep inherited pipes open
// or linger as orphans. These helpers signal the whole tree instead.

/** Force-kill `pid` and every descendant. */
export function killTree(pid) {
  if (!pid) return
  if (process.platform === "win32") {
    childProcess.spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    })
  } else {
    try {
      process.kill(-pid, "SIGKILL") // negative pid => the process group
    } catch {
      try {
        process.kill(pid, "SIGKILL")
      } catch {}
    }
  }
}

/**
 * Force-kill every descendant of `pid` but leave `pid` itself running. Used to
 * cancel the command a long-lived shell is running without killing the shell.
 * Best effort: shell builtins that run in-process (e.g. Start-Sleep) cannot be
 * interrupted this way because they are not separate processes.
 */
export function killDescendants(pid) {
  if (!pid) return
  if (process.platform === "win32") {
    const script =
      `Get-CimInstance Win32_Process -Filter "ParentProcessId=${pid}" ` +
      `| ForEach-Object { taskkill /PID $_.ProcessId /T /F }`
    childProcess.spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      windowsHide: true,
      stdio: "ignore",
    })
  } else {
    childProcess.spawn("pkill", ["-KILL", "-P", String(pid)], { stdio: "ignore" })
  }
}

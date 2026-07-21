import childProcess from "node:child_process"

export async function runShellCommand(command, options = {}) {
  const cwd = options.cwd || process.env.MINICODE_REPO_ROOT || process.cwd()
  const timeoutMs = options.timeoutMs || 120000
  const onData = options.onData || (() => {})

  return new Promise((resolve) => {
    const isWindows = process.platform === "win32"
    const file = isWindows ? "powershell.exe" : "bash"
    const args = isWindows ? ["-NoProfile", "-NonInteractive", "-Command", command] : ["-lc", command]
    const proc = childProcess.spawn(file, args, {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    })

    let output = ""
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      proc.kill("SIGTERM")
    }, timeoutMs)

    proc.stdout.on("data", (chunk) => {
      const text = chunk.toString()
      output += text
      onData(text)
    })

    proc.stderr.on("data", (chunk) => {
      const text = chunk.toString()
      output += text
      onData(text)
    })

    proc.on("close", (code) => {
      clearTimeout(timer)
      resolve({
        code: typeof code === "number" ? code : 1,
        output: timedOut ? `${output}\nCommand timed out after ${Math.floor(timeoutMs / 1000)}s.` : output,
      })
    })

    proc.on("error", (error) => {
      clearTimeout(timer)
      resolve({
        code: 1,
        output: `${output}\n${error.message}`.trim(),
      })
    })
  })
}

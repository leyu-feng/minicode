import childProcess from "node:child_process"
import { randomUUID } from "node:crypto"
import { StringDecoder } from "node:string_decoder"
import { killTree } from "./kill-tree.js"

const MAX_OUTPUT_CHARS = 12000

export class AgentPowerShell {
  constructor({ shell, cwd, env, onStateLost, onBackgroundOutput }) {
    this.shell = shell
    this.cwd = cwd
    this.env = env
    this.onStateLost = onStateLost
    this.onBackgroundOutput = onBackgroundOutput
    this.proc = null
    this.pending = null
    this.closed = false
  }

  run(command, { signal, onData, onRequest } = {}) {
    if (this.closed) throw new Error("PowerShell session is closed")
    if (this.pending) throw new Error("PowerShell session is still running a command")
    signal?.throwIfAborted()
    return new Promise(resolve => {
      const marker = `__MINICODE_${randomUUID().replaceAll("-", "")}_DONE__:`
      const run = {
        marker, resolve, onData, signal, output: "", truncated: false,
        streams: { stdout: { buffer: "", done: false }, stderr: { buffer: "", done: false } },
      }
      this.pending = run
      run.abort = () => this.#reset("Command cancelled.", 130)
      signal?.addEventListener("abort", run.abort, { once: true })
      run.timer = setTimeout(() => this.#reset("Command timed out after 120s.", 1), 120000)
      try {
        if (!this.proc) this.#start()
        const status = `__minicode_${randomUUID().replaceAll("-", "")}`
        const completed = `${status}_finished`
        const encoded = Buffer.from(`try {\n${command}\n} finally { $global:${status}=if ($?) { 0 } else { 1 } }`, "utf8").toString("base64")
        onRequest?.({ shell: this.shell, pid: this.proc.pid })
        // Dot-sourcing preserves variables, functions and modules. Out-Default
        // flushes PowerShell's formatter before either completion marker.
        this.proc.stdin.write(
          `$${status}=1; $${completed}=$false; try { . ([scriptblock]::Create([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')))) | Out-Default; $${completed}=$true } catch { $${status}=1; $${completed}=$true; [Console]::Error.WriteLine(($_ | Out-String)) } finally { if ($${completed}) { [Console]::Out.Write('${marker}'+$${status}+':END__'); [Console]::Error.Write('${marker}'+$${status}+':END__') }; Remove-Variable -Name '${status}','${completed}' -ErrorAction SilentlyContinue }\n`,
        )
      } catch (error) {
        this.#reset(`PowerShell command could not start: ${error.message}`, 1)
      }
    })
  }

  #start() {
    const file = this.shell === "powershell-5.1" ? "powershell.exe" : "pwsh.exe"
    const proc = childProcess.spawn(file, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "-"], {
      cwd: this.cwd, env: this.env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
    })
    this.proc = proc
    for (const stream of ["stdout", "stderr"]) {
      const decoder = new StringDecoder("utf8")
      proc[stream].on("data", chunk => {
        if (this.proc === proc) this.#read(decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)), stream)
      })
      proc[stream].on("end", () => {
        if (this.proc === proc) this.#read(decoder.end(), stream)
      })
    }
    proc.stdin.on("error", error => {
      if (this.proc === proc) this.#reset(`PowerShell input failed: ${error.message}`, 1)
    })
    proc.on("error", error => {
      if (this.proc !== proc) return
      const message = error.code === "ENOENT"
        ? this.shell === "powershell-5.1"
          ? "Windows PowerShell 5.1 was requested but powershell.exe is unavailable on PATH."
          : "PowerShell 7 (pwsh) is required on Windows. Install it and make pwsh.exe available on PATH."
        : error.message
      this.#reset(message, 1)
    })
    proc.on("exit", (code, signal) => {
      if (this.proc !== proc) return
      proc.exitDescription = signal || code
      // Descendants can hold the pipes open after the shell itself exits.
      proc.exitTimer = setTimeout(() => {
        if (this.proc === proc) this.#reset(`PowerShell process exited (${proc.exitDescription}).`, 1)
      }, 1000)
    })
    proc.on("close", (code, signal) => {
      clearTimeout(proc.exitTimer)
      if (this.proc === proc) this.#reset(`PowerShell process exited (${signal || code}).`, 1)
    })
    proc.stdin.write("[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false); $OutputEncoding = [Console]::OutputEncoding\n")
  }

  #append(text) {
    if (!text) return
    const run = this.pending
    if (!run) {
      this.onBackgroundOutput?.(text)
      return
    }
    const remaining = MAX_OUTPUT_CHARS - run.output.length
    run.output += text.slice(0, remaining)
    if (text.length > remaining) run.truncated = true
    run.onData?.(text)
  }

  #read(text, stream) {
    const run = this.pending
    if (!run) return this.#append(text)
    const state = run.streams[stream]
    state.buffer += text
    const index = state.buffer.indexOf(run.marker)
    if (index !== -1) {
      this.#append(state.buffer.slice(0, index))
      if (this.pending !== run) return
      state.buffer = state.buffer.slice(index)
      const match = state.buffer.slice(run.marker.length).match(/^(-?\d+):END__/)
      if (!match) return
      state.done = true
      state.code = Number(match[1])
      const remainder = state.buffer.slice(run.marker.length + match[0].length)
      state.buffer = ""
      if (remainder) this.#append(remainder)
      if (this.pending !== run) return
      if (run.streams.stdout.done && run.streams.stderr.done) {
        if (run.streams.stdout.code !== run.streams.stderr.code) {
          this.#reset("PowerShell completion markers disagreed.", 1)
        } else this.#finish(run.streams.stdout.code)
      }
      return
    }
    let keep = Math.min(state.buffer.length, run.marker.length - 1)
    while (keep && !state.buffer.endsWith(run.marker.slice(0, keep))) keep--
    this.#append(state.buffer.slice(0, state.buffer.length - keep))
    if (this.pending !== run) return
    state.buffer = state.buffer.slice(state.buffer.length - keep)
  }

  #finish(code, message = "") {
    const run = this.pending
    if (!run) return
    this.pending = null
    clearTimeout(run.timer)
    run.signal?.removeEventListener("abort", run.abort)
    const output = run.output.replace(/[ \t]+(?=\r?\n)/g, "").replace(/[ \t]+$/, "")
    run.resolve({ code, output: output + (run.truncated ? "\n...<truncated>" : "") + (message ? `\n${message}` : "") })
  }

  #reset(reason, code) {
    const proc = this.proc
    this.proc = null
    if (proc) {
      clearTimeout(proc.exitTimer)
      if (proc.exitCode === null) killTree(proc.pid)
      proc.stdin.destroy()
    }
    const notice = `${this.shell} session state was lost. ${reason} The next command will start a fresh session.`
    if (this.pending) {
      for (const state of Object.values(this.pending.streams)) {
        if (state.buffer && !state.buffer.startsWith(this.pending.marker)) this.#append(state.buffer)
      }
      this.#finish(code, notice)
    }
    this.onStateLost?.(notice)
  }

  dispose() {
    if (this.closed) return
    this.closed = true
    this.onStateLost = null
    this.onBackgroundOutput = null
    this.#reset("Session closed.", 130)
  }
}

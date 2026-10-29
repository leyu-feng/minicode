import childProcess from "node:child_process"
import { randomUUID } from "node:crypto"
import { StringDecoder } from "node:string_decoder"
import { killTree } from "./kill-tree.js"

const MAX_OUTPUT_CHARS = 12000

export class AgentPowerShell {
  constructor({ shell, cwd, env, onStateLost, onBackgroundOutput, onLanguageMode }) {
    this.shell = shell
    this.cwd = cwd
    this.env = env
    this.onStateLost = onStateLost
    this.onBackgroundOutput = onBackgroundOutput
    this.onLanguageMode = onLanguageMode
    this.languageMode = null
    this.proc = null
    this.pending = null
    this.closed = false
    this.processClosures = new Set()
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
      run.timer = setTimeout(() => this.#reset("PowerShell language-mode detection timed out after 10s; command was not executed.", 1), 10000)
      try {
        run.execute = () => {
          if (this.pending !== run) return
          clearTimeout(run.timer)
          run.timer = setTimeout(() => this.#reset("Command timed out after 120s.", 1), 120000)
          try {
            const status = `__minicode_${randomUUID().replaceAll("-", "")}`
            const completed = `${status}_finished`
            const script = `try {\n${command}\n} finally { $global:${status}=if ($?) { 0 } else { 1 } }`
            onRequest?.({ shell: this.shell, pid: this.proc.pid })
            if (this.languageMode !== "FullLanguage") {
              // Invoke-Expression uses the current scope and enforced language
              // mode; no ScriptBlock compilation or policy changes are needed.
              const literal = "'" + script.replaceAll("'", "''").replace(/[^\x20-\x7e]/g, char => `' + [char]${char.charCodeAt(0)} + '`) + "'"
              run.singleStream = true
              run.outputMarker = marker.replace("_DONE__:", "_OUTPUT__:")
              // ASCII framing preserves Unicode without changing Console's
              // encoding, which ConstrainedLanguage does not permit.
              const output = `Out-String -Stream | ForEach-Object { Write-Output ('${run.outputMarker}' + (-join ($_.ToCharArray() | ForEach-Object { ([int]$_).ToString('x4') })) + '000a:END__') }`
              this.proc.stdin.write(
                `$${status}=1; $${completed}=$false; try { Invoke-Expression -Command (${literal}) 2>&1 | ${output}; $${completed}=$true } catch { $${status}=1; $${completed}=$true; $_ | ${output} } finally { if ($${completed}) { Write-Output ('${marker}'+$${status}+':END__') }; Remove-Variable -Name '${status}','${completed}' -ErrorAction SilentlyContinue }\n`,
              )
              return
            }
            const encoded = Buffer.from(script, "utf8").toString("base64")
            // Dot-sourcing preserves variables, functions and modules. Out-Default
            // flushes PowerShell's formatter before either completion marker.
            this.proc.stdin.write(
              `$${status}=1; $${completed}=$false; try { . ([scriptblock]::Create([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')))) | Out-Default; $${completed}=$true } catch { $${status}=1; $${completed}=$true; [Console]::Error.WriteLine(($_ | Out-String)) } finally { if ($${completed}) { [Console]::Out.Write('${marker}'+$${status}+':END__'); [Console]::Error.Write('${marker}'+$${status}+':END__') }; Remove-Variable -Name '${status}','${completed}' -ErrorAction SilentlyContinue }\n`,
            )
          } catch (error) {
            this.#reset(`PowerShell command could not start: ${error.message}`, 1)
          }
        }
        if (!this.proc) this.#start()
        else run.execute()
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
    const closed = new Promise(resolve => proc.once("close", resolve))
    this.processClosures.add(closed)
    void closed.then(() => this.processClosures.delete(closed))
    proc.modeMarker = `__MINICODE_${randomUUID().replaceAll("-", "")}_MODE__:`
    proc.modeBuffer = ""
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
    proc.stdin.write(`Write-Output ('${proc.modeMarker}' + $ExecutionContext.SessionState.LanguageMode + ':END__')\n`)
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
    if (stream === "stdout" && this.languageMode === null) {
      const proc = this.proc
      proc.modeBuffer += text
      if (proc.modeBuffer.length > 4096) {
        this.#reset("PowerShell language-mode detection returned excessive output; command was not executed.", 1)
        return
      }
      const index = proc.modeBuffer.indexOf(proc.modeMarker)
      if (index === -1) return
      const end = proc.modeBuffer.indexOf(":END__", index + proc.modeMarker.length)
      if (end === -1) return
      const mode = proc.modeBuffer.slice(index + proc.modeMarker.length, end)
      if (!["FullLanguage", "ConstrainedLanguage", "RestrictedLanguage", "NoLanguage"].includes(mode)) {
        this.#reset("PowerShell reported an unrecognized language mode.", 1)
        return
      }
      this.languageMode = mode
      const remainder = proc.modeBuffer.slice(end + ":END__".length).replace(/^\r?\n/, "")
      const preceding = proc.modeBuffer.slice(0, index)
      proc.modeBuffer = ""
      this.onLanguageMode?.({ shell: this.shell, pid: proc.pid, languageMode: mode })
      if (mode === "FullLanguage") {
        proc.stdin.write("[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false); $OutputEncoding = [Console]::OutputEncoding\n")
      }
      this.pending?.execute()
      text = preceding + remainder
      if (!text) return
    }
    const run = this.pending
    if (!run) return this.#append(text)
    const state = run.streams[stream]
    state.buffer += text
    if (run.singleStream && stream === "stdout") {
      let start
      while ((start = state.buffer.indexOf(run.outputMarker)) !== -1) {
        const end = state.buffer.indexOf(":END__", start + run.outputMarker.length)
        if (end === -1) return
        const newline = state.buffer.slice(end + ":END__".length).match(/^\r?\n/)
        if (!newline) return
        const hex = state.buffer.slice(start + run.outputMarker.length, end)
        if (!/^(?:[0-9a-f]{4})*$/i.test(hex)) {
          this.#reset("PowerShell returned an invalid output frame.", 1)
          return
        }
        this.#append(state.buffer.slice(0, start))
        if (this.pending !== run) return
        this.#append(Buffer.from(hex, "hex").swap16().toString("utf16le"))
        if (this.pending !== run) return
        state.buffer = state.buffer.slice(end + ":END__".length + newline[0].length)
      }
    }
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
      if (run.singleStream && stream === "stdout") {
        this.#finish(state.code)
        return
      }
      if (run.streams.stdout.done && run.streams.stderr.done) {
        if (run.streams.stdout.code !== run.streams.stderr.code) {
          this.#reset("PowerShell completion markers disagreed.", 1)
        } else this.#finish(run.streams.stdout.code)
      }
      return
    }
    const markers = run.outputMarker ? [run.marker, run.outputMarker] : [run.marker]
    let keep = Math.min(state.buffer.length, Math.max(...markers.map(marker => marker.length)) - 1)
    while (keep && !markers.some(marker => state.buffer.endsWith(marker.slice(0, keep)))) keep--
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
    this.languageMode = null
    if (proc) {
      clearTimeout(proc.exitTimer)
      if (proc.exitCode === null) killTree(proc.pid)
      proc.stdin.destroy()
      proc.stdout.destroy?.()
      proc.stderr.destroy?.()
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
    if (this.closed) return Promise.all(this.processClosures)
    this.closed = true
    this.onStateLost = null
    this.onBackgroundOutput = null
    this.onLanguageMode = null
    this.#reset("Session closed.", 130)
    return Promise.all(this.processClosures)
  }
}

import React, { useEffect, useMemo, useState } from "react"
import { Box, Text, render, useApp, useInput, useStdout } from "ink"
import { resolveModelConfig } from "./auth.js"
import { runAgentPrompt } from "./agent.js"

const e = React.createElement

function now() {
  return new Date().toLocaleTimeString()
}

function App() {
  const { exit } = useApp()
  const { stdout } = useStdout()
  const [input, setInput] = useState("")
  const [busy, setBusy] = useState(false)
  const [config, setConfig] = useState(null)
  const [error, setError] = useState("")
  const [logs, setLogs] = useState([{ type: "info", text: `minicode started (${now()})` }])

  useEffect(() => {
    let active = true
    resolveModelConfig()
      .then((value) => {
        if (!active) return
        setConfig(value)
        setLogs((prev) => [...prev, { type: "info", text: `Model: ${value.model} | Base: ${value.baseUrl}` }])
      })
      .catch((err) => {
        if (!active) return
        setError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      active = false
    }
  }, [])

  const appendLog = (entry) => {
    setLogs((prev) => {
      const next = [...prev, entry]
      return next.length > 300 ? next.slice(next.length - 300) : next
    })
  }

  useInput(async (value, key) => {
    if (key.ctrl && value === "c") {
      exit()
      return
    }
    if (busy) return
    if (key.return) {
      const prompt = input.trim()
      setInput("")
      if (!prompt) return
      if (prompt === "exit" || prompt === "/exit") {
        exit()
        return
      }
      if (!config) {
        appendLog({ type: "error", text: "Model config not ready yet." })
        return
      }

      setBusy(true)
      appendLog({ type: "user", text: `> ${prompt}` })
      try {
        await runAgentPrompt(prompt, config, (entry) => appendLog(entry))
      } catch (err) {
        appendLog({ type: "error", text: err instanceof Error ? err.message : String(err) })
      } finally {
        setBusy(false)
      }
      return
    }

    if (key.backspace || key.delete) {
      setInput((prev) => prev.slice(0, -1))
      return
    }

    if (!key.ctrl && !key.meta && value) {
      setInput((prev) => prev + value)
    }
  })

  const width = stdout.columns || 120
  const visibleLogs = useMemo(() => {
    const max = 40
    return logs.slice(logs.length > max ? logs.length - max : 0)
  }, [logs])

  const colorFor = (type) => {
    switch (type) {
      case "user":
        return "cyan"
      case "tool":
        return "yellow"
      case "assistant":
        return "green"
      case "error":
        return "red"
      case "result":
        return "magenta"
      default:
        return "gray"
    }
  }

  return e(
    Box,
    { flexDirection: "column", width },
    e(Text, { bold: true, color: "blue" }, "Minicode (Ink + child_process)"),
    e(Text, { color: "gray" }, "Type prompt, Enter to run, exit or /exit to quit."),
    error ? e(Text, { color: "red" }, `Auth error: ${error}`) : null,
    e(Box, { marginTop: 1, flexDirection: "column" }, ...visibleLogs.map((item, idx) => e(Text, { key: `${idx}-${item.type}`, color: colorFor(item.type) }, item.text))),
    e(Box, { marginTop: 1 }, e(Text, { color: busy ? "yellow" : "white" }, `${busy ? "running" : "ready"} > ${input}`)),
  )
}

render(e(App))

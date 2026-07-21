import { runShellCommand } from "./shell.js"

function extractTextContent(message) {
  if (!message) return ""
  if (typeof message.content === "string") return message.content
  if (Array.isArray(message.content)) {
    return message.content
      .map((part) => {
        if (typeof part === "string") return part
        if (part && typeof part === "object" && typeof part.text === "string") return part.text
        return ""
      })
      .join("")
      .trim()
  }
  return ""
}

function parseJsonAction(text) {
  const trimmed = text.trim()
  try {
    return JSON.parse(trimmed)
  } catch {}

  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)
  if (fence) {
    try {
      return JSON.parse(fence[1])
    } catch {}
  }
  return null
}

async function callModel(config, messages, systemPrompt) {
  const response = await fetch(`${config.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: config.model,
      temperature: 0.2,
      messages: [
        {
          role: "system",
          content: systemPrompt,
        },
        ...messages,
      ],
    }),
  })

  if (!response.ok) {
    const error = await response.text()
    throw new Error(`Model request failed (${response.status}): ${error}`)
  }

  const data = await response.json()
  const text = extractTextContent(data?.choices?.[0]?.message)
  if (!text) throw new Error("Model returned an empty response.")
  return text
}

function truncate(value, max = 12000) {
  if (!value) return ""
  if (value.length <= max) return value
  return `${value.slice(0, max)}\n...<truncated>`
}

export async function runAgentPrompt(prompt, config, onEvent) {
  const systemPrompt = [
    "You are a practical coding agent.",
    "You can run shell commands to complete user requests.",
    "Respond ONLY with one JSON object:",
    '{"type":"tool","command":"<shell command>","reason":"<short reason>"}',
    "or",
    '{"type":"final","message":"<final user-facing response>"}',
    "No markdown. No code fences.",
  ].join(" ")

  const messages = [{ role: "user", content: prompt }]

  for (let turn = 0; turn < 10; turn++) {
    const raw = await callModel(config, messages, systemPrompt)
    const action = parseJsonAction(raw)

    if (!action || typeof action !== "object") {
      onEvent({ type: "assistant", text: raw })
      return
    }

    if (action.type === "final" && typeof action.message === "string") {
      onEvent({ type: "assistant", text: action.message })
      return
    }

    if (action.type !== "tool" || typeof action.command !== "string" || !action.command.trim()) {
      onEvent({ type: "assistant", text: raw })
      return
    }

    const command = action.command.trim()
    onEvent({ type: "tool", text: `$ ${command}` })
    const result = await runShellCommand(command, {
      onData: (chunk) => onEvent({ type: "output", text: chunk }),
    })

    const output = truncate(result.output)
    onEvent({ type: "result", text: `exit code: ${result.code}` })

    messages.push(
      { role: "assistant", content: raw },
      {
        role: "user",
        content: [
          "TOOL_RESULT",
          `command: ${command}`,
          `exitCode: ${result.code}`,
          `output:\n${output || "<empty>"}`,
        ].join("\n"),
      },
    )
  }

  onEvent({ type: "error", text: "Stopped after max tool turns." })
}

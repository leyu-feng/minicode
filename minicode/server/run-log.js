import { stripVTControlCharacters } from "node:util"

export function createRunLogWriter(emit) {
  let current
  let lineStart = true
  const closeLine = () => {
    if (!lineStart) emit({ stream: current.stream, data: "\n" })
    lineStart = true
  }
  return {
    write(source, data, stream = "stdout") {
      data = stripVTControlCharacters(data)
      if (!data) return
      if (current && (current.source !== source || current.stream !== stream)) closeLine()
      current = { source, stream }
      let formatted = ""
      for (const part of data.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
        const blank = part === "\n" || part === "\r\n"
        if (lineStart && !blank) {
          formatted += `${stream === "stderr" ? "!! " : ""}[${source}] `
        }
        formatted += lineStart && source === "minicode" ? part.replace(/^\[minicode\] /, "") : part
        lineStart = part.endsWith("\n")
      }
      emit({ stream, data: formatted })
    },
    marker(source, message, end = false) {
      closeLine()
      current = { source, stream: "stdout" }
      emit({ stream: "stdout", data: `${end ? "<<" : ">>"} [${source}] ${message}\n` })
    },
  }
}

import assert from "node:assert/strict"
import test from "node:test"
import { createRunLogWriter } from "../server/run-log.js"

test("run logs preserve partial lines and distinguish sources, warnings and boundaries", () => {
  const output = []
  const writer = createRunLogWriter(event => output.push(event))
  writer.marker("pi", "Turn start")
  writer.write("pi", "hel")
  writer.write("pi", "lo\r")
  writer.write("pi", "\nnext")
  writer.write("pi", "\u001b[33mWarning\u001b[0m\n", "stderr")
  writer.write("pi", "continued")
  writer.marker("pi", "Round 1 end", true)
  writer.write("framework", "finished\n")
  assert.equal(output.map(event => event.data).join(""),
    ">> [pi] Turn start\n[pi] hello\r\n[pi] next\n!! [pi] Warning\n[pi] continued\n<< [pi] Round 1 end\n[framework] finished\n")
  assert.deepEqual(output.filter(event => event.stream === "stderr").map(event => event.data), ["!! [pi] Warning\n"])
})

test("multiline preparation logs label every nonblank line without duplicating legacy labels", () => {
  const output = []
  const writer = createRunLogWriter(event => output.push(event))
  writer.write("prep", "\u001b[36mWorkspace layout:\u001b[0m\n  repo-a\n\n  repo-b\r\n")
  writer.write("minicode", "[minicode] Model rate limited; trying fallback.\n", "stderr")
  assert.equal(output.map(event => event.data).join(""),
    "[prep] Workspace layout:\n[prep]   repo-a\n\n[prep]   repo-b\r\n!! [minicode] Model rate limited; trying fallback.\n")
})

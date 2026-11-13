import { execFile } from "node:child_process"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)
const SOURCE = "minicode-worker"
const AGENT = "minicode"

function clean(value, fallback) {
  const text = String(value ?? "").replace(/[\x00-\x1f\x7f]+/g, " ").replace(/\s+/g, " ").trim()
  return (text || fallback).slice(0, 160)
}

async function runHerdr(args, env) {
  await execFileAsync("herdr", args, { env, windowsHide: true, timeout: 5_000 })
}

export function createHerdrWorkerReporter({ workerName, env = process.env, run = runHerdr,
  log = message => process.stderr.write(`${message}\n`) } = {}) {
  const pane = env.HERDR_PANE_ID
  if (env.HERDR_ENV !== "1" || !/^w\d+:p\d+$/.test(pane ?? "") || env.MINICODE_WORKERS_MODE === "1") {
    return { enabled: false, state: async () => {}, activity: () => {}, stop: async () => {} }
  }

  const displayName = clean(workerName, "Minicode worker")
  let sequence = 0
  let lifecycle = "idle"
  let queue = Promise.resolve()
  let reportedError = false
  let released = false

  const enqueue = commands => {
    queue = queue.then(async () => {
      for (const args of commands) await run(args, env)
    }).catch(error => {
      if (!reportedError) {
        reportedError = true
        log(`[herdr] Worker status reporting failed: ${error.message}`)
      }
    })
    return queue
  }

  const report = (state, detail) => {
    lifecycle = state
    const seq = String(++sequence)
    const title = `${state === "idle" ? "Idle" : "Busy"} - ${clean(detail, state === "idle" ? "waiting for assignment" : "working")}`
    return enqueue([
      ["pane", "report-metadata", "--source", SOURCE, "--applies-to-source", SOURCE,
        "--display-agent", displayName, "--state-label", "idle=idle", "--state-label", "working=busy",
        "--title", title, "--seq", seq, pane],
      ["pane", "report-agent", "--source", SOURCE, "--agent", AGENT, "--state", state,
        "--message", title, "--seq", seq, pane],
    ])
  }

  return {
    enabled: true,
    async state(value) {
      if (value.state === "stopped") return this.stop()
      if (released) return
      if (value.state === "idle") await report("idle", "waiting for assignment")
      else if (value.state === "busy") await report("working", "starting assignment")
    },
    activity(value) {
      if (lifecycle !== "working") return
      if (value.kind === "model_action" && value.target) {
        void report("working", value.summary || `running ${value.action || "tool"}`)
      } else if (value.kind === "tool_result" && value.target) {
        void report("working", `${value.action || "tool"} completed; processing result`)
      } else if (value.kind === "error" && value.target) {
        void report("working", `${value.action || "tool"} failed; handling error`)
      } else if (value.action === "model_request") {
        void report("working", "thinking")
      }
    },
    async stop() {
      if (released) return
      released = true
      await enqueue([["pane", "release-agent", "--source", SOURCE, "--agent", AGENT,
        "--seq", String(++sequence), pane]])
    },
  }
}

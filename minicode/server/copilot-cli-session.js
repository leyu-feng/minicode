import fs from "node:fs/promises"
import { constants } from "node:fs"
import path from "node:path"
import { HostedHarnessSession } from "./hosted-harness-session.js"

export async function resolveCopilotExecutable(executable, { env = process.env, platform = process.platform } = {}) {
  if (executable !== undefined && (!path.isAbsolute(executable) || /[\r\n\0]/.test(executable))) {
    throw new Error("--copilot-path must be an absolute executable path")
  }
  const names = platform === "win32" ? ["copilot.exe"] : ["copilot"]
  const candidates = executable === undefined
    ? (env.PATH ?? env.Path ?? "").split(path.delimiter).filter(Boolean)
      .flatMap(directory => names.map(name => path.resolve(directory.replace(/^"(.*)"$/, "$1"), name)))
    : [executable]
  for (const candidate of candidates) {
    if (platform === "win32" && !candidate.toLowerCase().endsWith(".exe")) {
      throw new Error("Windows Copilot workers require copilot.exe, not a shell or .cmd wrapper")
    }
    try {
      await fs.access(candidate, platform === "win32" ? constants.F_OK : constants.X_OK)
      if ((await fs.stat(candidate)).isFile()) return candidate
    } catch (error) {
      if (!["ENOENT", "ENOTDIR", "EACCES"].includes(error.code)) throw error
    }
  }
  throw new Error("Copilot CLI executable not found. Install/sign in to Copilot CLI and put it on PATH, or supply --copilot-path")
}

export class CopilotCliSession extends HostedHarnessSession {
  constructor({ executable, model, ...options }) {
    super({
      ...options, harness: "copilotcli", localCopilot: true,
      githubCredential: undefined, modelConfig: undefined, harnessModel: model,
      prepare: async () => ({ harness: "copilotcli", command: executable, version: "local" }),
    })
  }
}

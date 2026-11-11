import assert from "node:assert/strict"
import test from "node:test"
import { spawn } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { CopilotCliSession, resolveCopilotExecutable } from "../server/copilot-cli-session.js"
import { runAgentPoolWorkerCli } from "../server/agent-pool-worker.js"

async function fixture(t, script, options = {}) {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "copilot worker test "))
  t.after(() => fs.rm(cwd, { recursive: true, force: true }))
  const logs = [], activities = [], details = []
  let invocation, mcpPath
  const executable = path.join(cwd, "copilot.exe")
  const session = new CopilotCliSession({
    executable, id: "local-run", cwd, env: { PAPERCLIP_API_KEY: "run-secret", ASSIGNMENT_ONLY: "not-for-cli" },
    instructions: "Trusted worker instructions", model: "gpt-test", tools: [],
    ...options,
    spawnProcess: (file, args, settings) => {
      invocation = { file, args, settings }
      mcpPath = args[args.indexOf("--additional-mcp-config") + 1].slice(1)
      return spawn(process.execPath, ["--input-type=module", "-e", script], {
        ...settings, env: { ...settings.env, TEST_MCP_PATH: mcpPath }, windowsHide: true,
      })
    },
  })
  t.after(() => session.dispose())
  session.on("output", event => logs.push(event))
  session.on("activity", event => activities.push(event))
  session.on("tool_detail", event => details.push(event))
  return { session, logs, activities, details, cwd, executable, get invocation() { return invocation }, get mcpPath() { return mcpPath } }
}

test("local Copilot uses the native executable and assignment tools, with redacted useful progress and heartbeat", async t => {
  t.mock.timers.enable({ apis: ["setInterval", "Date"] })
  const f = await fixture(t, `
    import fs from "node:fs/promises";
    let prompt = "";
    for await (const chunk of process.stdin) prompt += chunk;
    if (!prompt.includes("Trusted worker instructions") || !prompt.includes("Build the project")) throw new Error("Missing assignment");
    if (process.env.PAPERCLIP_API_KEY || process.env.ASSIGNMENT_ONLY || process.env.OPENCODE_MODEL) throw new Error("Leaked worker configuration");
    const config = JSON.parse(await fs.readFile(process.env.TEST_MCP_PATH, "utf8")).mcpServers.hosted;
    if (!config.tools.includes("build_project") || !config.tools.includes("edit_file")) throw new Error("Missing permitted tools");
    const call = async (id, name, args) => {
      const response = await fetch(config.url, {
        method: "POST", headers: { ...config.headers, "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } })
      });
      if (!response.ok) throw new Error("MCP failed");
      return response.json();
    };
    console.log(JSON.stringify({ type: "assistant.turn_start" }));
    await call(1, "build_project", { command: "dotnet build", cwd: "assigned workspace", password: "input-password", reasoning: "hidden-reasoning" });
    await call(2, "write_file", { path: "proof.txt", content: "original" });
    await call(3, "edit_file", { path: "proof.txt", find: "original", replace: "updated" });
    const failure = await call(4, "failed_build", {});
    if (!failure.result.isError) throw new Error("Missing tool failure");
    console.log(JSON.stringify({ type: "assistant.message_delta", data: { deltaContent: "Build complete" } }));
    console.log(JSON.stringify({ type: "assistant.message", data: { content: "Build complete run-secret" } }));
    console.log(JSON.stringify({ type: "result", exitCode: 0 }));
  `, { tools: [
    { name: "build_project", description: "Build the assigned project", parameters: { type: "object" }, execute: async () => {
      t.mock.timers.tick(30_000)
      return { result: `BUILD_SUCCEEDED run-secret ${"x".repeat(9000)}`, token: "hidden-tool-token" }
    } },
    { name: "failed_build", description: "A build error", parameters: { type: "object" },
      execute: async () => { throw new Error("Compilation failed run-secret") } },
  ] })
  const result = await f.session.write("Build the project")
  assert.equal(result.exitCode, 0, result.error)
  assert.equal(result.summary, "Build complete [redacted]")
  assert.equal(f.invocation.file, f.executable)
  assert.equal(f.invocation.settings.cwd, f.cwd)
  assert.equal(f.invocation.settings.env.USERPROFILE, process.env.USERPROFILE)
  assert.equal(f.invocation.settings.env.HOME, process.env.HOME)
  const args = f.invocation.args
  for (const flag of ["--disable-builtin-mcps", "--no-custom-instructions", "--no-ask-user", "--silent"]) assert.ok(args.includes(flag))
  assert.equal(args[args.indexOf("--model") + 1], "gpt-test")
  assert.ok(args.includes("hosted-build_project"))
  assert.ok(args.includes("hosted(build_project)"))
  assert.equal(await fs.readFile(path.join(f.cwd, "proof.txt"), "utf8"), "updated")
  const normal = f.logs.filter(event => event.stream !== "command").map(event => event.data).join("")
  for (const text of ["dotnet build", "proof.txt", "30000 ms", "still running", "waiting for build_project"]) assert.ok(normal.includes(text), text)
  for (const text of ["BUILD_SUCCEEDED", "Compilation failed", "assigned workspace", "9000"]) assert.ok(!normal.includes(text), text)
  assert.ok(f.details.some(event => event.output?.includes("BUILD_SUCCEEDED")))
  assert.ok(f.details.some(event => event.error?.includes("Compilation failed")))
  assert.equal(f.details[0].callId, f.details[1].callId)
  const all = JSON.stringify([f.logs, f.activities, f.details, result])
  for (const secret of ["run-secret", "input-password", "hidden-reasoning", "hidden-tool-token"]) assert.ok(!all.includes(secret), secret)
  assert.ok(f.activities.some(event => event.action === "round_start"))
  assert.ok(f.activities.some(event => event.kind === "tool_result" && event.action === "build_project"))
  await assert.rejects(fs.stat(f.mcpPath), { code: "ENOENT" })
})

for (const [name, script, error] of [
  ["native error", 'console.log(JSON.stringify({type:"session.error",data:{message:"Model unavailable run-secret"}})); console.log(JSON.stringify({type:"result",exitCode:0}));', /Model unavailable \[redacted\]/],
  ["failed result", 'console.log(JSON.stringify({type:"result",exitCode:1}));', /Copilot CLI failed \(exit 1\)/],
  ["failed process", 'console.log(JSON.stringify({type:"result",exitCode:0,result:"Done"})); process.exitCode = 2;', /did not complete successfully/],
  ["missing completion", 'console.log(JSON.stringify({type:"assistant.message",data:{content:"Partial"}}));', /did not complete successfully/],
  ["empty result", 'console.log(JSON.stringify({type:"result",exitCode:0}));', /no final response/],
  ["invalid JSON", 'console.log("not JSON");', /malformed JSON/],
]) {
  test(`local Copilot reports ${name} without falling back to Minicode`, async t => {
    const f = await fixture(t, `for await (const chunk of process.stdin) {} ${script}`)
    const result = await f.session.write("Task")
    assert.equal(result.exitCode, 1)
    assert.match(result.error, error)
    assert.ok(!JSON.stringify(result).includes("run-secret"))
    await assert.rejects(fs.stat(f.mcpPath), { code: "ENOENT" })
  })
}

test("local Copilot cancellation stops its process and removes the tool configuration", async t => {
  const f = await fixture(t, `
    for await (const chunk of process.stdin) {}
    console.log(JSON.stringify({ type: "assistant.turn_start" }));
    setInterval(() => {}, 1000);
  `)
  f.session.on("activity", event => { if (event.action === "round_start") f.session.interrupt() })
  const result = await f.session.write("Task")
  assert.equal(result.exitCode, 130)
  await assert.rejects(fs.stat(f.mcpPath), { code: "ENOENT" })
})

test("Copilot executable discovery handles PATH entries with spaces and rejects missing files and shell wrappers", async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "copilot path test "))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const executable = path.join(directory, process.platform === "win32" ? "copilot.exe" : "copilot")
  await fs.writeFile(executable, "fixture", { mode: 0o700 })
  assert.equal(await resolveCopilotExecutable(undefined, { env: { PATH: directory } }), executable)
  assert.equal(await resolveCopilotExecutable(executable), executable)
  await assert.rejects(resolveCopilotExecutable("copilot"), /absolute executable path/)
  await assert.rejects(resolveCopilotExecutable(path.join(directory, "missing.exe")), /executable not found/)
  await assert.rejects(resolveCopilotExecutable(path.join(directory, "copilot.cmd"), { platform: "win32" }), /not a shell or .cmd wrapper/)
  await assert.rejects(resolveCopilotExecutable(undefined, { env: { PATH: "" } }), /executable not found/)
})

test("worker harness CLI rejects invalid or mismatched options before pairing", async () => {
  await assert.rejects(runAgentPoolWorkerCli(["--harness", "unknown"]), /--harness must be/)
  await assert.rejects(runAgentPoolWorkerCli(["--harness", "default", "--copilot-path", process.execPath]), /requires --harness copilotcli/)
  await assert.rejects(runAgentPoolWorkerCli(["--harness", "copilotcli", "--copilot-path", "relative.exe"]), /absolute executable path/)
})

test("paired worker CLI defaults to native Copilot before pairing", async () => {
  await assert.rejects(runAgentPoolWorkerCli(["--copilot-path", "relative.exe"]), /absolute executable path/)
  await assert.rejects(runAgentPoolWorkerCli(["--copilot-path", process.execPath]), /Worker requires --worker-id/)
  await assert.rejects(runAgentPoolWorkerCli(["--harness", "default"]), /Worker requires --worker-id/)
})

import test from "node:test"
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { startSecretStore } from "../server/secret-store.js"

async function request(env, message, capability = env.MINICODE_SECRET_STORE_CAPABILITY) {
  const response = await fetch(env.MINICODE_SECRET_STORE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${capability}` },
    body: JSON.stringify(message),
    redirect: "error",
  })
  return { status: response.status, body: await response.json() }
}

test("HTTP process store shares values with child processes and rejects invalid capabilities", async () => {
  const store = await startSecretStore()
  try {
    assert.deepEqual(await request(store.env, { op: "set", key: "test/key", value: "dummy-value" }), { status: 200, body: { ok: true } })
    assert.deepEqual(await request(store.env, { op: "get", key: "test/key" }, "a".repeat(64)), { status: 401, body: { ok: false } })
    const child = spawn(process.execPath, ["--input-type=module", "-e", `
      const response = await fetch(process.env.MINICODE_SECRET_STORE_URL, {
        method: 'POST', headers: {'Content-Type':'application/json', Authorization:'Bearer '+process.env.MINICODE_SECRET_STORE_CAPABILITY},
        body: JSON.stringify({op:'get',key:'test/key'}), redirect:'error'
      });
      const result = await response.json();
      if (!response.ok || result.value !== 'dummy-value') process.exitCode=1;
    `], { env: { ...process.env, ...store.env }, stdio: "ignore" })
    const code = await new Promise((resolve, reject) => { child.on("error", reject); child.on("exit", resolve) })
    assert.equal(code, 0)
    assert.deepEqual(await request(store.env, { op: "delete", key: "test/key" }), { status: 200, body: { ok: true } })
    assert.deepEqual(await request(store.env, { op: "get", key: "test/key" }), { status: 200, body: { ok: true, value: null } })
  } finally { store.close() }
})

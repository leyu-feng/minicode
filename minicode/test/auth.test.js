import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test, { after, before } from "node:test"
import {
  addAzureDeployment,
  authFilePath,
  clearAuth,
  getActiveAzureDeployment,
  listAzureDeployments,
  readAuth,
  setActiveAzureDeployment,
} from "../server/auth.js"

let configHome

before(async () => {
  configHome = await fs.mkdtemp(path.join(os.tmpdir(), "minicode-auth-test-"))
  process.env.MINICODE_CONFIG_HOME = configHome
})

after(async () => {
  delete process.env.MINICODE_CONFIG_HOME
  await fs.rm(configHome, { recursive: true, force: true })
})

test("stores named Azure deployments and selects the active one", async () => {
  await addAzureDeployment({ name: "primary-resource", model: "gpt-5.6-sol" })
  await addAzureDeployment({ name: "other-resource", model: "gpt-5.4", activate: false })

  assert.deepEqual(await getActiveAzureDeployment(), {
    name: "primary-resource",
    endpoint: "https://primary-resource.services.ai.azure.com/openai/v1/responses",
    model: "gpt-5.6-sol",
  })

  await setActiveAzureDeployment("other-resource")
  const deployments = await listAzureDeployments()
  assert.equal(deployments.length, 2)
  assert.equal(deployments.find((item) => item.name === "other-resource").active, true)
  assert.equal(authFilePath(), path.join(configHome, "auth.json"))
})

test("rejects deployment names that cannot form an Azure hostname", async () => {
  await assert.rejects(
    addAzureDeployment({ name: "https://invalid.example", model: "gpt-5.6-sol" }),
    /only letters, numbers, and hyphens/,
  )
})

test("clears deployment configuration without requiring an existing file", async () => {
  assert.equal(await clearAuth(), true)
  assert.deepEqual(await listAzureDeployments(), [])
  assert.equal(await clearAuth(), false)
})

test("removes legacy Copilot credentials without changing Azure deployments", async () => {
  await fs.writeFile(
    authFilePath(),
    JSON.stringify({
      active: { provider: "github-copilot", name: "copilot" },
      "azure-entra": {
        active: "primary-resource",
        deployments: {
          "primary-resource": {
            endpoint: "https://primary-resource.services.ai.azure.com/openai/v1/responses",
            model: "gpt-5.6-sol",
          },
        },
      },
      "github-copilot": { refresh: "legacy-token" },
    }),
  )

  const auth = await readAuth()
  assert.equal(auth["github-copilot"], undefined)
  assert.deepEqual(auth.active, { provider: "azure-entra", name: "primary-resource" })

  const persisted = JSON.parse(await fs.readFile(authFilePath(), "utf8"))
  assert.equal(persisted["github-copilot"], undefined)
  assert.equal(persisted["azure-entra"].deployments["primary-resource"].model, "gpt-5.6-sol")
})

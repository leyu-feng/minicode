import { acquireToken, createBrokerApplication } from "./wam.js"

export const AZURE_DEVOPS_RESOURCE = "499b84ac-1321-427f-aa17-267ca6975798"

export async function acquireAzureDevOpsToken({ organization, user, clientId, silentOnly },
  { fetchImpl = fetch, getToken = options => acquireToken(options, createBrokerApplication, () => {
    throw new Error("Azure DevOps authentication requires MSAL/WAM; no Azure CLI fallback is enabled.")
  }) } = {}) {
  const url = new URL(organization)
  if (url.protocol !== "https:" || url.hostname !== "dev.azure.com" || url.port
    || url.username || url.password || url.search || url.hash
    || !/^\/[a-z0-9][a-z0-9-]*\/?$/i.test(url.pathname)) {
    throw new Error("Azure DevOps authentication requires https://dev.azure.com/<organization>.")
  }
  if (typeof user !== "string" || !/^[^@\s]+@[^@\s]+$/.test(user)) throw new Error("Azure DevOps authentication requires --user <upn>.")
  const endpoint = new URL(`${url.href.replace(/\/$/, "")}/_apis/connectionData?api-version=7.1`)
  const challenge = await fetchImpl(endpoint, { redirect: "manual", signal: AbortSignal.timeout(30_000) })
  const tenant = challenge.headers.get("x-vss-resourcetenant")
  if (![200, 203, 302, 401, 403].includes(challenge.status)
    || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(tenant ?? "")) {
    throw new Error(`Azure DevOps did not identify its Entra tenant (HTTP ${challenge.status}).`)
  }
  const result = await getToken({
    authority: `https://login.microsoftonline.com/${tenant}`,
    clientId, scopes: [`${AZURE_DEVOPS_RESOURCE}/.default`], user, silentOnly,
  })
  if (result.account?.username?.toLowerCase() !== user.toLowerCase()
    || result.account?.tenantId?.toLowerCase() !== tenant.toLowerCase()) {
    throw new Error("Azure DevOps sign-in returned a different account or tenant.")
  }
  if (typeof result.accessToken !== "string" || !result.accessToken || /[\r\n]/.test(result.accessToken)
    || !(result.expiresOn instanceof Date) || !Number.isFinite(result.expiresOn.getTime())
    || result.expiresOn.getTime() <= Date.now() + 60_000) {
    throw new Error("Azure DevOps sign-in returned a missing or expired access token.")
  }
  return { accessToken: result.accessToken, expiresAt: result.expiresOn.toISOString(),
    user: result.account.username, tenantId: tenant }
}

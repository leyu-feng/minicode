// Easy Auth's 401 challenge names who to sign in to: the tenant (authorization_uri) and the
// registration a token must be for (resource_id). Reading it from the server keeps the tenant
// and audience out of every command line and config file.

import { serverOrigin } from "./session-store.js"

export function parseChallenge(header) {
  if (typeof header !== "string") return null
  const value = (name) => header.match(new RegExp(`${name}="([^"]+)"`))?.[1]
  const authorizationUri = value("authorization_uri")
  const resource = value("resource_id")
  const authority = authorizationUri?.match(
    /^https:\/\/(login\.microsoftonline\.(?:com|us|de)|login\.chinacloudapi\.cn)\/([a-z0-9][a-z0-9.-]*)(?:\/oauth2\/(?:v2\.0\/)?authorize)?\/?$/i,
  )
  if (!authority || !/^[a-z0-9][a-z0-9._:/-]*$/i.test(resource ?? "")) return null
  if (resource.includes(":")) {
    let url
    try {
      url = new URL(resource)
    } catch {
      return null
    }
    if (!["https:", "api:"].includes(url.protocol) || !url.hostname
      || url.username || url.password || url.search || url.hash) return null
  }
  return { authority: `https://${authority[1].toLowerCase()}/${authority[2]}`, resource }
}

// A 401 that Easy Auth sent, as opposed to one from Clippy itself: only Easy Auth's names an
// authorization_uri. The worker uses this to tell "renew the session" from "bad Clippy token".
export function isEasyAuthChallenge(status, header) {
  return status === 401 && parseChallenge(header) !== null
}

export async function readChallenge(server, fetchImpl = fetch) {
  const response = await fetchImpl(new URL("/api/health", serverOrigin(server)), {
    headers: { authorization: "Bearer clippy-auth-probe" },
    redirect: "manual",
  })
  const challenge = parseChallenge(response.headers.get("www-authenticate"))
  if (response.status !== 401 || !challenge) {
    throw new Error(
      `${server} did not answer with an Easy Auth challenge (HTTP ${response.status}). ` +
        "clippy-auth is only needed where Clippy is behind Entra sign-in.",
    )
  }
  return challenge
}

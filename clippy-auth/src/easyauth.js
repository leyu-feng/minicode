// Easy Auth's client-directed sign-in: an Entra access token posted to /.auth/login/aad comes back
// as an Easy Auth session token, which a client then sends as X-ZUMO-AUTH. That header is what lets
// a worker get past Easy Auth while Authorization keeps carrying Clippy's own token.

import { serverOrigin } from "./session-store.js"

export const SESSION_HEADER = "x-zumo-auth"

export function jwtExpiry(token) {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"))
    return Number.isFinite(payload.exp) ? new Date(payload.exp * 1000).toISOString() : null
  } catch {
    return null
  }
}

export async function exchangeForSession(server, accessToken, fetchImpl = fetch) {
  const response = await fetchImpl(new URL("/.auth/login/aad", serverOrigin(server)), {
    method: "POST",
    redirect: "error",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ access_token: accessToken }),
  })
  if (response.status === 403) {
    throw new Error(
      "Easy Auth accepted the token but refused its client (HTTP 403). The auth app's " +
        "defaultAuthorizationPolicy.allowedApplications must list the client clippy-auth signs in with.",
    )
  }
  if (!response.ok) throw new Error(`Easy Auth session exchange failed (HTTP ${response.status}).`)
  const body = await response.json()
  if (typeof body?.authenticationToken !== "string" || !body.authenticationToken) {
    throw new Error("Easy Auth did not return a session token.")
  }
  return { sessionToken: body.authenticationToken, expiresAt: jwtExpiry(body.authenticationToken) }
}

// Whether Easy Auth lets a request carrying this session through. Any answer other than Easy Auth's
// own 401 means it did: what Clippy then says about the request is Clippy's business.
export async function sessionAccepted(server, sessionToken, fetchImpl = fetch) {
  const response = await fetchImpl(new URL("/api/health", serverOrigin(server)), {
    headers: { [SESSION_HEADER]: sessionToken },
    redirect: "manual",
  })
  return !(response.status === 401 && /authorization_uri=/i.test(response.headers.get("www-authenticate") ?? ""))
}

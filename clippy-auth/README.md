# clippy-auth

Signs a Minicode AgentPool worker in to a Clippy that sits behind Entra sign-in (Azure Container
Apps "Easy Auth"), and saves the Easy Auth session the worker then sends on every request.

It is a separate package so that Minicode itself stays small: the Entra and WAM dependencies live
here, and the worker only reads a file and, when it needs a new session, runs this tool.

Model API authentication is separate and uses Azure CLI through
`minicode auth add --entra-user`; this helper only manages worker Easy Auth sessions.
WAM window parenting is delegated to MSAL without invoking PowerShell or `Add-Type`,
so the helper remains compatible with PowerShell Constrained Language Mode.
If Application Control or another machine policy prevents Node from loading the native WAM
module, the helper falls back to the installed `az` command. It keeps a dedicated Azure CLI cache
per UPN and tenant under Minicode's configuration directory, requests the delegated Easy Auth
scope during sign-in, and validates both the selected account and returned token against `--user`
and the challenged tenant. This cache is separate from the user's normal Azure CLI session.
On Windows, the fallback invokes a native `az.exe` or the Microsoft Azure CLI installer's
bundled Python directly, never `cmd.exe` or a batch wrapper. Unsupported custom batch-only
installations must be replaced with the Microsoft installer.

Entra sign-in and worker sessions require HTTPS, except for HTTP on loopback during local
development. Challenges must name a Microsoft Entra authority in a supported Azure cloud
and a valid application identifier or HTTPS/`api://` resource URI. The token exchange refuses
redirects, so it cannot forward credentials to another origin.

## Quick start

```powershell
# Once per machine
cd clippy-auth
npm install

# Start a worker against an Entra-gated Clippy. It signs in on its own when it can.
cd ..
node .\minicode\cli.js worker --server https://<clippy host> --worker-id <id> `
  --repo-root <source repo> --entra-user alice@contoso.com
```

If the worker cannot sign in silently, it prints the command to run and waits:

```text
Clippy needs an Entra sign-in for alice@contoso.com (signing in needs you). Run this, and the worker continues on its own:
  node .\clippy-auth\cli.js login --server https://<clippy host> --user alice@contoso.com
```

Run this example from the repository root. It reports, for example:

```text
Signed in to https://<clippy host> as alice@contoso.com. Session valid until 11/16/2026, 12:52:45 PM (29 days).
Session saved to C:\Users\alice\AppData\Local\minicode\entra\<clippy host>\alice@contoso.com.json. A worker started with --entra-user alice@contoso.com picks it up on its own.
```

The worker notices the new session within a few seconds and carries on.

## Commands

```powershell
node cli.js login  --server <origin> [--user <upn>] [--silent] [--client-id <id>] [--scope <scope>]
node cli.js status --server <origin> [--user <upn>]
node cli.js logout --server <origin> [--user <upn>]
node cli.js ado-login --organization https://dev.azure.com/<org> --user <upn>
node cli.js ado-token --organization https://dev.azure.com/<org> --user <upn> --silent
```

- `login` signs in through WAM, the Windows account broker. It is silent when the broker already has
  a usable account, and shows the WAM account picker otherwise. `--user` picks the account, which
  does not have to be the Windows login; with it, `login` refuses to save a session for any other
  account, since the worker would never look that one up. `--silent` never shows UI.
  Device-code sign-in is not offered: Conditional Access blocks it in the Microsoft tenant.
- `status` shows the saved session and whether Easy Auth still accepts it.
- `logout` deletes the saved session.
- `ado-login` explicitly signs in to Azure DevOps through MSAL/WAM. It prints only
  identity and expiration, never the access token. It does not create an Easy Auth
  session or save token JSON.
- `ado-token` returns private JSON (`accessToken`, `expiresAt`, `user`, `tenantId`)
  for a harness subprocess pipe, **not model tools, shell history, inventory, or
  logs**. Workers always pass `--silent`; interaction-required failures use exit
  code 2 and require an operator to run `ado-login`.

Azure DevOps authentication discovers the organization's tenant from the
`X-VSS-ResourceTenant` header on a non-redirecting connection-data request, then
uses MSAL/WAM for the Azure DevOps scope
`499b84ac-1321-427f-aa17-267ca6975798/.default`. The selected account and tenant
must match the result. Token expiry comes from MSAL, not decoded token claims.
WAM owns its secure cache; the worker keeps access tokens only in memory and
requests another before expiry. Unlike Easy Auth login, these ADO commands do
not fall back to Azure CLI. Consent, Conditional Access and Azure DevOps
repository permissions still apply; there is no automatic login or identity switch.
Git push authentication is separate and continues to use Git's existing credentials.

| Exit code | Meaning |
|---|---|
| 0 | Done (`status`: the session is accepted) |
| 1 | Failed, or `status` found no usable session |
| 2 | `login --silent` needs the user: run `login` without `--silent` |

## Why the worker needs this

A browser and a worker reach Clippy through the same front door: Azure Front Door, then the Container
App's Easy Auth, then Clippy. Easy Auth turns away any request without an Entra session.

- A **browser** signs in once. Easy Auth redirects it to Entra with Easy Auth's own app registration,
  receives an ID token at `/.auth/login/aad/callback`, and sets its session cookie
  (`AppServiceAuthSession`). Every later request carries that cookie. The browser never sends an
  Entra token itself, which leaves its other headers to Clippy.
- A **worker** has no cookie jar or login page. Before this, its requests reached Easy Auth with only
  Clippy's own bearer token, and Easy Auth answered 401. The worker's WebSocket and pairing were let
  through by excluding their paths from Easy Auth; the agent's own API calls -- posting results back --
  were not, which is how a task could do its work and still fail to report it.

The agent calls Clippy itself, from shell commands and the runtime tool URLs it is given, with
`PAPERCLIP_API_URL` and `PAPERCLIP_API_KEY`. It cannot answer an Entra challenge and should never
hold a user's Entra credentials, so the worker carries the session for it.

## How sign-in works

1. **Challenge.** An unauthenticated `GET /api/health` returns Easy Auth's 401:
   `WWW-Authenticate: Bearer realm="…" authorization_uri="https://login.microsoftonline.com/<tenant>/oauth2/v2.0/authorize" resource_id="<auth app id>"`.
   The tenant and the audience come from here, so neither is configured anywhere.
2. **Entra token through WAM**, for scope `<resource_id>/user_impersonation`, with the public client
   `1950a258-227b-4e31-a9cf-717495945fc2` (Microsoft Azure PowerShell). The broker keeps the refresh
   token; after the first sign-in, later ones are silent. The WAM prompt, when there is one, is
   parented to the console's root window, or to the foreground window when there is no console.
3. **Exchange** at `POST /.auth/login/aad` with `{"access_token": "<entra token>"}`. Easy Auth returns
   `{"authenticationToken": "…"}`, a session token valid for 30 days, and sets no cookie.
4. **Save** it to the session file below, after checking Easy Auth accepts it.

From then on the worker sends `X-ZUMO-AUTH: <session>` on every request and keeps `Authorization` for
Clippy's own token. Easy Auth passes `Authorization` through untouched when the session header is
present.

### Tokens: browser and worker

| | Browser | Worker |
|---|---|---|
| Signs in with | Easy Auth's own registration | WAM, client `1950a258…` (Azure PowerShell) |
| Token | ID token | Access token, scope `user_impersonation` |
| `aud`: who it is for | the auth app | the auth app |
| `appid`: who asked for it | the auth app | `1950a258…` |
| Then carried as | session cookie | `X-ZUMO-AUTH` session token |

The audience is what controls who reaches Clippy, whichever client asked for the token.

### Observed authentication behavior

| Request to Clippy through Front Door | Result |
|---|---|
| No credentials | 401 from Easy Auth |
| `Authorization: Bearer <entra>` | Passes Easy Auth; Clippy then rejects it as an agent token. Both layers want `Authorization`. |
| `POST /.auth/login/aad {access_token}` | 200, `authenticationToken` issued, valid 720 h |
| `X-ZUMO-AUTH` only | 200 from Clippy |
| `X-ZUMO-AUTH` + `Authorization: Bearer <clippy token>` | Reaches Clippy with `Authorization` unchanged |
| Entra token from client `1950a258…` before Easy Auth allowed that client | 403 from Easy Auth |
| `clippy-auth login --silent` with the broker already signed in | Done in about 1.5 s |

## The worker side (`minicode worker --entra-user <upn>`)

`--entra-user` turns Entra sign-in on and names the account; there is no separate switch. It uses
nothing Minicode did not already have: Node's `http`, `https` and `child_process`, and the `ws`
package. The code is in `minicode/server/entra-session.js` and `minicode/server/entra-proxy.js`.

**Getting a session**, at startup and whenever Easy Auth refuses the current one:

1. Read the saved session for `--server` and `--entra-user`. Usable (present, and not within a
   minute of expiring): use it.
2. Otherwise run `clippy-auth login --server … --user … --silent` as a child process. If it has not
   finished within **5 seconds**, it is killed and counts as failed.
3. Exit 0 and a usable saved session: carry on.
4. Any failure -- a timeout, exit 2, exit 1, `clippy-auth` missing or not installed -- prints the
   reason and the interactive `login` command, then waits. Every 5 seconds the worker looks for a
   session newer than the one it had, and continues as soon as one appears. It never opens a sign-in
   prompt itself.

Concurrent callers (the WebSocket, pairing, several proxied agent requests) share one attempt.

**Where the session is sent:**

- **Pairing** (`POST /api/agent-pool/pair`) carries `X-ZUMO-AUTH`. An Easy Auth 401 renews the
  session and retries once.
- **The WebSocket** (`/api/agent-pool/worker`) carries `X-ZUMO-AUTH` on every connect. An Easy Auth
  401 renews the session and reconnects; any other failure stops the worker as before.
- **The agent's own calls** go through a loopback proxy. It listens on `127.0.0.1:<random port>`
  under a random 32-hex path prefix, and `PAPERCLIP_API_URL` and the runtime tool URLs (MCP,
  connections) point at it. Each request is buffered (up to 32 MB), sent on to the server with
  `X-ZUMO-AUTH` added and every other header -- the agent's `Authorization` included -- unchanged,
  and the response is streamed back. An Easy Auth 401 renews the session and sends the request once
  more. Requests outside the prefix get 404, so another local process cannot borrow the session
  through the port. Forwarding is pinned to the configured server origin:
  network-path references (`//host/...`) and backslash paths are rejected with
  400 before any session is read or credentials are forwarded. The proxy closes
  when the worker stops.

**Without `--entra-user`**, the worker probes `/api/health` once at startup. If Easy Auth answers with
its challenge, it stops with "start the worker with --entra-user <upn>" instead of connecting and then
being unable to post any result back. Against a Clippy without Entra, nothing changes.

`clippy-auth` is found at `<minicode repo>/clippy-auth/cli.js` and run with the worker's own Node,
unless `--clippy-auth <path to cli.js>` says otherwise.

## Server prerequisites

Set once per environment, on the Entra app configured for Easy Auth:

- **Pre-authorize the worker client.** *Expose an API → Add a client application*: client
  `1950a258-227b-4e31-a9cf-717495945fc2`, scope `user_impersonation`. Without it WAM fails with
  `AADSTS650057` (or a consent prompt), since that client's own registration lists no permissions for
  the app. Requesting `/.default` fails the same way, which is why clippy-auth names the scope.
- **Let Easy Auth accept the authentication clients.** `defaultAuthorizationPolicy.allowedApplications`
  must list the WAM client `1950a258-227b-4e31-a9cf-717495945fc2` and, when the Azure CLI fallback
  is used, the Microsoft Azure CLI client `04b07795-8ddb-461a-bbee-02f9e1bf7b46`, alongside the app
  itself. An empty list means the app alone, and Easy Auth answers the worker's token with an empty
  403. Configure these allowed client applications through the deployment's Easy Auth settings.

## Session file

The contract between clippy-auth and the worker:

- **Location:** `<minicode config dir>/entra/<clippy host>/<user>.json`. The config dir is Minicode's
  own (`MINICODE_CONFIG_HOME`, else `XDG_CONFIG_HOME/minicode`, else `%LOCALAPPDATA%\minicode` on
  Windows, else `~/.config/minicode`). The user part is lower-cased; characters outside
  `a-z 0-9 @ . _ -` become `_`.
- **Without a user** (`clippy-auth` without `--user`), the newest session saved for that host is used.
- **Content:**

```json
{
  "version": 1,
  "server": "https://<clippy host>",
  "user": "alice@contoso.com",
  "clientId": "1950a258-227b-4e31-a9cf-717495945fc2",
  "resource": "<auth app id>",
  "sessionToken": "<Easy Auth authenticationToken>",
  "expiresAt": "2026-11-16T19:52:45.000Z",
  "createdAt": "2026-10-17T19:52:45.197Z"
}
```

A file with any other `version` is ignored. Written to a temporary file and renamed into place, so
the worker never reads half a file.

## Trade-offs

- **A session, not a refresh token, is saved.** With WAM the refresh token stays in the Windows
  broker and is never handed to the app. The worker does not need one anyway: Easy Auth only needs
  the session, which lasts 30 days, so renewals are rare.
- **The session file is a credential.** Whoever has it gets past Easy Auth for up to 30 days. It does
  not get past Clippy, which still needs its own token for everything. It sits in the per-user
  config directory, like Minicode's pairing files, and is written owner-only where the platform
  honours file modes. Encrypting it at rest (DPAPI) would have to live here, and would make the
  worker call this tool on every read rather than only on renewal.
- **Renewal is a process launch, not a library call.** That is the price of keeping MSAL out of
  Minicode. With a 30-day session it happens about monthly, and the silent path takes a second or two.
- **A 5-second limit on the silent attempt.** It keeps a hung broker from stalling the worker, and is
  well above the 1.5 s a silent sign-in takes. A slow first sign-in on a cold machine can hit it; the
  fallback is the printed command, so nothing is lost but a manual step.
- **The worker waits rather than prompting.** A background worker has no window of its own to parent
  a WAM prompt to, and a prompt that appears from nowhere is easy to miss or mistrust. Printing the
  command keeps the user in control of when and where they sign in; the worker picks the result up.
- **A first-party client instead of our own registration.** Azure PowerShell's client already has a
  WAM redirect, and pre-authorizing it on our app needs no admin consent, which a new registration of
  our own would. The cost: any tool on the machine that signs in with that client can request the
  same scope. The audience still limits what the token is good for, and Easy Auth still decides who
  reaches Clippy.
- **`X-ZUMO-AUTH` rather than `Authorization` for Entra.** Putting the Entra token in `Authorization`
  would collide with Clippy's agent token and need Clippy to read its token from another header.
  The session header needs no Clippy change.
- **The proxy buffers request bodies** so a request can be sent again after a renewal. Agent API
  bodies are small; anything over 32 MB is refused with 413. Responses are streamed.
- **Windows only.** WAM is Windows' broker. Other platforms would need another sign-in path, which
  this tool does not have yet.
- **Implementation note:** MSAL's native broker keeps a handle open after it returns, so the CLI
  exits explicitly when it is done.

## Follow-ups

- **Remove the Easy Auth `excludedPaths`** for `/api/agent-pool/pair` and `/api/agent-pool/worker`
  once every worker runs with `--entra-user`. Nothing is then reachable without Entra.
- **Worker ownership.** Easy Auth passes the signed-in user to Clippy (`X-MS-CLIENT-PRINCIPAL-NAME`).
  Clippy could record it on each worker, or only let a worker connect as the user who paired it.
- **Worker exit bug.** The worker exits when a single task execution is rejected ("AgentPool execution
  or credentials rejected"), when it should report the failure and stay connected.
- **Changing app registrations.** When moving Easy Auth to another app registration,
  repeat the prerequisites above and obtain any required administrator consent.

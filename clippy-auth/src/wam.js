// Entra sign-in through the Windows broker (WAM). The only module that loads MSAL, so everything
// else -- and the worker's silent renewal path when an account is already known -- stays light.

// --silent's outcome when signing in needs the user: the CLI turns it into its own exit code, which
// is how the worker tells "ask the user" from "something is broken".
export class InteractionRequiredError extends Error {
  code = "interaction_required"
}

async function loadLibraries() {
  const [msal, extensions] = await Promise.all([
    import("@azure/msal-node"), import("@azure/msal-node-extensions"),
  ])
  return { msal, extensions }
}

export async function createBrokerApplication({ authority, clientId }, load = loadLibraries) {
  const { msal, extensions } = await load()
  const { PublicClientApplication, InteractionRequiredAuthError } = msal
  const { NativeBrokerPlugin } = extensions
  const broker = new NativeBrokerPlugin()
  if (!broker.isBrokerAvailable) throw new Error("WAM native broker is unavailable. Worker sign-in requires a working Windows broker.")
  return {
    app: new PublicClientApplication({
      auth: { clientId, authority },
      broker: { nativeBrokerPlugin: broker },
    }),
    InteractionRequiredAuthError,
  }
}

export async function acquireToken({ authority, clientId, scopes, user, silentOnly }, createApplication = createBrokerApplication) {
  if (process.platform !== "win32") throw new Error("clippy-auth signs in through WAM, which is Windows-only.")
  const { app, InteractionRequiredAuthError } = await createApplication({ authority, clientId })

  // The broker remembers accounts across processes, so after the first sign-in this is silent.
  const accounts = await app.getAllAccounts()
  const account = user
    ? accounts.find((candidate) => candidate.username?.toLowerCase() === user.toLowerCase())
    : accounts[0]
  if (account) {
    try {
      return await app.acquireTokenSilent({ scopes, account })
    } catch (error) {
      if (!(error instanceof InteractionRequiredAuthError)) throw error
    }
  }
  if (silentOnly) {
    throw new InteractionRequiredError(`Signing in${user ? ` as ${user}` : ""} needs you. Run: clippy-auth login`)
  }
  return app.acquireTokenInteractive({
    scopes,
    loginHint: user || undefined,
    prompt: user ? undefined : "select_account",
    // Let MSAL discover the CLI window without PowerShell Add-Type.
    openBrowser: async () => {
      throw new Error("WAM should handle sign-in without a browser.")
    },
  })
}

// Entra sign-in through the Windows broker (WAM). The only module that loads MSAL, so everything
// else -- and the worker's silent renewal path when an account is already known -- stays light.
import { execFile } from "node:child_process"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)

// --silent's outcome when signing in needs the user: the CLI turns it into its own exit code, which
// is how the worker tells "ask the user" from "something is broken".
export class InteractionRequiredError extends Error {
  code = "interaction_required"
}

// WAM parents its window to the caller's. A console's own window is hidden under Windows Terminal,
// so ask for its root owner, and fall back to the foreground window when there is no console at
// all (a background process), which is the case where a WAM prompt would otherwise never show.
const WINDOW_HANDLE_SCRIPT = `
Add-Type -Namespace ClippyAuth -Name Win -MemberDefinition '
[DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow();
[DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();'
$h = [ClippyAuth.Win]::GetConsoleWindow()
if ($h -ne [IntPtr]::Zero) { $h = [ClippyAuth.Win]::GetAncestor($h, 3) }
if ($h -eq [IntPtr]::Zero) { $h = [ClippyAuth.Win]::GetForegroundWindow() }
$h.ToInt64()`

export async function parentWindowHandle() {
  const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", WINDOW_HANDLE_SCRIPT])
  const handle = Buffer.alloc(8)
  handle.writeBigInt64LE(BigInt(stdout.trim() || "0"))
  return handle
}

export async function acquireToken({ authority, clientId, scopes, user, silentOnly }) {
  if (process.platform !== "win32") throw new Error("clippy-auth signs in through WAM, which is Windows-only.")
  const { PublicClientApplication, InteractionRequiredAuthError } = await import("@azure/msal-node")
  const { NativeBrokerPlugin } = await import("@azure/msal-node-extensions")
  const app = new PublicClientApplication({
    auth: { clientId, authority },
    broker: { nativeBrokerPlugin: new NativeBrokerPlugin() },
  })

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
    windowHandle: await parentWindowHandle(),
    openBrowser: async () => {
      throw new Error("WAM should handle sign-in without a browser.")
    },
  })
}

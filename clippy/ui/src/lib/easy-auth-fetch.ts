import { getPageVisibilitySnapshot, subscribePageVisibility } from "./page-visibility";

const REFRESH_TIMEOUT_MS = 15_000;
const FAILURE_COOLDOWN_MS = 30_000;
// With preserveUrlFragmentsForLogins, Easy Auth answers unauthenticated
// requests with HTTP 200 and a script page that redirects to the sign-in URL.
const LOGIN_PAGE_MARKER = /\/\.auth\/login\/|\.auth%2Flogin%2F|<title>\s*Redirecting to login page/i;

async function isEasyAuthLoginPage(response: Response): Promise<boolean> {
  if (!response.headers.get("content-type")?.toLowerCase().includes("text/html")) return false;
  try {
    return LOGIN_PAGE_MARKER.test(await response.clone().text());
  } catch {
    return false;
  }
}

function signInRequired(): Response {
  return Response.json({ error: "Sign-in required" }, { status: 401 });
}

function waitForRefresh(promise: Promise<boolean>, signal: AbortSignal): Promise<boolean> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

export function createEasyAuthFetchRecovery({
  fetch: rawFetch,
  origin,
  isEnabled,
}: {
  fetch: typeof fetch;
  origin: string;
  isEnabled: () => boolean;
}) {
  let refreshing: Promise<boolean> | null = null;
  let generation = 0;
  let retryAfter = 0;
  let needsSignIn = false;
  const listeners = new Set<() => void>();

  function setNeedsSignIn(value: boolean) {
    if (needsSignIn === value) return;
    needsSignIn = value;
    for (const listener of listeners) listener();
  }

  async function refresh(): Promise<boolean> {
    if (refreshing) return refreshing;
    if (Date.now() < retryAfter) return false;
    refreshing = (async () => {
      try {
        // Use the native fetch: refreshing must never trigger its own recovery.
        const response = await rawFetch(`${origin}/.auth/refresh`, {
          credentials: "include",
          cache: "no-store",
          redirect: "error",
          signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
        });
        if (!response.ok || response.redirected || response.headers.get("content-type")?.includes("text/html")) {
          throw new Error(`Easy Auth session refresh failed (${response.status})`);
        }
        generation++;
        retryAfter = 0;
        setNeedsSignIn(false);
        return true;
      } catch (error) {
        retryAfter = Date.now() + FAILURE_COOLDOWN_MS;
        setNeedsSignIn(true);
        console.warn("[auth] Easy Auth session refresh failed. Sign in again.", error);
        return false;
      } finally {
        refreshing = null;
      }
    })();
    return refreshing;
  }

  const fetchWithRecovery: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input), origin);
    // Cover direct fetch callers as well as API clients, but never external
    // services, sign-in submissions, sign-out, or the Easy Auth endpoints.
    if (
      url.origin !== origin || !url.pathname.startsWith("/api/")
      || (url.pathname.startsWith("/api/auth/") && !/^\/api\/auth\/(?:get-session|profile)\/?$/.test(url.pathname))
    ) return rawFetch(input, init);

    const request = new Request(input instanceof Request ? input : url, init);
    if (request.headers.has("authorization") || request.credentials === "omit") return rawFetch(input, init);
    const startedGeneration = generation;
    // Retain an unconsumed request so JSON, multipart, and binary bodies can
    // be replayed once if Easy Auth rejects them before application handling.
    const response = await rawFetch(request.clone());
    const loginPage = await isEasyAuthLoginPage(response);
    if (response.status !== 401 && !loginPage) {
      if (response.ok && !response.redirected && /^\/api\/auth\/get-session\/?$/.test(url.pathname)
        && response.headers.get("content-type")?.includes("application/json")) {
        retryAfter = 0;
        setNeedsSignIn(false);
      }
      return response;
    }
    const challenge = response.headers.get("www-authenticate") ?? "";
    const isEasyAuthChallenge = /authorization_uri="https:\/\/login\.microsoftonline\.com\//i.test(challenge);
    // Application JSON errors (including local/Cloud auth and rejected
    // credentials) are not evidence that the gateway rejected this request.
    const isApplicationError = /(?:\/|\+)json(?:;|$)/i.test(response.headers.get("content-type") ?? "");
    if (!loginPage && !isEasyAuthChallenge && (!isEnabled() || isApplicationError)) return response;

    const recovered = generation !== startedGeneration || await waitForRefresh(refresh(), request.signal);
    request.signal.throwIfAborted();
    // Callers expect API responses, never the gateway's sign-in page.
    if (!recovered) return loginPage ? signInRequired() : response;
    const retried = await rawFetch(request);
    const retriedLoginPage = await isEasyAuthLoginPage(retried);
    if (retried.status === 401 || retriedLoginPage) {
      retryAfter = Date.now() + FAILURE_COOLDOWN_MS;
      setNeedsSignIn(true);
    }
    return retriedLoginPage ? signInRequired() : retried;
  };

  return {
    fetch: fetchWithRecovery,
    getSnapshot: () => needsSignIn,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}

export type EasyAuthFetchRecovery = ReturnType<typeof createEasyAuthFetchRecovery>;

export function startEasyAuthSessionChecks(recovery: EasyAuthFetchRecovery, isEnabled: () => boolean) {
  let wasVisible = getPageVisibilitySnapshot().visible;
  let checking = false;
  return subscribePageVisibility(() => {
    const visible = getPageVisibilitySnapshot().visible;
    const restored = !wasVisible && visible;
    wasVisible = visible;
    if (!restored || !isEnabled() || checking) return;
    checking = true;
    void recovery.fetch("/api/auth/get-session", {
      credentials: "include",
      cache: "no-store",
      headers: { Accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
    }).then((response) => {
      if (!response.ok) console.warn("[auth] Easy Auth session check failed.", { status: response.status });
    }).catch((error: unknown) => {
      console.warn("[auth] Easy Auth session check failed.", error);
    }).finally(() => {
      checking = false;
    });
  });
}

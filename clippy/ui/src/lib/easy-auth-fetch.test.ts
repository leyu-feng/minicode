import { afterEach, describe, expect, it, vi } from "vitest";
import { createEasyAuthFetchRecovery, startEasyAuthSessionChecks } from "./easy-auth-fetch";
import * as pageVisibility from "./page-visibility";

const ORIGIN = "https://clippy.example.com";
const CHALLENGE = 'Bearer authorization_uri="https://login.microsoftonline.com/tenant/oauth2/v2.0/authorize"';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("Easy Auth fetch recovery", () => {
  it("refreshes the cookie and retries a gateway-rejected request once", async () => {
    const rejected = new Response(null, { status: 401 });
    const success = new Response('{"ok":true}');
    const rawFetch = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(rejected)
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(success);
    const recovery = createEasyAuthFetchRecovery({ fetch: rawFetch, origin: ORIGIN, isEnabled: () => true });

    expect(await recovery.fetch("/api/health", { credentials: "include" })).toBe(success);
    expect(rawFetch).toHaveBeenCalledTimes(3);
    expect(rawFetch.mock.calls[1]).toEqual([
      `${ORIGIN}/.auth/refresh`,
      expect.objectContaining({ credentials: "include", cache: "no-store", redirect: "error", signal: expect.any(AbortSignal) }),
    ]);
    const retry = rawFetch.mock.calls[2][0] as Request;
    expect(retry.url).toBe(`${ORIGIN}/api/health`);
    expect(retry.credentials).toBe("include");
    expect(recovery.getSnapshot()).toBe(false);
  });

  it.each(["json", "multipart", "binary"] as const)("preserves %s mutation bodies, headers, and request options", async (kind) => {
    const seen: Array<{ body: string; type: string | null }> = [];
    const rawFetch = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      if (String(input) === `${ORIGIN}/.auth/refresh`) return new Response(null);
      const request = input as Request;
      seen.push({ body: await request.text(), type: request.headers.get("content-type") });
      expect(request.method).toBe("POST");
      expect(request.headers.get("x-custom")).toBe("preserved");
      expect(request.credentials).toBe("include");
      expect(request.cache).toBe("no-store");
      return new Response(null, { status: seen.length === 1 ? 401 : 200 });
    });
    const form = new FormData();
    form.append("description", "some text");
    const body = kind === "json" ? '{"message":"hello"}' : kind === "multipart" ? form : new Blob(["binary body"]);
    const request = new Request(`${ORIGIN}/api/upload`, {
      method: "POST", credentials: "include", cache: "no-store",
      headers: { "x-custom": "preserved", ...(kind === "json" ? { "content-type": "application/json" } : {}) },
      body,
    });
    const recovery = createEasyAuthFetchRecovery({ fetch: rawFetch, origin: ORIGIN, isEnabled: () => true });

    expect((await recovery.fetch(request)).status).toBe(200);
    expect(seen).toHaveLength(2);
    expect(seen[1]).toEqual(seen[0]);
    expect(seen[0].body).toContain(kind === "json" ? "hello" : kind === "multipart" ? "some text" : "binary body");
  });

  it("shares a refresh across concurrent and late-arriving 401 responses", async () => {
    const refreshResponse = deferred<Response>();
    const lateResponse = deferred<Response>();
    const counts = new Map<string, number>();
    const rawFetch = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      if (String(input) === `${ORIGIN}/.auth/refresh`) return refreshResponse.promise;
      const path = (input as Request).url;
      const count = (counts.get(path) ?? 0) + 1;
      counts.set(path, count);
      if (path.endsWith("/late") && count === 1) return lateResponse.promise;
      return new Response(null, { status: count === 1 ? 401 : 200 });
    });
    const recovery = createEasyAuthFetchRecovery({ fetch: rawFetch, origin: ORIGIN, isEnabled: () => true });
    const first = recovery.fetch("/api/first");
    const second = recovery.fetch("/api/second");
    const late = recovery.fetch("/api/late");
    await vi.waitFor(() => expect(rawFetch.mock.calls.filter(([url]) => url === `${ORIGIN}/.auth/refresh`)).toHaveLength(1));
    refreshResponse.resolve(new Response(null));
    expect((await first).status).toBe(200);
    expect((await second).status).toBe(200);
    lateResponse.resolve(new Response(null, { status: 401 }));
    expect((await late).status).toBe(200);
    expect(rawFetch.mock.calls.filter(([url]) => url === `${ORIGIN}/.auth/refresh`)).toHaveLength(1);
  });

  it.each([401, 403, 404, 500, "html", "network"] as const)(
    "preserves the original 401 and surfaces refresh failure (%s) without a retry storm",
    async (failure) => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const original = new Response(null, { status: 401 });
      const rawFetch = vi.fn<typeof fetch>().mockImplementation(async (input) => {
        if (String(input) !== `${ORIGIN}/.auth/refresh`) return original;
        if (failure === "network") throw new TypeError("Failed to fetch");
        return failure === "html"
          ? new Response("<html>sign in</html>", { headers: { "content-type": "text/html" } })
          : new Response(null, { status: failure });
      });
      const recovery = createEasyAuthFetchRecovery({ fetch: rawFetch, origin: ORIGIN, isEnabled: () => true });
      const listener = vi.fn();
      const unsubscribe = recovery.subscribe(listener);

      expect(await recovery.fetch("/api/first")).toBe(original);
      expect(await recovery.fetch("/api/second")).toBe(original);
      expect(rawFetch.mock.calls.filter(([url]) => url === `${ORIGIN}/.auth/refresh`)).toHaveLength(1);
      expect(recovery.getSnapshot()).toBe(true);
      expect(listener).toHaveBeenCalledOnce();
      expect(console.warn).toHaveBeenCalledOnce();
      unsubscribe();
    },
  );

  it("does not refresh again when the one retried request is still unauthorized", async () => {
    const rawFetch = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(new Response(null))
      .mockResolvedValueOnce(new Response(null, { status: 401 }));
    const recovery = createEasyAuthFetchRecovery({ fetch: rawFetch, origin: ORIGIN, isEnabled: () => true });
    expect((await recovery.fetch("/api/tasks")).status).toBe(401);
    expect(rawFetch).toHaveBeenCalledTimes(3);
    expect(recovery.getSnapshot()).toBe(true);
  });

  it("keeps refresh independent of a caller abort and never replays that caller's request", async () => {
    const refreshResponse = deferred<Response>();
    const counts = new Map<string, number>();
    const rawFetch = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      if (String(input) === `${ORIGIN}/.auth/refresh`) return refreshResponse.promise;
      const path = (input as Request).url;
      const count = (counts.get(path) ?? 0) + 1;
      counts.set(path, count);
      return new Response(null, { status: count === 1 ? 401 : 200 });
    });
    const recovery = createEasyAuthFetchRecovery({ fetch: rawFetch, origin: ORIGIN, isEnabled: () => true });
    const controller = new AbortController();
    const request = recovery.fetch("/api/tasks", { signal: controller.signal });
    const other = recovery.fetch("/api/other");
    const rejected = expect(request).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(rawFetch).toHaveBeenCalledTimes(3));
    controller.abort();
    await rejected;
    refreshResponse.resolve(new Response(null));
    expect((await other).status).toBe(200);
    expect(counts.get(`${ORIGIN}/api/tasks`)).toBe(1);
    expect(rawFetch).toHaveBeenCalledTimes(4);
  });

  it("can renew again after a failed refresh's cooldown", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    let working = false;
    let authenticated = false;
    const rawFetch = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      if (String(input) === `${ORIGIN}/.auth/refresh`) {
        authenticated = working;
        return new Response(null, { status: working ? 200 : 401 });
      }
      return new Response(null, { status: authenticated ? 200 : 401 });
    });
    const recovery = createEasyAuthFetchRecovery({ fetch: rawFetch, origin: ORIGIN, isEnabled: () => true });
    expect((await recovery.fetch("/api/tasks")).status).toBe(401);
    expect((await recovery.fetch("/api/tasks")).status).toBe(401);
    expect(rawFetch).toHaveBeenCalledTimes(3);
    expect(recovery.getSnapshot()).toBe(true);

    working = true;
    vi.advanceTimersByTime(30_001);
    expect((await recovery.fetch("/api/tasks")).status).toBe(200);
    expect(rawFetch).toHaveBeenCalledTimes(6);
    expect(recovery.getSnapshot()).toBe(false);
  });

  it("returns the original failure when the bounded refresh times out", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const timeout = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeout.signal);
    const original = new Response(null, { status: 401 });
    const rawFetch = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
      if (String(input) !== `${ORIGIN}/.auth/refresh`) return original;
      return new Promise<Response>((_, reject) => {
        init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true });
      });
    });
    const recovery = createEasyAuthFetchRecovery({ fetch: rawFetch, origin: ORIGIN, isEnabled: () => true });
    const request = recovery.fetch("/api/tasks");
    await vi.waitFor(() => expect(rawFetch).toHaveBeenCalledTimes(2));
    timeout.abort(new DOMException("Refresh timeout", "TimeoutError"));
    expect(await request).toBe(original);
    expect(recovery.getSnapshot()).toBe(true);
    expect(rawFetch).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["https://other.example.com/api/tasks", {}, true, 401, null],
    ["/.auth/refresh", {}, true, 401, null],
    ["/api/auth/sign-in/email", { method: "POST", body: "{}" }, true, 401, null],
    ["/api/auth/sign-out", { method: "POST", body: "{}" }, true, 401, null],
    ["/api/tasks", { headers: { authorization: "Bearer agent-token" } }, true, 401, null],
    ["/api/tasks", { credentials: "omit" }, true, 401, null],
    ["/api/tasks", {}, false, 401, null],
    ["/api/tasks", {}, true, 403, null],
    ["/api/tasks", {}, true, 401, "application/json"],
    ["/api/tasks", {}, true, 401, "application/problem+json"],
  ] as const)("does not recover unrelated requests or application errors (%s, %j)", async (url, init, enabled, status, contentType) => {
    const original = new Response(null, { status, headers: contentType ? { "content-type": contentType } : {} });
    const rawFetch = vi.fn<typeof fetch>().mockResolvedValue(original);
    const recovery = createEasyAuthFetchRecovery({ fetch: rawFetch, origin: ORIGIN, isEnabled: () => enabled });

    expect(await recovery.fetch(url, init)).toBe(original);
    expect(rawFetch).toHaveBeenCalledOnce();
    expect(recovery.getSnapshot()).toBe(false);
  });

  it("can recover an explicit gateway challenge before health metadata has loaded", async () => {
    const rawFetch = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 401, headers: { "www-authenticate": CHALLENGE } }))
      .mockResolvedValueOnce(new Response(null))
      .mockResolvedValueOnce(new Response(null));
    const recovery = createEasyAuthFetchRecovery({ fetch: rawFetch, origin: ORIGIN, isEnabled: () => false });
    expect((await recovery.fetch("/api/health")).status).toBe(200);
    expect(rawFetch).toHaveBeenCalledTimes(3);
  });

  it("does not replay ambiguous network failures", async () => {
    const error = new TypeError("Failed to fetch");
    const rawFetch = vi.fn<typeof fetch>().mockRejectedValue(error);
    const recovery = createEasyAuthFetchRecovery({ fetch: rawFetch, origin: ORIGIN, isEnabled: () => true });
    await expect(recovery.fetch("/api/tasks", { method: "POST", body: "{}" })).rejects.toBe(error);
    expect(rawFetch).toHaveBeenCalledOnce();
  });

  it("clears a failed-recovery notice when another tab has restored a working session", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const rawFetch = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(Response.json({ session: { id: "restored" } }));
    const recovery = createEasyAuthFetchRecovery({ fetch: rawFetch, origin: ORIGIN, isEnabled: () => true });
    await recovery.fetch("/api/tasks");
    expect(recovery.getSnapshot()).toBe(true);
    await recovery.fetch("/api/auth/get-session");
    expect(recovery.getSnapshot()).toBe(false);
  });
});

function mockVisibility(initialVisible: boolean) {
  let visible = initialVisible;
  let listener!: () => void;
  const unsubscribe = vi.fn();
  vi.spyOn(pageVisibility, "getPageVisibilitySnapshot").mockImplementation(() => ({ visible, focused: visible }));
  vi.spyOn(pageVisibility, "subscribePageVisibility").mockImplementation((callback) => {
    listener = callback;
    return unsubscribe;
  });
  return {
    unsubscribe,
    setVisible(value: boolean) {
      visible = value;
      listener();
    },
  };
}

describe("Easy Auth session checks on tab restore", () => {
  it.each([true, false])("checks only when a hidden tab becomes visible (initially visible: %s)", async (initialVisible) => {
    const visibility = mockVisibility(initialVisible);
    const rawFetch = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ session: { id: "valid" } }));
    const recovery = createEasyAuthFetchRecovery({ fetch: rawFetch, origin: ORIGIN, isEnabled: () => true });
    const stop = startEasyAuthSessionChecks(recovery, () => true);
    expect(rawFetch).not.toHaveBeenCalled();
    visibility.setVisible(false);
    expect(rawFetch).not.toHaveBeenCalled();
    visibility.setVisible(true);
    visibility.setVisible(true);
    await vi.waitFor(() => expect(rawFetch).toHaveBeenCalledOnce());
    const request = rawFetch.mock.calls[0][0] as Request;
    expect(request.url).toBe(`${ORIGIN}/api/auth/get-session`);
    expect(request.credentials).toBe("include");
    expect(request.cache).toBe("no-store");
    expect(request.redirect).toBe("error");
    stop();
    expect(visibility.unsubscribe).toHaveBeenCalledOnce();
  });

  it("refreshes an expired session through the shared recovery path", async () => {
    const visibility = mockVisibility(false);
    const rawFetch = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(new Response(null))
      .mockResolvedValueOnce(Response.json({ session: { id: "restored" } }));
    const recovery = createEasyAuthFetchRecovery({ fetch: rawFetch, origin: ORIGIN, isEnabled: () => true });
    const stop = startEasyAuthSessionChecks(recovery, () => true);
    visibility.setVisible(true);
    await vi.waitFor(() => expect(rawFetch).toHaveBeenCalledTimes(3));
    expect(rawFetch.mock.calls[1][0]).toBe(`${ORIGIN}/.auth/refresh`);
    expect(recovery.getSnapshot()).toBe(false);
    stop();
  });

  it("does not probe local or Cloud auth, or duplicate an in-flight check on rapid tab switches", async () => {
    const visibility = mockVisibility(false);
    const response = deferred<Response>();
    let enabled = false;
    const rawFetch = vi.fn<typeof fetch>().mockReturnValue(response.promise);
    const recovery = createEasyAuthFetchRecovery({ fetch: rawFetch, origin: ORIGIN, isEnabled: () => enabled });
    const stop = startEasyAuthSessionChecks(recovery, () => enabled);
    visibility.setVisible(true);
    expect(rawFetch).not.toHaveBeenCalled();
    enabled = true;
    visibility.setVisible(false);
    visibility.setVisible(true);
    visibility.setVisible(false);
    visibility.setVisible(true);
    expect(rawFetch).toHaveBeenCalledOnce();
    response.resolve(Response.json({ session: { id: "valid" } }));
    await vi.waitFor(() => expect(recovery.getSnapshot()).toBe(false));
    stop();
  });

  it("logs network failures without treating them as proof that sign-in expired", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const visibility = mockVisibility(false);
    const error = new TypeError("Offline");
    const rawFetch = vi.fn<typeof fetch>().mockRejectedValue(error);
    const recovery = createEasyAuthFetchRecovery({ fetch: rawFetch, origin: ORIGIN, isEnabled: () => true });
    const stop = startEasyAuthSessionChecks(recovery, () => true);
    visibility.setVisible(true);
    await vi.waitFor(() => expect(console.warn).toHaveBeenCalledWith("[auth] Easy Auth session check failed.", error));
    expect(rawFetch).toHaveBeenCalledOnce();
    expect(recovery.getSnapshot()).toBe(false);
    stop();
  });
});

// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { agentPoolsApi } from "../api/agent-pools";
import { AgentGitHubLogin } from "./AgentGitHubLogin";

let root: Root;
let container: HTMLDivElement;
let client: QueryClient;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  client.clear();
  vi.restoreAllMocks();
});
async function render(agentId?: string) {
  await act(async () => root.render(<QueryClientProvider client={client}>
    <AgentGitHubLogin companyId="company" agentId={agentId} />
  </QueryClientProvider>));
}
it("requires saving the agent before requesting any device code", async () => {
  const poll = vi.spyOn(agentPoolsApi, "pollGitHubLogin");
  await render();
  expect(container.textContent).toContain("Save the agent");
  expect(poll).not.toHaveBeenCalled();
});
it("starts the device flow for this agent and displays only its trusted GitHub challenge", async () => {
  vi.spyOn(agentPoolsApi, "pollGitHubLogin").mockResolvedValue({ state: "required", message: "Sign-in required" });
  const start = vi.spyOn(agentPoolsApi, "startGitHubLogin").mockResolvedValue({
    state: "pending", message: "Waiting for GitHub", userCode: "ABCD-1234",
    verificationUri: "https://github.com/login/device", pollAfterSeconds: 30,
  });
  await render("agent");
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
  const button = container.querySelector("button");
  expect(button).not.toBeNull();
  await act(async () => button!.click());
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
  expect(start).toHaveBeenCalledWith("company", "agent");
  expect(container.textContent).toContain("ABCD-1234");
  expect(container.querySelector("a")?.href).toBe("https://github.com/login/device");
  expect(container.querySelector("button")).toBeNull();
});
it("shows storage and authorization errors without claiming login success", async () => {
  vi.spyOn(agentPoolsApi, "pollGitHubLogin").mockRejectedValue(new Error("Credential vault unavailable"));
  await render("agent");
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
  expect(container.querySelector("[role=alert]")?.textContent).toBe("Credential vault unavailable");
  expect(container.textContent).not.toContain("complete.");
});

it.each(["connected", "expired"] as const)("shows verified sign-in details and reauthorization for %s credentials", async state => {
  vi.spyOn(agentPoolsApi, "pollGitHubLogin").mockResolvedValue({
    state, message: state === "connected" ? "GitHub sign-in is complete." : "GitHub sign-in expired. Sign in again.",
    account: { id: 12345, login: "agent-user" }, signedInAt: "2026-11-02T18:00:00.000Z",
    expiresAt: "2026-11-03T02:00:00.000Z", refreshExpiresAt: "2027-05-01T18:00:00.000Z",
  });
  await render("agent");
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
  expect(container.textContent).toContain("@agent-user");
  expect(container.querySelector('time[datetime="2026-11-02T18:00:00.000Z"]')).not.toBeNull();
  expect(container.querySelector('time[datetime="2027-05-01T18:00:00.000Z"]')).not.toBeNull();
  expect(container.querySelector('time[datetime="2026-11-03T02:00:00.000Z"]')).toBeNull();
  expect(container.textContent).toContain("Access tokens refresh automatically");
  expect(container.textContent).toContain("Sign in again if the refresh token expires");
  expect(container.querySelector("button")?.textContent).toBe("Sign in again");
});

it("labels an older sign-in timestamp as unrecorded rather than displaying token expiry as the sign-in time", async () => {
  vi.spyOn(agentPoolsApi, "pollGitHubLogin").mockResolvedValue({
    state: "connected", message: "GitHub sign-in is complete.", account: { id: 12345, login: "agent-user" },
    expiresAt: "2026-11-03T02:00:00.000Z", refreshExpiresAt: "2027-05-01T18:00:00.000Z",
  });
  await render("agent");
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
  expect(container.textContent).toContain("Signed inNot recorded for this sign-in");
  expect(container.querySelectorAll("time")).toHaveLength(1);
});

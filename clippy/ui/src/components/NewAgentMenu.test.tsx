// @vitest-environment jsdom
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { api } from "../api/client";
import { NewAgentMenu } from "./NewAgentMenu";

const { navigate, customized } = vi.hoisted(() => ({ navigate: vi.fn(), customized: vi.fn() }));
vi.mock("@/lib/router", () => ({ useNavigate: () => navigate }));
vi.mock("../api/client", () => ({ api: { get: vi.fn(), post: vi.fn() } }));

let root: Root;
let container: HTMLDivElement;
let client: QueryClient;
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(api.get).mockResolvedValue({ agentId: null, specialRole: "pr_inspector" });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  flushSync(() => root.render(<QueryClientProvider client={client}>
    <NewAgentMenu companyId="company-a" onCreateCustomized={customized} />
  </QueryClientProvider>));
});
afterEach(() => {
  flushSync(() => root.unmount());
  container.remove();
  client.clear();
});
async function menuItem(label: string, disabled = false) {
  await vi.waitFor(() => expect(client.getQueryData(["pr-inspector", "company-a"])).toBeDefined());
  flushSync(() => container.querySelector("button")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
  let item: HTMLElement | undefined;
  await vi.waitFor(() => {
    item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(entry => entry.textContent === label);
    expect(item).toBeDefined();
    expect(item?.getAttribute("aria-disabled") === "true").toBe(disabled);
  });
  return item!;
}

it("creates the fixed inspector from New Agent and opens its Devbox configuration", async () => {
  vi.mocked(api.post).mockResolvedValue({ agentId: "inspector-a", specialRole: "pr_inspector" });
  const item = await menuItem("Create PR Inspector Agent");
  expect(container.querySelector('[role="switch"]')).toBeNull();
  expect(item.getAttribute("aria-disabled")).not.toBe("true");
  flushSync(() => item.click());
  await vi.waitFor(() => expect(navigate).toHaveBeenCalledWith("/agents/inspector-a/configuration"));
  expect(api.post).toHaveBeenCalledWith("/companies/company-a/pr-inspector", {});
  expect(customized).not.toHaveBeenCalled();
});

it("keeps customized creation on the existing dialog path", async () => {
  const item = await menuItem("Create Customized Agent");
  flushSync(() => item.click());
  expect(customized).toHaveBeenCalledOnce();
  expect(api.post).not.toHaveBeenCalled();
});

it("does not offer a second inspector while one exists", async () => {
  await vi.waitFor(() => expect(client.getQueryData(["pr-inspector", "company-a"])).toMatchObject({ agentId: null }));
  client.setQueryData(["pr-inspector", "company-a"], { agentId: "inspector-a", specialRole: "pr_inspector" });
  const item = await menuItem("Create PR Inspector Agent", true);
  expect(item.getAttribute("aria-disabled")).toBe("true");
  flushSync(() => item.click());
  expect(api.post).not.toHaveBeenCalled();
});

it("shows failed creation without navigation or a false inspector state", async () => {
  vi.mocked(api.post).mockRejectedValue(new Error("The pr-inspector pool has incompatible type"));
  const item = await menuItem("Create PR Inspector Agent");
  flushSync(() => item.click());
  await vi.waitFor(() => expect(container.querySelector('[role="alert"]')?.textContent).toContain("incompatible type"));
  expect(navigate).not.toHaveBeenCalled();
  expect(client.getQueryData(["pr-inspector", "company-a"])).toMatchObject({ agentId: null });
});

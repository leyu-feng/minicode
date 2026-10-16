import { afterEach, describe, expect, it, vi } from "vitest";
import type { AdapterEnvironmentTestResult } from "@paperclipai/adapter-utils";
import { ADAPTER_AUTH_MISSING_CHECK_CODE } from "@paperclipai/shared";
import { assertHarnessTestPassed } from "../services/agent-harness-verification.js";
import { agentPoolAdapter } from "../adapters/agent-pool/index.js";
import { agentPoolBroker } from "../services/agent-pool-broker.js";

afterEach(() => vi.restoreAllMocks());

describe("AgentPool harness verification", () => {
  it.each([{}, { name: "custom" }])("passes with a connected worker in the selected company pool: %j", async (config) => {
    const connected = vi.spyOn(agentPoolBroker, "hasConnectedWorker").mockReturnValue(true);
    const result = await agentPoolAdapter.testEnvironment({ companyId: "company-a", adapterType: "agent_pool", config });
    expect(connected).toHaveBeenCalledWith("company-a", "name" in config ? config.name : "default");
    expect(result.status).toBe("pass");
    expect(() => assertHarnessTestPassed(result)).not.toThrow();
  });

  it("rejects a pool without a connected worker", async () => {
    vi.spyOn(agentPoolBroker, "hasConnectedWorker").mockReturnValue(false);
    const result = await agentPoolAdapter.testEnvironment({
      companyId: "company-a", adapterType: "agent_pool", config: { name: "default" },
    });
    expect(result.status).toBe("fail");
    expect(() => assertHarnessTestPassed(result)).toThrow("The harness test failed");
  });

  it.each(["", "INVALID", " default ", 42])("rejects an invalid pool name: %j", async (name) => {
    const connected = vi.spyOn(agentPoolBroker, "hasConnectedWorker");
    const result = await agentPoolAdapter.testEnvironment({
      companyId: "company-a", adapterType: "agent_pool", config: { name },
    });
    expect(result.status).toBe("fail");
    expect(connected).not.toHaveBeenCalled();
  });
});

describe("saved harness verification", () => {
  const result = (status: AdapterEnvironmentTestResult["status"], codes: string[]): AdapterEnvironmentTestResult => ({
    adapterType: "test", status, testedAt: new Date().toISOString(),
    checks: codes.map(code => ({ code, level: "info", message: code })),
  });
  it.each([
    ["fail", []], ["warn", ["claude_hello_probe_auth_required"]],
    ["warn", ["gemini_hello_probe_timed_out"]], ["pass", ["claude_hello_probe_skipped_custom_command"]],
    ["warn", ["claude_acp_anthropic_api_key_detected", "claude_acp_login_probe_unavailable"]],
    ["warn", ["cli_version_probe_mismatch"]], ["pass", [ADAPTER_AUTH_MISSING_CHECK_CODE]],
    ["warn", ["claude_hello_probe_passed", "claude_hello_probe_auth_required"]],
  ] as const)("rejects %s with %j", (status, codes) => {
    expect(() => assertHarnessTestPassed(result(status, [...codes]))).toThrow("The harness test failed");
  });
  it.each([
    ["pass", ["process_command_available"]], ["warn", ["claude_hello_probe_passed", "optional_environment_warning"]],
    ["warn", ["claude_acp_anthropic_api_key_detected", "claude_hello_probe_passed"]],
    ["pass", ["codex_hello_probe_succeeded"]], ["warn", ["ai_connection_api_key_reverified"]],
  ] as const)("accepts %s with %j", (status, codes) => {
    expect(() => assertHarnessTestPassed(result(status, [...codes]))).not.toThrow();
  });
});

import type { UIAdapterModule, AdapterConfigFieldsProps } from "../types";
import { configFieldsForSection } from "../config-sections";
import { Field, DraftInput } from "../../components/agent-config-primitives";
import { processUIAdapter } from "../process";
import { HostedRepositorySelect } from "../../components/HostedRepositorySelect";
import { HostedHarnessSelect } from "../../components/HostedHarnessSelect";
import { AgentGitHubLogin } from "../../components/AgentGitHubLogin";
import { AGENT_POOL_CLAUDECODE_DEFAULT_MODEL, agentPoolRequiresGitHubLogin } from "@paperclipai/shared";
import { runToolSummarySchema } from "@paperclipai/shared";
import type { TranscriptEntry } from "../types";

export function parseAgentPoolStdoutLine(line: string, ts: string): TranscriptEntry[] {
  // Legacy workers prefix stdout. New servers emit unprefixed structured summaries.
  const candidate = line.replace(/^\[[^\]\r\n]+\]\s*/, "");
  if (candidate.startsWith('{"type":"clippy.tool"')) {
    let value: unknown;
    try { value = JSON.parse(candidate); } catch { return processUIAdapter.parseStdoutLine(line, ts); }
    const parsed = runToolSummarySchema.safeParse(value);
    if (parsed.success) {
      const summary = parsed.data;
      const entries: TranscriptEntry[] = [{
        kind: "tool_call", ts, name: summary.name, toolUseId: summary.callId,
        input: {
          clippyTool: true, summary: summary.summary, durationMs: summary.durationMs,
          [summary.phase === "start" ? "startDetailRef" : "endDetailRef"]: summary.detailRef,
          ...(summary.detailStatus === "unavailable" ? { detailsUnavailable: true } : {}),
        },
      }];
      if (summary.phase === "end") entries.push({
        kind: "tool_result", ts, toolUseId: summary.callId, toolName: summary.name,
        content: summary.summary, isError: summary.isError,
      });
      return entries;
    }
  }
  return processUIAdapter.parseStdoutLine(line, ts);
}

function AgentPoolConfigFields({ section, isCreate, values, set, config, eff, mark, companyId, agentId }: AdapterConfigFieldsProps) {
  const current = isCreate ? values?.adapterSchemaValues ?? {} : config;
  const name = isCreate ? String(current.name ?? "default") : eff("adapterConfig", "name", String(config.name ?? "default"));
  const harness = isCreate ? String(current.harness ?? "default") : eff("adapterConfig", "harness", String(config.harness ?? "default"));
  const defaultModel = harness === "claudecode" ? AGENT_POOL_CLAUDECODE_DEFAULT_MODEL : "";
  const model = String((isCreate ? current.harnessModel : eff("adapterConfig", "harnessModel", config.harnessModel)) ?? defaultModel);
  const rawPrimary = isCreate ? current.primaryRepositoryId : eff("adapterConfig", "primaryRepositoryId", config.primaryRepositoryId);
  const rawReferences = isCreate ? current.referenceRepositoryIds : eff("adapterConfig", "referenceRepositoryIds", config.referenceRepositoryIds);
  const primaryId = typeof rawPrimary === "string" ? rawPrimary : undefined;
  const referenceIds = Array.isArray(rawReferences) ? rawReferences.filter((id): id is string => typeof id === "string") : [];
  return configFieldsForSection(section, (
    <>
    <Field label="Pool name" hint="A company AgentPool. Create pools and pair Minicode workers in company settings.">
      <DraftInput
        value={name}
        onCommit={(nextName) => {
          if (isCreate) set!({ adapterSchemaValues: { ...values?.adapterSchemaValues, name: nextName,
            primaryRepositoryId: undefined, referenceRepositoryIds: [], harness: "default", harnessModel: undefined } });
          else {
            mark("adapterConfig", "name", nextName);
            mark("adapterConfig", "primaryRepositoryId", undefined);
            mark("adapterConfig", "referenceRepositoryIds", []);
            mark("adapterConfig", "harness", "default");
            mark("adapterConfig", "harnessModel", undefined);
          }
        }}
        immediate
        className="w-full rounded-md border border-border px-2.5 py-1.5 bg-transparent text-sm"
        placeholder="default"
      />
    </Field>
    <HostedHarnessSelect companyId={companyId ?? null} poolName={name} value={harness}
      onChange={next => {
        if (next === harness) return;
        const harnessModel = next === "claudecode" ? AGENT_POOL_CLAUDECODE_DEFAULT_MODEL : undefined;
        if (isCreate) set!({ adapterSchemaValues: { ...values?.adapterSchemaValues, harness: next, harnessModel } });
        else {
          mark("adapterConfig", "harness", next);
          mark("adapterConfig", "harnessModel", harnessModel);
        }
      }} />
    {agentPoolRequiresGitHubLogin(harness) && <>
      <Field label="Model" hint="Native CLI model ID. Claude Code defaults to claude-sonnet-5 after sign-in; Copilot defaults to auto.">
        <DraftInput value={model} placeholder={harness === "copilotcli" ? "auto" : AGENT_POOL_CLAUDECODE_DEFAULT_MODEL} immediate
          className="w-full rounded-md border border-border px-2.5 py-1.5 bg-transparent text-sm"
          onCommit={value => {
            if (isCreate) set!({ adapterSchemaValues: { ...values?.adapterSchemaValues, harnessModel: value || undefined } });
            else mark("adapterConfig", "harnessModel", value || undefined);
          }} />
      </Field>
      <AgentGitHubLogin companyId={companyId} agentId={isCreate ? undefined : agentId} />
    </>}
    <HostedRepositorySelect companyId={companyId ?? null} poolName={name} primaryId={primaryId} referenceIds={referenceIds}
      onChange={(primaryRepositoryId, referenceRepositoryIds) => {
        if (isCreate) set!({ adapterSchemaValues: { ...values?.adapterSchemaValues, primaryRepositoryId, referenceRepositoryIds } });
        else {
          mark("adapterConfig", "primaryRepositoryId", primaryRepositoryId);
          mark("adapterConfig", "referenceRepositoryIds", referenceRepositoryIds);
        }
      }} />
    </>
  ));
}

export const agentPoolUIAdapter: UIAdapterModule = {
  type: "agent_pool", label: "AgentPool",
  ConfigFields: AgentPoolConfigFields,
  buildAdapterConfig: (values) => {
    const config = values.adapterSchemaValues ?? {};
    const harnessModel = config.harnessModel ?? (config.harness === "claudecode" ? AGENT_POOL_CLAUDECODE_DEFAULT_MODEL : undefined);
    return {
      name: config.name ?? "default",
      ...(config.harness ? { harness: config.harness } : {}),
      ...(harnessModel ? { harnessModel } : {}),
      ...(config.primaryRepositoryId ? { primaryRepositoryId: config.primaryRepositoryId } : {}),
      ...(config.referenceRepositoryIds ? { referenceRepositoryIds: config.referenceRepositoryIds } : {}),
    };
  },
  parseStdoutLine: parseAgentPoolStdoutLine,
};

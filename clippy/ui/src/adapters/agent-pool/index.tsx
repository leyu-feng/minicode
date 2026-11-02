import type { UIAdapterModule, AdapterConfigFieldsProps } from "../types";
import { configFieldsForSection } from "../config-sections";
import { Field, DraftInput } from "../../components/agent-config-primitives";
import { processUIAdapter } from "../process";
import { HostedRepositorySelect } from "../../components/HostedRepositorySelect";
import { HostedHarnessSelect } from "../../components/HostedHarnessSelect";
import { AgentGitHubLogin } from "../../components/AgentGitHubLogin";
import { agentPoolRequiresGitHubLogin } from "@paperclipai/shared";

function AgentPoolConfigFields({ section, isCreate, values, set, config, eff, mark, companyId, agentId }: AdapterConfigFieldsProps) {
  const current = isCreate ? values?.adapterSchemaValues ?? {} : config;
  const name = isCreate ? String(current.name ?? "default") : eff("adapterConfig", "name", String(config.name ?? "default"));
  const harness = isCreate ? String(current.harness ?? "default") : eff("adapterConfig", "harness", String(config.harness ?? "default"));
  const model = isCreate ? String(current.harnessModel ?? "") : eff("adapterConfig", "harnessModel", String(config.harnessModel ?? ""));
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
            primaryRepositoryId: undefined, referenceRepositoryIds: [], harness: "default" } });
          else {
            mark("adapterConfig", "name", nextName);
            mark("adapterConfig", "primaryRepositoryId", undefined);
            mark("adapterConfig", "referenceRepositoryIds", []);
            mark("adapterConfig", "harness", "default");
          }
        }}
        immediate
        className="w-full rounded-md border border-border px-2.5 py-1.5 bg-transparent text-sm"
        placeholder="default"
      />
    </Field>
    <HostedHarnessSelect companyId={companyId ?? null} poolName={name} value={harness}
      onChange={next => {
        if (isCreate) set!({ adapterSchemaValues: { ...values?.adapterSchemaValues, harness: next } });
        else mark("adapterConfig", "harness", next);
      }} />
    {agentPoolRequiresGitHubLogin(harness) && <>
      <Field label="Model" hint="Optional native CLI model ID. Copilot defaults to auto; Claude uses the worker's configured model.">
        <DraftInput value={model} placeholder={harness === "copilotcli" ? "auto" : "Worker model"} immediate
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
  buildAdapterConfig: (values) => ({
    name: values.adapterSchemaValues?.name ?? "default",
    ...(values.adapterSchemaValues?.harness ? { harness: values.adapterSchemaValues.harness } : {}),
    ...(values.adapterSchemaValues?.harnessModel ? { harnessModel: values.adapterSchemaValues.harnessModel } : {}),
    ...(values.adapterSchemaValues?.primaryRepositoryId ? { primaryRepositoryId: values.adapterSchemaValues.primaryRepositoryId } : {}),
    ...(values.adapterSchemaValues?.referenceRepositoryIds ? { referenceRepositoryIds: values.adapterSchemaValues.referenceRepositoryIds } : {}),
  }),
  parseStdoutLine: processUIAdapter.parseStdoutLine,
};

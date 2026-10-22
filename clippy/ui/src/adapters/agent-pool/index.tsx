import type { UIAdapterModule, AdapterConfigFieldsProps } from "../types";
import { configFieldsForSection } from "../config-sections";
import { Field, DraftInput } from "../../components/agent-config-primitives";
import { processUIAdapter } from "../process";
import { HostedRepositorySelect } from "../../components/HostedRepositorySelect";

function AgentPoolConfigFields({ section, isCreate, values, set, config, eff, mark, companyId }: AdapterConfigFieldsProps) {
  const current = isCreate ? values?.adapterSchemaValues ?? {} : config;
  const name = isCreate ? String(current.name ?? "default") : eff("adapterConfig", "name", String(config.name ?? "default"));
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
            primaryRepositoryId: undefined, referenceRepositoryIds: [] } });
          else {
            mark("adapterConfig", "name", nextName);
            mark("adapterConfig", "primaryRepositoryId", undefined);
            mark("adapterConfig", "referenceRepositoryIds", []);
          }
        }}
        immediate
        className="w-full rounded-md border border-border px-2.5 py-1.5 bg-transparent text-sm"
        placeholder="default"
      />
    </Field>
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
    ...(values.adapterSchemaValues?.primaryRepositoryId ? { primaryRepositoryId: values.adapterSchemaValues.primaryRepositoryId } : {}),
    ...(values.adapterSchemaValues?.referenceRepositoryIds ? { referenceRepositoryIds: values.adapterSchemaValues.referenceRepositoryIds } : {}),
  }),
  parseStdoutLine: processUIAdapter.parseStdoutLine,
};

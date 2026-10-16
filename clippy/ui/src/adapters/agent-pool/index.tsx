import type { UIAdapterModule, AdapterConfigFieldsProps } from "../types";
import { configFieldsForSection } from "../config-sections";
import { Field, DraftInput } from "../../components/agent-config-primitives";
import { processUIAdapter } from "../process";

function AgentPoolConfigFields({ section, isCreate, values, set, config, eff, mark }: AdapterConfigFieldsProps) {
  return configFieldsForSection(section, (
    <Field label="Pool name" hint="A company AgentPool. Create pools and pair Minicode workers in company settings.">
      <DraftInput
        value={isCreate ? String(values?.adapterSchemaValues?.name ?? "default")
          : eff("adapterConfig", "name", String(config.name ?? "default"))}
        onCommit={(name) => isCreate
          ? set!({ adapterSchemaValues: { ...values?.adapterSchemaValues, name } })
          : mark("adapterConfig", "name", name)}
        immediate
        className="w-full rounded-md border border-border px-2.5 py-1.5 bg-transparent text-sm"
        placeholder="default"
      />
    </Field>
  ));
}

export const agentPoolUIAdapter: UIAdapterModule = {
  type: "agent_pool", label: "AgentPool",
  ConfigFields: AgentPoolConfigFields,
  buildAdapterConfig: (values) => ({ name: values.adapterSchemaValues?.name ?? "default" }),
  parseStdoutLine: processUIAdapter.parseStdoutLine,
};

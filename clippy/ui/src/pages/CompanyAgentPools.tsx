import { useEffect } from "react";
import { UserRoundGroup } from "lucide-react";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { AgentPoolSettings } from "../components/AgentPoolSettings";

export function CompanyAgentPools() {
  const { selectedCompany, selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();

  useEffect(() => {
    setBreadcrumbs([
      { label: selectedCompany?.name ?? "Company", href: "/dashboard" },
      { label: "Settings", href: "/company/settings" },
      { label: "Agent Pools" },
    ]);
  }, [setBreadcrumbs, selectedCompany?.name]);

  if (!selectedCompanyId) {
    return (
      <div className="text-sm text-muted-foreground">
        No organization selected. Select an organization from the switcher above.
      </div>
    );
  }

  return (
    <div className="max-w-6xl space-y-8">
      <div className="flex items-center gap-2">
        <UserRoundGroup className="h-5 w-5 text-muted-foreground" />
        <h1 className="text-lg font-semibold">Agent Pools</h1>
      </div>
      <AgentPoolSettings key={selectedCompanyId} companyId={selectedCompanyId} />
    </div>
  );
}

import { useQuery } from "@tanstack/react-query";
import { ShieldLock } from "lucide-react";
import { healthApi } from "@/api/health";
import { queryKeys } from "@/lib/queryKeys";

export function DeploymentClassificationLabel() {
  const { data } = useQuery({
    queryKey: queryKeys.health,
    queryFn: () => healthApi.get(),
    enabled: false,
  });
  const label = data?.classificationLabel?.trim();

  if (!label) return null;

  return (
    <div
      role="note"
      aria-label="Deployment classification"
      title={label}
      className="ml-2 flex min-w-0 max-w-(--sz-classification-label-max-width) shrink-0 items-center gap-1.5 rounded-md border border-border bg-muted px-2 py-1 text-xs font-medium text-foreground"
    >
      <ShieldLock className="size-4 shrink-0 text-(--classification-icon)" aria-hidden="true" />
      <span className="line-clamp-2 min-w-0 break-words">{label}</span>
    </div>
  );
}

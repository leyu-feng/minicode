import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@/lib/router";
import { api } from "../api/client";
import { queryKeys } from "../lib/queryKeys";
import { Button } from "./ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "./ui/dropdown-menu";
import { ChevronDown, Plus } from "lucide-react";

interface InspectorState {
  agentId: string | null;
  specialRole: "pr_inspector";
}

export function NewAgentMenu({ companyId, onCreateCustomized }: { companyId: string | null; onCreateCustomized: () => void }) {
  const navigate = useNavigate();
  const client = useQueryClient();
  const key = ["pr-inspector", companyId];
  const path = `/companies/${companyId}/pr-inspector`;
  const state = useQuery({ queryKey: key, queryFn: () => api.get<InspectorState>(path), enabled: Boolean(companyId) });
  const update = useMutation({
    mutationFn: () => api.post<InspectorState>(path, {}),
    onSuccess: async (value) => {
      client.setQueryData(key, value);
      if (companyId) {
        await client.invalidateQueries({ queryKey: queryKeys.agents.list(companyId) });
        await client.invalidateQueries({ queryKey: queryKeys.org(companyId) });
        await client.invalidateQueries({ queryKey: ["agent-pools", companyId] });
      }
      if (value.agentId) navigate(`/agents/${value.agentId}/configuration`);
    },
  });
  return <div className="flex flex-col gap-1">
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="sm" variant="outline">
          <Plus className="h-3.5 w-3.5 mr-1.5" />New Agent<ChevronDown className="h-3.5 w-3.5 ml-1.5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem disabled={!state.data || Boolean(state.data.agentId) || update.isPending}
          onSelect={() => update.mutate()}>Create PR Inspector Agent</DropdownMenuItem>
        <DropdownMenuItem onSelect={onCreateCustomized}>Create Customized Agent</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
    {(state.error || update.error) && <p role="alert" className="text-xs text-destructive">
      {(update.error ?? state.error)?.message}
    </p>}
  </div>;
}

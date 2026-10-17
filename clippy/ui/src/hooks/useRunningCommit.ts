import { useQuery } from "@tanstack/react-query";
import { healthApi } from "@/api/health";
import { queryKeys } from "@/lib/queryKeys";

export function useRunningCommit(menuOpen: boolean) {
  const { data, isError, isFetching } = useQuery({
    // Keep optional menu refresh failures separate from the board's access gate.
    queryKey: queryKeys.runningCommit,
    queryFn: () => healthApi.get(),
    enabled: menuOpen,
    // Opening the menu must refresh the server SHA after a rollout.
    staleTime: 0,
    retry: false,
  });

  return {
    commit: !isError && !isFetching ? data?.commit ?? null : null,
    isLoading: isFetching,
  };
}

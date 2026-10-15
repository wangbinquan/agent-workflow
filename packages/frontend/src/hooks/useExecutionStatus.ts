import { useQuery } from '@tanstack/react-query'
import { ExecutionStatusSchema } from '@agent-workflow/shared'
import { api } from '@/api/client'
import { useAuthSessionRevision, useAuthTokenSnapshot } from './useActor'

export const EXECUTION_STATUS_QUERY_KEY = ['execution', 'status'] as const

/** RFC-370 v2 H7: standalone is always active and is read once; a hosted
 * instance is polled because CrewStation activates or freezes it at any time. */
export function useExecutionStatus() {
  const token = useAuthTokenSnapshot(),
    revision = useAuthSessionRevision()
  return useQuery({
    queryKey: [...EXECUTION_STATUS_QUERY_KEY, revision],
    enabled: token !== null,
    queryFn: async ({ signal }) =>
      ExecutionStatusSchema.parse(
        await api.get<unknown>('/api/execution/status', undefined, signal),
      ),
    staleTime: 5_000,
    refetchInterval: (query) => (query.state.data?.mode === 'crewstation' ? 5_000 : false),
    refetchOnWindowFocus: true,
  })
}

import { useQuery } from '@tanstack/react-query'
import { HostExecutionStatusSchema } from '@agent-workflow/shared'
import { api } from '@/api/client'
import { useAuthSessionRevision, useAuthTokenSnapshot } from './useActor'

export const HOST_EXECUTION_STATUS_QUERY_KEY = ['execution', 'status'] as const

export function useHostExecutionStatus() {
  const token = useAuthTokenSnapshot(),
    revision = useAuthSessionRevision()
  return useQuery({
    queryKey: [...HOST_EXECUTION_STATUS_QUERY_KEY, revision],
    enabled: token !== null,
    queryFn: async ({ signal }) =>
      HostExecutionStatusSchema.parse(
        await api.get<unknown>('/api/execution/status', undefined, signal),
      ),
    staleTime: 5_000,
    // Selected availability changes independently of edits and task rows.
    // This read has no DB polling, claims, recovery or execution side effect.
    refetchInterval: (query) => (query.state.data?.mode === 'native' ? false : 5_000),
    refetchOnWindowFocus: true,
    placeholderData: undefined,
  })
}

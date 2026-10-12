import { useQuery } from '@tanstack/react-query'
import { WS_PATHS, type ObservationProjectionWsMessage } from '@agent-workflow/shared'
import { api } from '@/api/client'
import { useWsInvalidation } from '@/hooks/useWsInvalidation'

const KEY = ['run-observability-projection-version'] as const
/** A lost WS frame/reconnect is repaired by one small version read. Neither
 * this poll nor a version notification requests raw numerical recalculation. */
export function useObservationProjectionVersion(enabled: boolean) {
  useWsInvalidation<ObservationProjectionWsMessage>(
    enabled ? WS_PATHS.observability : null,
    { 'observability.projection.changed': () => [KEY] },
    undefined,
    { coalesceMs: 250, reconcileOnOpen: () => [KEY] },
  )
  return useQuery({
    queryKey: KEY,
    enabled,
    queryFn: ({ signal }) =>
      api.get<{ revision: string; asOf: number } | null>(
        '/api/observability/projection-version',
        undefined,
        signal,
      ),
    retry: false,
    refetchOnWindowFocus: true,
    refetchInterval: () => (typeof document !== 'undefined' && document.hidden ? 30000 : 2000),
  }).data
}

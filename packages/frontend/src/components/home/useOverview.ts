// RFC-190 — shared /api/overview query for the homepage (CapabilityGrid tiles
// + HomepageGreeting pulse line share one fetch; react-query dedupes).
//
// Failure is soft by design (design.md §5): consumers render "—" placeholders
// / omit the pulse line instead of blocking the rest of the homepage.

import { useQuery, type UseQueryResult } from '@tanstack/react-query'
import type { OverviewResponse } from '@agent-workflow/shared'
import { api } from '@/api/client'

export const OVERVIEW_HOME_QUERY_KEY = ['overview', 'home'] as const

export function useOverview(opts: { enabled?: boolean } = {}): UseQueryResult<OverviewResponse> {
  return useQuery<OverviewResponse>({
    queryKey: OVERVIEW_HOME_QUERY_KEY,
    queryFn: ({ signal }) => api.get('/api/overview', undefined, signal),
    staleTime: 30_000,
    refetchInterval: 60_000,
    // Onboarding's intro tiles render without counts — no request at all.
    enabled: opts.enabled ?? true,
  })
}

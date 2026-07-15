// RFC-041 PR4 follow-up — Memory sub-nav pending-count badge.
//
// Rendered as the `renderBadge(item)` return value for the Memory sub-nav
// item inside NavGroup. The Link itself is owned by NavGroup; this
// component is purely the right-aligned numeric badge.
//
// RFC-121: the badge now sums TWO pending feeds that both live on the
// /memory page —
//   - memory candidates (status=candidate) — admin-only, as before
//   - fusions awaiting approval — owner/admin-scoped server-side
// so a non-admin owner with a pending fusion now sees the badge light up
// (it previously rode the inbox footer badge, which RFC-121 stripped of
// fusions). WS invalidation for candidates lives in `useMemoryWs`; fusions
// have no WS channel so the 60s poll drives their count (matching the prior
// inbox behaviour).
//
// Visibility:
//   - 0 pending (candidates + fusions) → returns null (no badge)
//   - ≥1 pending → returns a `.sidebar__badge.nav-item__badge`

import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import type { FusionPendingCount, MemorySummary } from '@agent-workflow/shared'
import { api } from '@/api/client'
import { useIsAdmin } from '@/hooks/useActor'

interface ListResponse {
  items: MemorySummary[]
}

export function MemoryPendingBadge() {
  const { t } = useTranslation()
  // Memory-candidate approval stays admin-gated: only admins fetch + count
  // candidates (a non-admin never fires this request).
  const isAdmin = useIsAdmin()
  const candidates = useQuery<ListResponse>({
    queryKey: ['memories', 'pending-count'],
    queryFn: ({ signal }) =>
      api.get<ListResponse>('/api/memories', { status: 'candidate' }, signal),
    enabled: isAdmin,
    refetchInterval: 60_000,
  })
  // The fusion pending-count endpoint is owner/admin-scoped on the server,
  // so every signed-in user safely fetches their own count.
  const fusions = useQuery<FusionPendingCount>({
    queryKey: ['fusions', 'pending-count'],
    queryFn: ({ signal }) => api.get('/api/fusions/pending-count', undefined, signal),
    refetchInterval: 60_000,
  })

  const candidateCount = isAdmin ? (candidates.data?.items.length ?? 0) : 0
  const fusionCount = fusions.data?.count ?? 0
  const count = candidateCount + fusionCount
  if (count === 0) return null
  const badgeText = count > 99 ? '99+' : String(count)
  return (
    <span
      className="sidebar__badge nav-item__badge"
      data-testid="nav-memory-badge"
      aria-label={t('nav.memoryBadge', { count })}
    >
      {badgeText}
    </span>
  )
}

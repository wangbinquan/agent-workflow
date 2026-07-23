// Memory pending count shown inside the single Memory navigation link.
//
// The main link always opens the stable library default (`?tab=all`). The
// count is status rather than a second destination, so the row exposes one
// click target and one keyboard stop. Candidate permission comes only from
// each server-returned `canManage` field; fusion count is already owner/admin
// scoped by its endpoint. Neither actor role nor a missing field is treated
// as permission.

import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import type { FusionPendingCount, MemorySummary } from '@agent-workflow/shared'
import { api } from '@/api/client'

interface ListResponse {
  items: MemorySummary[]
}

export interface MemoryPendingCounts {
  candidates: number
  fusions: number
  total: number
}

export function countManageableMemoryCandidates(items: readonly MemorySummary[]): number {
  return items.filter((item) => item.canManage === true).length
}

export function useMemoryPendingCounts(options: { enabled?: boolean } = {}): MemoryPendingCounts {
  const enabled = options.enabled ?? true
  const candidates = useQuery<ListResponse>({
    queryKey: ['memories', 'pending-count'],
    queryFn: ({ signal }) =>
      api.get<ListResponse>('/api/memories', { status: 'candidate' }, signal),
    enabled,
    refetchInterval: 60_000,
  })
  const fusions = useQuery<FusionPendingCount>({
    queryKey: ['fusions', 'pending-count'],
    queryFn: ({ signal }) => api.get('/api/fusions/pending-count', undefined, signal),
    enabled,
    refetchInterval: 60_000,
  })

  const candidateCount = countManageableMemoryCandidates(candidates.data?.items ?? [])
  const fusionCount = fusions.data?.count ?? 0
  return {
    candidates: candidateCount,
    fusions: fusionCount,
    total: candidateCount + fusionCount,
  }
}

export function MemoryPendingBadge() {
  const { t } = useTranslation()
  const counts = useMemoryPendingCounts()
  if (counts.total === 0) return null
  const badgeText = counts.total > 99 ? '99+' : String(counts.total)
  const description = t('nav.memoryBadge', { count: counts.total })
  return (
    <span className="nav-item__pending-count" title={description}>
      <span
        className="sidebar__badge nav-item__badge"
        data-testid="nav-memory-badge"
        aria-hidden="true"
      >
        {badgeText}
      </span>
      <span className="sr-only">{description}</span>
    </span>
  )
}

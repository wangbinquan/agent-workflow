// RFC-201 B4 — Memory pending accessory.
//
// The Memory row has two independent destinations: its main Link always
// opens the stable library default (`?tab=all`), while this sibling Link opens
// the first actionable pending feed. Candidate permission comes only from
// each server-returned `canManage` field; fusion count is already owner/admin
// scoped by its endpoint. Neither actor role nor a missing field is treated as
// permission.

import { useQuery } from '@tanstack/react-query'
import { createLink } from '@tanstack/react-router'
import { forwardRef, type ComponentPropsWithoutRef } from 'react'
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

export function memoryPendingDestination(
  counts: Pick<MemoryPendingCounts, 'candidates' | 'fusions'>,
): 'approval-queue' | 'fusion' | null {
  if (counts.candidates > 0) return 'approval-queue'
  if (counts.fusions > 0) return 'fusion'
  return null
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

interface AccessoryAnchorProps extends ComponentPropsWithoutRef<'a'> {
  'data-status'?: string
}

// A pending action is not the page's current-location owner. Strip TanStack's
// fuzzy active semantics while retaining its SPA/link behaviour.
const AccessoryAnchor = forwardRef<HTMLAnchorElement, AccessoryAnchorProps>(
  ({ 'aria-current': _current, 'data-status': _status, className, ...props }, ref) => (
    <a
      {...props}
      ref={ref}
      className={className
        ?.split(/\s+/)
        .filter((token) => token !== 'active')
        .join(' ')}
    />
  ),
)

const AccessoryLink = createLink(AccessoryAnchor)

export function MemoryPendingBadge() {
  const { t } = useTranslation()
  const counts = useMemoryPendingCounts()
  const destination = memoryPendingDestination(counts)
  if (destination === null) return null
  const badgeText = counts.total > 99 ? '99+' : String(counts.total)
  return (
    <AccessoryLink
      to="/memory"
      search={{ tab: destination }}
      className="nav-item__accessory"
      data-testid="nav-memory-badge"
      aria-label={t('nav.memoryPendingAction', { count: counts.total })}
      title={t('nav.memoryPendingAction', { count: counts.total })}
    >
      <span className="sidebar__badge nav-item__badge" aria-hidden="true">
        {badgeText}
      </span>
    </AccessoryLink>
  )
}

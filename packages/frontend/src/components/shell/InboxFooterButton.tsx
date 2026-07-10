// RFC-032 PR2: sidebar footer button that opens the unified inbox drawer.
//
// Sums the pending counts from `/api/reviews/pending-count` and
// `/api/clarify/pending-count` and renders a single badge — the user no
// longer has to track two separate red dots. When one of the endpoints
// errors we still render the button + the badge of the *successful* feed
// (failure-soft, see design.md §5). When both fail we hide the badge and
// keep the button so the drawer can still surface a retry banner.
//
// RFC-121: fusions left the inbox for the /memory page, so this badge no
// longer counts awaiting-approval fusions — the sidebar Memory badge
// (MemoryPendingBadge) carries the fusion + memory-candidate pending count.
//
// RFC-164 PR-6: third source — workgroup to-dos (my pending human-delivery
// cards + confirmable completion gates), same failure-soft merge.

import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import type { ClarifyPendingCount, ReviewPendingCount } from '@agent-workflow/shared'
import { api } from '@/api/client'
import type { WorkgroupPendingCount } from '@/lib/workgroup-room'

interface InboxFooterButtonProps {
  open: boolean
  onToggle: () => void
}

export function InboxFooterButton({ open, onToggle }: InboxFooterButtonProps) {
  const { t } = useTranslation()
  const reviews = useQuery<ReviewPendingCount>({
    queryKey: ['reviews', 'pending-count'],
    queryFn: ({ signal }) => api.get('/api/reviews/pending-count', undefined, signal),
    refetchInterval: 15_000,
  })
  const clarify = useQuery<ClarifyPendingCount>({
    queryKey: ['clarify', 'pending-count'],
    queryFn: ({ signal }) => api.get('/api/clarify/pending-count', undefined, signal),
    refetchInterval: 15_000,
  })
  const workgroups = useQuery<WorkgroupPendingCount>({
    queryKey: ['workgroup-tasks', 'pending-count'],
    queryFn: ({ signal }) => api.get('/api/workgroup-tasks/pending-count', undefined, signal),
    refetchInterval: 15_000,
  })

  const reviewsCount = reviews.data?.count ?? 0
  const clarifyCount = clarify.data?.count ?? 0
  const workgroupCount = workgroups.data?.total ?? 0
  const allFailed = reviews.error && clarify.error && workgroups.error
  // Even if one feed errors the others still contribute — design.md §5.
  const total = reviewsCount + clarifyCount + workgroupCount
  const showBadge = !allFailed && total > 0
  const badgeText = total > 99 ? '99+' : String(total)

  return (
    <button
      type="button"
      className={`inbox-footer-button${open ? ' inbox-footer-button--open' : ''}`}
      data-testid="inbox-footer-button"
      aria-label={t('nav.inbox.label')}
      aria-expanded={open}
      onClick={onToggle}
    >
      <InboxIcon />
      <span className="inbox-footer-button__label">{t('nav.inbox.label')}</span>
      {showBadge && (
        <span
          className="sidebar__badge inbox-footer-button__badge"
          data-testid="inbox-footer-badge"
          aria-label={t('nav.inbox.badgeAria', { n: total })}
        >
          {badgeText}
        </span>
      )}
    </button>
  )
}

function InboxIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M22 12h-6l-2 3h-4l-2-3H2" />
      <path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
    </svg>
  )
}

// RFC-121 — Memory page "fusion" tab.
//
// Lists fusions awaiting approval and links each row to its
// /fusions/:id approval detail (where the before/after diff is reviewed).
// This is the list entry point to fusions — they previously surfaced only
// in the inbox drawer's "fusion" group, which RFC-121 removed.
//
// There is no fusion WS channel (the fusion detail page polls), so a 15s
// refetch keeps the tab fresh — matching the prior inbox behaviour. The
// poll also drives server-side lazy done-detection for running fusions.

import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import type { Fusion } from '@agent-workflow/shared'
import { api } from '@/api/client'
import { EmptyState } from '@/components/EmptyState'
import { ErrorBanner } from '@/components/ErrorBanner'
import { LoadingState } from '@/components/LoadingState'

export function MemoryFusionList() {
  const { t } = useTranslation()
  // Same feed the inbox used (admin sees all awaiting fusions, owners see
  // their own — scoped server-side in routes/fusions.ts).
  const fusions = useQuery<Fusion[]>({
    queryKey: ['fusions', 'memory', 'awaiting'],
    queryFn: ({ signal }) => api.get('/api/fusions?status=awaiting_approval', undefined, signal),
    refetchInterval: 15_000,
  })

  const fusionsError = fusions.error !== null && fusions.error !== undefined
  const retryAction = (
    <button type="button" className="btn btn--sm" onClick={() => void fusions.refetch()}>
      {t('common.retry')}
    </button>
  )
  if (fusions.data === undefined) {
    if (fusions.isLoading) return <LoadingState />
    if (fusionsError) {
      return (
        <div data-testid="memory-fusion-error">
          <ErrorBanner error={fusions.error} action={retryAction} />
        </div>
      )
    }
    return <LoadingState />
  }
  const rows = fusions.data
  if (rows.length === 0) {
    return (
      <>
        {fusionsError && (
          <div data-testid="memory-fusion-error">
            <ErrorBanner error={fusions.error} action={retryAction} />
          </div>
        )}
        <EmptyState
          title={t('memory.fusion.empty')}
          description={t('memory.fusion.emptyDescription')}
          data-testid="memory-fusion-empty"
        />
      </>
    )
  }

  return (
    <>
      {fusionsError && (
        <div data-testid="memory-fusion-error">
          <ErrorBanner error={fusions.error} action={retryAction} />
        </div>
      )}
      <ul className="memory-fusion-list" data-testid="memory-fusion-list">
        {rows.map((f) => {
          // Prefer the agent-declared incorporated set once it lands; fall back
          // to the originally selected memory count while the run is settling.
          const n = f.incorporatedMemoryIds?.length ?? f.memoryIds.length
          return (
            <li key={f.id}>
              <Link
                to="/fusions/$id"
                params={{ id: f.id }}
                className="memory-fusion-row"
                data-testid={`memory-fusion-row-${f.id}`}
              >
                <span className="memory-fusion-row__skill">{f.skillName}</span>
                <span className="memory-fusion-row__sub muted">
                  {t('memory.fusion.subtitle', { n })}
                </span>
              </Link>
            </li>
          )
        })}
      </ul>
    </>
  )
}

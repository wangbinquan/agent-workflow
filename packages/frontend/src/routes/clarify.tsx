// /clarify — RFC-023 PR-C T22.
//
// Global Clarify inbox. Three-way segmented filter (awaiting / answered / all),
// grouped by task. Each row links to /clarify/$nodeRunId for the detail
// page. Polling every 10s mirrors the Reviews inbox so the badge count and
// the list stay rough-time-in-sync without a WS dep here.
//
// Layout mirrors /reviews: same `.page__hint`, accessible `.tabs` tab bar,
// per-task `.reviews-group` section with a `.data-table` body and a
// per-row "Open" button + status chip. The two inbox pages stay visually
// uniform so users don't context-switch between them.

import { useQuery } from '@tanstack/react-query'
import { Link, createRoute } from '@tanstack/react-router'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ClarifySessionStatus, ClarifySessionSummary } from '@agent-workflow/shared'
import { api } from '@/api/client'
import { Route as RootRoute } from './__root'

export const Route = createRoute({
  getParentRoute: () => RootRoute,
  path: '/clarify',
  component: ClarifyListPage,
})

const FILTERS: ReadonlyArray<'awaiting' | 'answered' | 'all'> = ['awaiting', 'answered', 'all']
type FilterKey = (typeof FILTERS)[number]

function filterToStatus(f: FilterKey): ClarifySessionStatus | 'all' {
  if (f === 'awaiting') return 'awaiting_human'
  if (f === 'answered') return 'answered'
  return 'all'
}

export function ClarifyListPage() {
  const { t } = useTranslation()
  const [filter, setFilter] = useState<FilterKey>('awaiting')

  const list = useQuery<ClarifySessionSummary[]>({
    queryKey: ['clarify', 'list', filter],
    queryFn: ({ signal }) => {
      const q = new URLSearchParams()
      q.set('status', filterToStatus(filter))
      return api.get<ClarifySessionSummary[]>(`/api/clarify?${q.toString()}`, undefined, signal)
    },
    refetchInterval: 10000,
  })

  // Group rows by task for a section-by-task layout.
  const groups = new Map<string, ClarifySessionSummary[]>()
  for (const r of list.data ?? []) {
    const g = groups.get(r.taskId)
    if (g === undefined) groups.set(r.taskId, [r])
    else g.push(r)
  }

  return (
    <div className="page" data-testid="clarify-list-page">
      <header className="page__header">
        <h1>{t('clarify.list.title')}</h1>
        <p className="page__hint">{t('clarify.list.hint')}</p>
      </header>
      <div className="tabs" role="tablist">
        {FILTERS.map((k) => (
          <button
            key={k}
            type="button"
            role="tab"
            aria-selected={filter === k}
            className={`tabs__tab ${filter === k ? 'tabs__tab--active' : ''}`}
            onClick={() => setFilter(k)}
            data-testid={`clarify-filter-${k}`}
          >
            {t(`clarify.list.filter.${k}`)}
          </button>
        ))}
      </div>
      {list.isLoading && <div className="muted">{t('common.loading')}</div>}
      {list.error !== null && list.error !== undefined && (
        <div className="error-box">{(list.error as Error).message}</div>
      )}
      {list.data !== undefined && list.data.length === 0 && (
        <div className="muted" data-testid="clarify-list-empty">
          {t('clarify.list.empty')}
        </div>
      )}
      {Array.from(groups.entries()).map(([taskId, items]) => (
        <section key={taskId} className="reviews-group" data-testid={`clarify-group-${taskId}`}>
          <h2 className="reviews-group__title">
            <Link to="/tasks/$id" params={{ id: taskId }} className="link">
              {/* RFC-037: prefer the user-supplied task name; fall back to
                  the ULID when no rows are present (defensive). */}
              {items[0]?.taskName && items[0].taskName.length > 0 ? items[0].taskName : taskId}
            </Link>
            <code className="reviews-group__id muted" title={taskId}>
              {taskId.slice(-10)}
            </code>
          </h2>
          <table className="data-table">
            <thead>
              <tr>
                <th>{t('clarify.list.colNode')}</th>
                <th>{t('reviews.colStatus')}</th>
                <th>{t('clarify.list.colIteration')}</th>
                <th>{t('clarify.list.colQuestions')}</th>
                <th>{t('clarify.list.colTime')}</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {items.map((s) => {
                // RFC-037 follow-up: prefer the user-set node title (matches
                // the review list's `title || reviewNodeId` pattern). When
                // the title equals the id (legacy snapshots) we collapse to
                // the id-only render to avoid a redundant chip underneath.
                const clarifyTitle =
                  typeof s.clarifyNodeTitle === 'string' && s.clarifyNodeTitle.length > 0
                    ? s.clarifyNodeTitle
                    : null
                const sourceTitle =
                  typeof s.sourceAgentNodeTitle === 'string' && s.sourceAgentNodeTitle.length > 0
                    ? s.sourceAgentNodeTitle
                    : null
                const hasClarifyTitle = clarifyTitle !== null && clarifyTitle !== s.clarifyNodeId
                return (
                  <tr key={s.id} data-status={s.status} data-testid={`clarify-row-${s.id}`}>
                    <td>
                      {hasClarifyTitle ? (
                        <>
                          <div className="reviews-row__title">{clarifyTitle}</div>
                          <code className="chip chip--tight reviews-row__nodeid">
                            {s.clarifyNodeId}
                          </code>
                        </>
                      ) : (
                        <code className="chip chip--tight">{s.clarifyNodeId}</code>
                      )}
                      <code className="chip chip--tight reviews-row__nodeid">
                        ← {sourceTitle ?? s.sourceAgentNodeId}
                        {s.sourceShardKey !== null && (
                          <span data-testid="clarify-row-shard"> · {s.sourceShardKey}</span>
                        )}
                      </code>
                    </td>
                    <td>
                      <span
                        className={`status-chip status-chip--${
                          s.status === 'awaiting_human' ? 'amber' : 'green'
                        }`}
                      >
                        {s.status === 'awaiting_human'
                          ? t('clarify.list.statusAwaiting')
                          : t('clarify.list.statusAnswered')}
                      </span>
                    </td>
                    <td>{s.iterationIndex}</td>
                    <td>{s.questionCount}</td>
                    <td className="muted">{new Date(s.createdAt).toLocaleString()}</td>
                    <td>
                      <Link
                        to="/clarify/$nodeRunId"
                        params={{ nodeRunId: s.clarifyNodeRunId }}
                        className="btn btn--sm"
                      >
                        {t('clarify.list.openButton')}
                      </Link>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </section>
      ))}
    </div>
  )
}

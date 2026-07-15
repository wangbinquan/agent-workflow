// /reviews — RFC-005 PR-D T26 + RFC-013 historical-version expand.
//
// Global Reviews inbox. Lists pending review items + has filter chips to
// switch between pending / all / approved / rejected / iterated views.
// Grouping is by task (per RFC Q&A D3); within a task, items keep their
// natural order coming back from the backend (which orders by node id
// stability + version recency).
//
// RFC-013: each row carries an expand toggle that opens a child region
// listing every doc_version this review has produced (v1..vN, each with
// its decision chip + "Open" link). Current version's Open goes to the
// regular detail page; historical versions' Open goes to
// `/reviews/$nodeRunId?version=<vid>`, the read-only view.

import { useQuery } from '@tanstack/react-query'
import { Link, createRoute } from '@tanstack/react-router'
import { Fragment, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { DocVersion, ReviewRoundSummary, ReviewSummary } from '@agent-workflow/shared'
import { api } from '@/api/client'
import { decisionChipKind } from '@/lib/review/decisionChip'
import { EmptyState } from '@/components/EmptyState'
import { ErrorBanner } from '@/components/ErrorBanner'
import { PageHeader } from '@/components/PageHeader'
import { Segmented } from '@/components/Segmented'
import { StatusChip } from '@/components/StatusChip'
import { TableViewport } from '@/components/TableViewport'
import { LoadingState } from '@/components/LoadingState'
import { REVIEW_ICON } from '@/components/icons/resourceIcons'
import { Route as RootRoute } from './__root'

export const Route = createRoute({
  getParentRoute: () => RootRoute,
  path: '/reviews',
  component: ReviewsListPage,
})

const FILTERS = ['pending', 'all', 'approved', 'rejected', 'iterated'] as const
type Filter = (typeof FILTERS)[number]

export function ReviewsListPage() {
  const { t } = useTranslation()
  const [filter, setFilter] = useState<Filter>('pending')
  const activeFilterRef = useRef<HTMLButtonElement | null>(null)
  const restoreFilterFocusRef = useRef(false)
  useEffect(() => {
    if (filter !== 'pending' || !restoreFilterFocusRef.current) return
    restoreFilterFocusRef.current = false
    activeFilterRef.current?.focus()
  }, [filter])
  // RFC-013: per-row expand toggles. Keyed by nodeRunId. Not persisted to
  // localStorage — page-session only; users who navigate away expect a
  // clean slate when they come back.
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const toggleRow = (id: string): void => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }
  const list = useQuery<ReviewSummary[]>({
    queryKey: ['reviews', 'list', filter],
    queryFn: ({ signal }) => api.get(`/api/reviews?status=${filter}`, undefined, signal),
    refetchInterval: 10000,
  })

  // Group by task. RFC-037: capture both workflowName (kept as muted
  // breadcrumb) and taskName (the new primary heading).
  const groups = new Map<
    string,
    { workflowName: string; taskName: string; items: ReviewSummary[] }
  >()
  for (const r of list.data ?? []) {
    const g = groups.get(r.taskId)
    if (g === undefined) {
      groups.set(r.taskId, {
        workflowName: r.workflowName,
        taskName: r.taskName,
        items: [r],
      })
    } else {
      g.items.push(r)
    }
  }

  return (
    <div className="page">
      <PageHeader title={t('reviews.title')} />
      <div className="page-filter">
        <Segmented<Filter>
          options={FILTERS.map((k) => ({
            value: k,
            label: t(`reviews.filter${k.charAt(0).toUpperCase()}${k.slice(1)}` as const),
            testid: `reviews-filter-${k}`,
          }))}
          value={filter}
          onChange={setFilter}
          ariaLabel={t('reviews.title')}
          testidPrefix="reviews-filter"
          activeOptionRef={activeFilterRef}
        />
      </div>
      {list.isLoading && <LoadingState data-testid="reviews-loading" />}
      {list.error !== null && list.error !== undefined && (
        <ErrorBanner
          error={list.error}
          action={
            <button
              type="button"
              className="btn btn--sm"
              onClick={() => {
                void list.refetch()
              }}
            >
              {t('common.retry')}
            </button>
          }
        />
      )}
      {list.data !== undefined && list.data.length === 0 && (
        <EmptyState
          title={t('reviews.emptyList')}
          description={filter === 'pending' ? t('reviews.emptyDescription') : undefined}
          icon={filter === 'pending' ? REVIEW_ICON : undefined}
          size={filter === 'pending' ? 'comfortable' : 'compact'}
          action={
            filter === 'pending' ? (
              <Link to="/tasks/new" className="btn btn--primary" data-testid="reviews-new-task">
                {t('tasks.newButton')}
              </Link>
            ) : (
              <button
                type="button"
                className="btn btn--sm"
                onClick={() => {
                  restoreFilterFocusRef.current = true
                  setFilter('pending')
                }}
              >
                {t('common.clearFilters')}
              </button>
            )
          }
          data-testid="reviews-empty"
        />
      )}
      {Array.from(groups.entries()).map(([taskId, g]) => (
        <section key={taskId} className="reviews-group">
          <h2 className="reviews-group__title">
            <Link to="/tasks/$id" params={{ id: taskId }} className="link">
              {/* RFC-037: task name first, then workflow name as a muted
                  breadcrumb, then short ULID. */}
              {g.taskName.length > 0 ? g.taskName : g.workflowName}
            </Link>
            <span className="muted reviews-group__workflow">{g.workflowName}</span>
            <code className="muted reviews-group__taskid"> · {taskId}</code>
          </h2>
          <TableViewport
            label={`${t('reviews.title')} — ${g.taskName.length > 0 ? g.taskName : g.workflowName}`}
            minWidth="md"
          >
            <table className="data-table">
              <thead>
                <tr>
                  <th aria-label={t('reviews.expand')}></th>
                  <th>{t('reviews.colNode')}</th>
                  <th>{t('reviews.colStatus')}</th>
                  <th>{t('reviews.colVersion')}</th>
                  <th>{t('reviews.colCreated')}</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {g.items.map((r) => {
                  const hasTitle = r.title !== '' && r.title !== r.reviewNodeId
                  const isOpen = expanded.has(r.nodeRunId)
                  return (
                    <Fragment key={r.nodeRunId}>
                      <tr>
                        <td className="reviews-row__expand-cell">
                          <button
                            type="button"
                            className="reviews-row__expand"
                            aria-expanded={isOpen}
                            aria-label={isOpen ? t('reviews.collapse') : t('reviews.expand')}
                            onClick={() => toggleRow(r.nodeRunId)}
                          >
                            <span aria-hidden="true" className="reviews-row__expand-icon">
                              {isOpen ? '▾' : '▸'}
                            </span>
                          </button>
                        </td>
                        <td>
                          {hasTitle ? (
                            <>
                              <div className="reviews-row__title">{r.title}</div>
                              <code className="chip chip--tight reviews-row__nodeid">
                                {r.reviewNodeId}
                              </code>
                            </>
                          ) : (
                            <code className="chip chip--tight">{r.reviewNodeId}</code>
                          )}
                          {r.description !== '' && r.description !== r.title && (
                            <div className="muted reviews-row__desc">{r.description}</div>
                          )}
                          {r.isMultiDoc === true && (
                            <span
                              className="chip chip--tight reviews-row__multidoc"
                              title={t('reviews.multiDoc.badge')}
                              data-testid="review-multidoc-badge"
                            >
                              {t('reviews.multiDoc.badge')}
                            </span>
                          )}
                        </td>
                        <td>
                          <StatusChip
                            kind={r.awaitingReview ? 'warn' : decisionChipKind(r.decision)}
                          >
                            {r.awaitingReview
                              ? t('reviews.statusAwaiting')
                              : t(`reviews.decision.${r.decision}`)}
                          </StatusChip>
                        </td>
                        <td>v{r.currentVersionIndex}</td>
                        <td className="muted">{formatTimestamp(r.createdAt)}</td>
                        <td>
                          <Link
                            to="/reviews/$nodeRunId"
                            params={{ nodeRunId: r.nodeRunId }}
                            search={{}}
                            className="btn btn--sm"
                          >
                            {t('reviews.openButton')}
                          </Link>
                        </td>
                      </tr>
                      {isOpen && (
                        <tr className="reviews-row__history">
                          <td colSpan={6}>
                            {/* RFC-142: 多文档评审按轮展开（第 n 轮 + 轮决策 chip），
                                单文档保持 v1..vN 版本行不变。 */}
                            {r.isMultiDoc === true ? (
                              <RoundRows nodeRunId={r.nodeRunId} />
                            ) : (
                              <HistoryRows
                                nodeRunId={r.nodeRunId}
                                currentVersionIndex={r.currentVersionIndex}
                              />
                            )}
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  )
                })}
              </tbody>
            </table>
          </TableViewport>
        </section>
      ))}
    </div>
  )
}

function formatTimestamp(ts: number): string {
  return new Date(ts).toLocaleString()
}

// RFC-013: expanded sub-row inside each review's table row. Lazily loads
// the doc_versions list for this nodeRunId (the parent list endpoint
// only carries `currentVersionIndex` — fetching all versions for every
// row up front would be N requests on a list that's usually short). The
// child renders one row per version with its decision chip and an
// "Open" link; the current version routes to the regular detail page,
// historical versions route to `?version=<vid>` for the read-only view.
export function HistoryRows({
  nodeRunId,
  currentVersionIndex,
}: {
  nodeRunId: string
  currentVersionIndex: number
}) {
  const { t } = useTranslation()
  const q = useQuery<DocVersion[]>({
    queryKey: ['reviews', 'versions', nodeRunId],
    queryFn: ({ signal }) => api.get(`/api/reviews/${nodeRunId}/versions`, undefined, signal),
  })
  if (q.isLoading) {
    return (
      <div className="reviews-version-loading">
        <LoadingState size="compact" />
      </div>
    )
  }
  if (q.error !== null && q.error !== undefined) {
    return (
      <div className="reviews-version-error" role="alert">
        <span>{t('reviews.loadVersionsFailed')}</span>
        <button
          type="button"
          className="btn btn--sm"
          onClick={() => {
            void q.refetch()
          }}
        >
          {t('reviews.retry')}
        </button>
      </div>
    )
  }
  // Render in ascending version order (v1 first → vN last) so the
  // history reads chronologically. The endpoint returns desc-by-versionIndex.
  const sorted = [...(q.data ?? [])].sort((a, b) => a.versionIndex - b.versionIndex)
  return (
    <div className="reviews-version-panel">
      <div className="reviews-version-panel__header">
        {t('reviews.historyHeader', { count: sorted.length })}
      </div>
      <ul className="reviews-version-list">
        {sorted.map((v) => {
          const isCurrent = v.versionIndex === currentVersionIndex
          return (
            <li key={v.id} className="reviews-version-list__item">
              <span className="reviews-version-list__label">v{v.versionIndex}</span>
              <StatusChip kind={decisionChipKind(v.decision)}>
                {t(`reviews.decision.${v.decision}`)}
              </StatusChip>
              {isCurrent && (
                <span className="reviews-version-list__current-pill">
                  {t('reviews.currentTag')}
                </span>
              )}
              <span className="reviews-version-list__date">{formatTimestamp(v.createdAt)}</span>
              <Link
                to="/reviews/$nodeRunId"
                params={{ nodeRunId }}
                search={isCurrent ? {} : { version: v.id }}
                className="reviews-version-list__open"
              >
                {t('reviews.openButton')}
                <span aria-hidden="true"> ›</span>
              </Link>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

// RFC-142: multi-document reviews expand by ROUND instead of the flat
// doc_versions list — versionIndex is per-item there (v1,v1,v1,v2,…), so the
// version rows carried no round information. One row per round with its
// 1-based ordinal, round decision chip, member count and decision time; the
// current round's Open goes to the interactive view (empty search),
// historical rounds go to `?round=<roundKey>` (read-only MultiDocReviewView).
export function RoundRows({ nodeRunId }: { nodeRunId: string }) {
  const { t } = useTranslation()
  const q = useQuery<ReviewRoundSummary[]>({
    queryKey: ['reviews', 'rounds', nodeRunId],
    queryFn: ({ signal }) => api.get(`/api/reviews/${nodeRunId}/rounds`, undefined, signal),
  })
  if (q.isLoading) {
    return (
      <div className="reviews-version-loading">
        <LoadingState size="compact" />
      </div>
    )
  }
  if (q.error !== null && q.error !== undefined) {
    return (
      <div className="reviews-version-error" role="alert">
        <span>{t('reviews.loadVersionsFailed')}</span>
        <button
          type="button"
          className="btn btn--sm"
          onClick={() => {
            void q.refetch()
          }}
        >
          {t('reviews.retry')}
        </button>
      </div>
    )
  }
  const rounds = q.data ?? []
  return (
    <div className="reviews-version-panel">
      <div className="reviews-version-panel__header">
        {t('reviews.roundHistoryHeader', { count: rounds.length })}
      </div>
      <ul className="reviews-version-list">
        {rounds.map((r, i) => (
          <li key={r.roundKey} className="reviews-version-list__item">
            <span className="reviews-version-list__label">
              {t('reviews.roundLabel', { n: i + 1 })}
            </span>
            <StatusChip kind={decisionChipKind(r.decision)}>
              {t(`reviews.decision.${r.decision}`)}
            </StatusChip>
            {r.isCurrent && (
              <span className="reviews-version-list__current-pill">{t('reviews.currentTag')}</span>
            )}
            <span className="muted">{t('reviews.roundDocCount', { count: r.members.length })}</span>
            <span className="reviews-version-list__date">
              {formatTimestamp(r.decidedAt ?? r.createdAt)}
            </span>
            <Link
              to="/reviews/$nodeRunId"
              params={{ nodeRunId }}
              search={r.isCurrent ? {} : { round: r.roundKey }}
              className="reviews-version-list__open"
            >
              {t('reviews.openButton')}
              <span aria-hidden="true"> ›</span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  )
}

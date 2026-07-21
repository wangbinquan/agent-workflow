// /clarify — RFC-023 PR-C T22.
//
// Global Clarify inbox. Three-way segmented filter (awaiting / answered / all),
// grouped by task. Each row links to /clarify/$nodeRunId for the detail
// page. Polling every 10s mirrors the Reviews inbox so the badge count and
// the list stay rough-time-in-sync without a WS dep here.
//
// Layout mirrors /reviews: same accessible segmented filter,
// per-task `.reviews-group` section with a `.data-table` body and a
// per-row "Open" button + status chip. The two inbox pages stay visually
// uniform so users don't context-switch between them.

import { useQuery } from '@tanstack/react-query'
import { Link, createRoute } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ClarifyRoundSummary } from '@agent-workflow/shared'
import { api } from '@/api/client'
import { EmptyState } from '@/components/EmptyState'
import { ErrorBanner } from '@/components/ErrorBanner'
import { LoadingState } from '@/components/LoadingState'
import { PageHeader } from '@/components/PageHeader'
import { Segmented } from '@/components/Segmented'
import { StatusChip } from '@/components/StatusChip'
import { TableViewport } from '@/components/TableViewport'
import { CLARIFY_ICON } from '@/components/icons/resourceIcons'
import { clarifyRoundStatusChip } from '@/lib/clarify-status'
import { Route as RootRoute } from './__root'

export const Route = createRoute({
  getParentRoute: () => RootRoute,
  path: '/clarify',
  component: ClarifyListPage,
})

const FILTERS: ReadonlyArray<'awaiting' | 'answered' | 'all'> = ['awaiting', 'answered', 'all']
type FilterKey = (typeof FILTERS)[number]

function filterToStatus(
  f: FilterKey,
): 'awaiting_human' | 'answered' | 'canceled' | 'abandoned' | 'all' {
  if (f === 'awaiting') return 'awaiting_human'
  if (f === 'answered') return 'answered'
  return 'all'
}

/** RFC-058: render one inbox row branching on ClarifyRoundSummary.kind.
 *  Self-clarify keeps the RFC-023 row shape (chips, asking-node arrow,
 *  shard key); cross-clarify renders the questioner → designer
 *  relationship with the same visual chrome. The `kind` chip on the left
 *  differentiates them. */
function renderRow(entry: ClarifyRoundSummary, t: (key: string) => string): React.ReactElement {
  const kind: 'self' | 'cross' = entry.kind
  const kindChipLabel =
    kind === 'cross' ? t('clarify.list.chip.cross') : t('clarify.list.chip.self')
  const kindChipClass = 'chip chip--tight'

  if (kind === 'self') {
    const s = entry
    const clarifyTitle =
      typeof s.intermediaryNodeTitle === 'string' && s.intermediaryNodeTitle.length > 0
        ? s.intermediaryNodeTitle
        : null
    const askingTitle =
      typeof s.askingNodeTitle === 'string' && s.askingNodeTitle.length > 0
        ? s.askingNodeTitle
        : null
    const hasClarifyTitle = clarifyTitle !== null && clarifyTitle !== s.intermediaryNodeId
    return (
      <tr key={s.id} data-status={s.status} data-kind="self" data-testid={`clarify-row-${s.id}`}>
        <td>
          <span className={kindChipClass} data-testid={`clarify-row-kind-${s.id}`}>
            {kindChipLabel}
          </span>{' '}
          {hasClarifyTitle ? (
            <>
              <div className="reviews-row__title">{clarifyTitle}</div>
              <code className="chip chip--tight reviews-row__nodeid">{s.intermediaryNodeId}</code>
            </>
          ) : (
            <code className="chip chip--tight">{s.intermediaryNodeId}</code>
          )}
          <code className="chip chip--tight reviews-row__nodeid">
            ← {askingTitle ?? s.askingNodeId}
            {s.askingShardKey !== null && (
              <span data-testid="clarify-row-shard"> · {s.askingShardKey}</span>
            )}
          </code>
        </td>
        <td>
          <StatusChip kind={clarifyRoundStatusChip(s.status).kind}>
            {t(clarifyRoundStatusChip(s.status).labelKey)}
          </StatusChip>
        </td>
        <td>{s.iteration}</td>
        <td>{s.questionCount}</td>
        <td className="muted">{new Date(s.createdAt).toLocaleString()}</td>
        <td>
          <Link
            to="/clarify/$nodeRunId"
            params={{ nodeRunId: s.intermediaryNodeRunId }}
            className="btn btn--sm"
          >
            {t('clarify.list.openButton')}
          </Link>
        </td>
      </tr>
    )
  }
  // RFC-058 cross-clarify row.
  const cross = entry
  return (
    <tr
      key={cross.id}
      data-status={cross.status}
      data-kind="cross"
      data-testid={`clarify-row-${cross.id}`}
    >
      <td>
        <span className={kindChipClass} data-testid={`clarify-row-kind-${cross.id}`}>
          {kindChipLabel}
        </span>{' '}
        <code className="chip chip--tight">{cross.intermediaryNodeId}</code>
        <code className="chip chip--tight reviews-row__nodeid">
          ← {cross.askingNodeId}
          {cross.targetConsumerNodeId !== null && (
            <span data-testid="clarify-row-designer"> → {cross.targetConsumerNodeId}</span>
          )}
        </code>
      </td>
      <td>
        <StatusChip kind={clarifyRoundStatusChip(cross.status).kind}>
          {t(clarifyRoundStatusChip(cross.status).labelKey)}
        </StatusChip>
      </td>
      <td>{cross.iteration}</td>
      <td>{cross.questionCount}</td>
      <td className="muted">{new Date(cross.createdAt).toLocaleString()}</td>
      <td>
        <Link
          to="/clarify/$nodeRunId"
          params={{ nodeRunId: cross.intermediaryNodeRunId }}
          className="btn btn--sm"
        >
          {t('clarify.list.openButton')}
        </Link>
      </td>
    </tr>
  )
}

export function ClarifyListPage() {
  const { t } = useTranslation()
  const [filter, setFilter] = useState<FilterKey>('awaiting')
  const activeFilterRef = useRef<HTMLButtonElement | null>(null)
  const restoreFilterFocusRef = useRef(false)
  useEffect(() => {
    if (filter !== 'awaiting' || !restoreFilterFocusRef.current) return
    restoreFilterFocusRef.current = false
    activeFilterRef.current?.focus()
  }, [filter])

  const list = useQuery<ClarifyRoundSummary[]>({
    queryKey: ['clarify', 'list', filter],
    queryFn: ({ signal }) => {
      const q = new URLSearchParams()
      q.set('status', filterToStatus(filter))
      return api.get<ClarifyRoundSummary[]>(`/api/clarify?${q.toString()}`, undefined, signal)
    },
    refetchInterval: 10000,
  })

  // Group rows by task for a section-by-task layout.
  const groups = new Map<string, ClarifyRoundSummary[]>()
  for (const r of list.data ?? []) {
    const g = groups.get(r.taskId)
    if (g === undefined) groups.set(r.taskId, [r])
    else g.push(r)
  }

  return (
    <div className="page" data-testid="clarify-list-page">
      <PageHeader title={t('clarify.list.title')} />
      <div className="page-filter">
        <Segmented<FilterKey>
          options={FILTERS.map((k) => ({
            value: k,
            label: t(`clarify.list.filter.${k}`),
            testid: `clarify-filter-${k}`,
          }))}
          value={filter}
          onChange={setFilter}
          ariaLabel={t('clarify.list.title')}
          testidPrefix="clarify-filter"
          activeOptionRef={activeFilterRef}
        />
      </div>
      {list.isLoading && <LoadingState />}
      {list.error !== null && list.error !== undefined && (
        <ErrorBanner error={list.error} onRetry={() => void list.refetch()} />
      )}
      {list.data !== undefined && list.data.length === 0 && (
        <EmptyState
          title={t('clarify.list.empty')}
          description={filter === 'awaiting' ? t('clarify.list.emptyDescription') : undefined}
          icon={filter === 'awaiting' ? CLARIFY_ICON : undefined}
          size={filter === 'awaiting' ? 'comfortable' : 'compact'}
          action={
            filter === 'awaiting' ? (
              <Link to="/tasks/new" className="btn btn--primary" data-testid="clarify-new-task">
                {t('tasks.newButton')}
              </Link>
            ) : (
              <button
                type="button"
                className="btn btn--sm"
                onClick={() => {
                  restoreFilterFocusRef.current = true
                  setFilter('awaiting')
                }}
              >
                {t('common.clearFilters')}
              </button>
            )
          }
          data-testid="clarify-list-empty"
        />
      )}
      {Array.from(groups.entries()).map(([taskId, items]) => (
        <section key={taskId} className="reviews-group" data-testid={`clarify-group-${taskId}`}>
          <h2 className="reviews-group__title">
            <Link to="/tasks/$id" params={{ id: taskId }} className="link">
              {/* RFC-037: prefer the user-supplied task name; fall back to
                  the ULID when no rows carry one. RFC-056 cross-clarify
                  summaries also expose taskName, so the union type still
                  resolves uniformly here. */}
              {items[0]?.taskName && items[0].taskName.length > 0 ? items[0].taskName : taskId}
            </Link>
            <code className="reviews-group__id muted" title={taskId}>
              {taskId.slice(-10)}
            </code>
          </h2>
          <TableViewport
            label={`${t('clarify.list.title')} — ${items[0]?.taskName && items[0].taskName.length > 0 ? items[0].taskName : taskId}`}
            minWidth="md"
          >
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
              <tbody>{items.map((s) => renderRow(s, t))}</tbody>
            </table>
          </TableViewport>
        </section>
      ))}
    </div>
  )
}

// /clarify — RFC-023 PR-C T22.
//
// Global Clarify inbox. Three-way segmented filter (awaiting / answered / all),
// grouped by task. Each row links to /clarify/$nodeRunId for the detail
// page. Polling every 10s mirrors the Reviews inbox so the badge count and
// the list stay rough-time-in-sync without a WS dep here.

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
  const [taskFilter, setTaskFilter] = useState<string>('')

  const list = useQuery<ClarifySessionSummary[]>({
    queryKey: ['clarify', 'list', filter, taskFilter],
    queryFn: ({ signal }) => {
      const q = new URLSearchParams()
      q.set('status', filterToStatus(filter))
      if (taskFilter.length > 0) q.set('taskId', taskFilter)
      return api.get<ClarifySessionSummary[]>(`/api/clarify?${q.toString()}`, undefined, signal)
    },
    refetchInterval: 10000,
  })

  // Build a stable set of taskIds for the filter dropdown — derived from the
  // currently-loaded rows so options only show tasks that actually have at
  // least one clarify session of the currently-selected status.
  const taskIds: string[] = []
  const seenTask = new Set<string>()
  for (const r of list.data ?? []) {
    if (!seenTask.has(r.taskId)) {
      seenTask.add(r.taskId)
      taskIds.push(r.taskId)
    }
  }

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
        <div style={{ marginLeft: 'auto' }}>
          <label className="muted" htmlFor="clarify-task-filter">
            {t('clarify.list.taskFilterLabel')}{' '}
          </label>
          <select
            id="clarify-task-filter"
            className="form-input"
            value={taskFilter}
            onChange={(e) => setTaskFilter(e.target.value)}
            style={{ minWidth: 240 }}
          >
            <option value="">{t('clarify.list.taskFilterAll')}</option>
            {taskIds.map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </select>
        </div>
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
              {taskId}
            </Link>
          </h2>
          <ul className="reviews-group__items">
            {items.map((s) => (
              <li
                key={s.id}
                className="reviews-group__item"
                data-status={s.status}
                data-testid={`clarify-row-${s.id}`}
              >
                <Link to="/clarify/$nodeRunId" params={{ nodeRunId: s.clarifyNodeRunId }}>
                  <div>
                    <strong>{s.clarifyNodeId}</strong>
                    <span className="muted" style={{ marginLeft: 8 }}>
                      ← {s.sourceAgentNodeId}
                      {s.sourceShardKey !== null && (
                        <span data-testid="clarify-row-shard"> · {s.sourceShardKey}</span>
                      )}
                    </span>
                  </div>
                  <div className="muted" style={{ fontSize: 12 }}>
                    {t('clarify.list.colIteration')} {s.iterationIndex} ·{' '}
                    {t('clarify.list.colQuestions')} {s.questionCount} · {t('clarify.list.colTime')}{' '}
                    {new Date(s.createdAt).toLocaleString()}
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  )
}

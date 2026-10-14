// RFC-371 v2 §6 — tasks created in the window with their lifetime consumption,
// filtered by keyword and status and paged by a server cursor.
import { useEffect, useState } from 'react'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { TASK_STATUS, type TaskStatus } from '@agent-workflow/shared'
import { EmptyState } from '@/components/EmptyState'
import { ErrorBanner } from '@/components/ErrorBanner'
import { FilterBar, FilterField } from '@/components/FilterBar'
import { TextInput } from '@/components/Form'
import { LoadingState } from '@/components/LoadingState'
import { Select } from '@/components/Select'
import { TableViewport } from '@/components/TableViewport'
import { TaskStatusChip } from '@/components/TaskStatusChip'
import { OBSERVATION_QUERY, observationApi, type ObservationWindow } from './observationClient'
import { durationLabel, formatCount } from './observationFormat'
import { UsageCells, UsageHeaderCells } from './ObservationUsage'

const SEARCH_DELAY_MS = 400

export interface ObservationTaskFilter {
  readonly q?: string
  readonly status?: TaskStatus
}

export function ObservationTasksPanel(props: {
  window: ObservationWindow
  filter: ObservationTaskFilter
  /** Cursor of each page opened so far; the last one is the current page. */
  cursors: readonly (string | undefined)[]
  onFilter: (filter: ObservationTaskFilter) => void
  onCursors: (cursors: readonly (string | undefined)[]) => void
  onOpenTask: (taskId: string) => void
}) {
  const { t, i18n } = useTranslation()
  const [text, setText] = useState(props.filter.q ?? '')
  const { filter, onFilter } = props
  useEffect(() => {
    const next = text.trim() || undefined
    if (next === filter.q) return
    const timer = setTimeout(() => onFilter({ ...filter, q: next }), SEARCH_DELAY_MS)
    return () => clearTimeout(timer)
  }, [text, filter, onFilter])
  const cursor = props.cursors.at(-1)
  const query = useQuery({
    queryKey: [...OBSERVATION_QUERY, 'tasks', props.window, filter.q, filter.status, cursor],
    queryFn: ({ signal }) =>
      observationApi.tasks(props.window, { ...filter, ...(cursor ? { cursor } : {}) }, signal),
    placeholderData: keepPreviousData,
  })
  const date = (at: number) => new Date(at).toLocaleString(i18n.language)
  return (
    <div className="stack--md">
      <p className="muted">{t('runObservability.tasksHint')}</p>
      <FilterBar ariaLabel={t('runObservability.tabTasks')}>
        <FilterField label={t('runObservability.searchLabel')}>
          <TextInput
            value={text}
            onChange={setText}
            placeholder={t('runObservability.searchPlaceholder')}
            aria-label={t('runObservability.searchLabel')}
          />
        </FilterField>
        <FilterField label={t('runObservability.statusLabel')}>
          <Select<TaskStatus | 'all'>
            value={filter.status ?? 'all'}
            ariaLabel={t('runObservability.statusLabel')}
            options={[
              { value: 'all', label: t('runObservability.statusAll') },
              ...TASK_STATUS.map((status) => ({
                value: status,
                label: t(`tasks.status.${status}`),
              })),
            ]}
            onChange={(value) =>
              onFilter({ ...filter, ...{ status: value === 'all' ? undefined : value } })
            }
          />
        </FilterField>
      </FilterBar>
      {query.isLoading ? (
        <LoadingState />
      ) : query.error ? (
        <ErrorBanner error={query.error} onRetry={() => void query.refetch()} />
      ) : !query.data || query.data.items.length === 0 ? (
        <EmptyState title={t('runObservability.tasksEmpty')} />
      ) : (
        <>
          <TableViewport label={t('runObservability.tabTasks')} minWidth="lg">
            <table
              className="data-table data-table--compact"
              aria-label={t('runObservability.tabTasks')}
            >
              <thead>
                <tr>
                  <th scope="col">{t('runObservability.colTask')}</th>
                  <th scope="col">{t('runObservability.colStatus')}</th>
                  <th scope="col">{t('runObservability.colStarted')}</th>
                  <th scope="col" className="observability__num">
                    {t('runObservability.colDuration')}
                  </th>
                  <th scope="col" className="observability__num">
                    {t('runObservability.colCalls')}
                  </th>
                  <UsageHeaderCells />
                </tr>
              </thead>
              <tbody>
                {query.data.items.map((row) => (
                  <tr key={row.taskId}>
                    <th scope="row">
                      <button
                        type="button"
                        className="btn btn--ghost btn--sm"
                        aria-label={t('runObservability.open', { name: row.name })}
                        onClick={() => props.onOpenTask(row.taskId)}
                      >
                        {row.name}
                      </button>
                    </th>
                    <td>
                      <TaskStatusChip status={row.status} />
                    </td>
                    <td>{date(row.startedAt)}</td>
                    <td className="observability__num">
                      {durationLabel(
                        row.finishedAt === null ? null : row.finishedAt - row.startedAt,
                        t,
                      )}
                    </td>
                    <td className="observability__num">
                      {formatCount(row.usage.calls, i18n.language)}
                    </td>
                    <UsageCells usage={row.usage} />
                  </tr>
                ))}
              </tbody>
            </table>
          </TableViewport>
          <CursorPager
            hasPrevious={props.cursors.length > 1}
            nextCursor={query.data.nextCursor}
            busy={query.isFetching}
            onPrevious={() => props.onCursors(props.cursors.slice(0, -1))}
            onNext={(next) => props.onCursors([...props.cursors, next])}
          />
        </>
      )}
    </div>
  )
}

/** Previous / next over a server keyset cursor. */
export function CursorPager(props: {
  hasPrevious: boolean
  nextCursor: string | null
  busy: boolean
  onPrevious: () => void
  onNext: (cursor: string) => void
}) {
  const { t } = useTranslation()
  if (!props.hasPrevious && props.nextCursor === null) return null
  return (
    <nav className="observability__pager" aria-label={t('common.pagination.aria')}>
      <button
        type="button"
        className="btn btn--sm"
        disabled={!props.hasPrevious || props.busy}
        onClick={props.onPrevious}
      >
        {t('common.pagination.prev')}
      </button>
      <button
        type="button"
        className="btn btn--sm"
        disabled={props.nextCursor === null || props.busy}
        onClick={() => props.nextCursor !== null && props.onNext(props.nextCursor)}
      >
        {t('common.pagination.next')}
      </button>
    </nav>
  )
}

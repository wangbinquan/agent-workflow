// RFC-159 — scheduled-task management list.
import type { ScheduledTask } from '@agent-workflow/shared'
import { useQuery } from '@tanstack/react-query'
import { createRoute, useNavigate } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'

import { api } from '@/api/client'
import { EmptyState } from '@/components/EmptyState'
import { ErrorBanner } from '@/components/ErrorBanner'
import { LoadingState } from '@/components/LoadingState'
import { StatusChip } from '@/components/StatusChip'
import { useScheduledTaskWs } from '@/hooks/useScheduledTaskWs'
import { scheduleSummary } from '@/lib/schedule-view'
import { Route as RootRoute } from './__root'

export const Route = createRoute({
  getParentRoute: () => RootRoute,
  path: '/scheduled',
  component: ScheduledPage,
})

function ScheduledPage() {
  const { t, i18n } = useTranslation()
  const navigate = useNavigate()
  const lang = i18n.language.startsWith('zh') ? 'zh' : 'en'
  useScheduledTaskWs()

  const { data, isLoading, error } = useQuery<ScheduledTask[]>({
    queryKey: ['scheduled-tasks', 'list'],
    queryFn: ({ signal }) => api.get('/api/scheduled-tasks', undefined, signal),
    refetchInterval: 30_000,
  })

  return (
    <div className="page">
      <header className="page__header page__header--row">
        <div>
          <h1>{t('scheduled.title')}</h1>
        </div>
        <div className="page__actions">
          <button
            type="button"
            className="btn btn--primary"
            onClick={() => void navigate({ to: '/tasks/new', search: { schedule: true } })}
            data-testid="scheduled-new"
          >
            {t('scheduled.new')}
          </button>
        </div>
      </header>

      {isLoading && <LoadingState data-testid="scheduled-loading" />}
      {error !== null && error !== undefined && <ErrorBanner error={error} />}
      {!isLoading && data !== undefined && data.length === 0 && (
        <EmptyState title={t('scheduled.empty')} data-testid="scheduled-empty" />
      )}
      {data !== undefined && data.length > 0 && (
        <table className="data-table">
          <thead>
            <tr>
              <th>{t('scheduled.colName')}</th>
              <th>{t('scheduled.colSchedule')}</th>
              <th>{t('scheduled.colNext')}</th>
              <th>{t('scheduled.colStatus')}</th>
              <th>{t('scheduled.colEnabled')}</th>
            </tr>
          </thead>
          <tbody>
            {data.map((row) => (
              <tr
                key={row.id}
                className="data-table__row"
                onClick={() => void navigate({ to: '/scheduled/$id', params: { id: row.id } })}
                data-testid={`scheduled-row-${row.id}`}
              >
                <td>{row.name}</td>
                <td>{scheduleSummary(row.scheduleSpec, lang)}</td>
                <td>
                  {row.enabled && row.nextRunAt != null
                    ? new Date(row.nextRunAt).toLocaleString(undefined, {
                        dateStyle: 'short',
                        timeStyle: 'short',
                      })
                    : '—'}
                </td>
                <td>
                  {row.lastStatus == null ? (
                    <span className="muted">{t('scheduled.lastNever')}</span>
                  ) : (
                    <StatusChip kind={row.lastStatus === 'failed' ? 'danger' : 'success'}>
                      {t(`scheduled.last_${row.lastStatus}`)}
                    </StatusChip>
                  )}
                </td>
                <td>{row.enabled ? t('scheduled.enabledYes') : t('scheduled.enabledNo')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

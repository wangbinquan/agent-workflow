// RFC-159 — scheduled-task detail: config + last outcome + run history + actions.
import type { ScheduledTask, TaskSummary } from '@agent-workflow/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createRoute, Link, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { api, type ApiError } from '@/api/client'
import { ConfirmButton } from '@/components/ConfirmButton'
import { EmptyState } from '@/components/EmptyState'
import { ErrorBanner } from '@/components/ErrorBanner'
import { LoadingState } from '@/components/LoadingState'
import { NoticeBanner } from '@/components/NoticeBanner'
import { PageHeader } from '@/components/PageHeader'
import { ScheduleDialog } from '@/components/ScheduleDialog'
import { StatusChip } from '@/components/StatusChip'
import { TableViewport } from '@/components/TableViewport'
import { TaskStatusChip } from '@/components/TaskStatusChip'
import { useScheduledTaskWs } from '@/hooks/useScheduledTaskWs'
import { scheduleSummary } from '@/lib/schedule-view'
import { Route as RootRoute } from './__root'

export const Route = createRoute({
  getParentRoute: () => RootRoute,
  path: '/scheduled/$id',
  component: ScheduledDetailPage,
})

function ScheduledDetailPage() {
  const { id } = Route.useParams()
  const { t, i18n } = useTranslation()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const lang = i18n.language.startsWith('zh') ? 'zh' : 'en'
  const [editOpen, setEditOpen] = useState(false)
  useScheduledTaskWs()

  const detailQ = useQuery<ScheduledTask, ApiError>({
    queryKey: ['scheduled-tasks', 'detail', id],
    queryFn: ({ signal }) =>
      api.get(`/api/scheduled-tasks/${encodeURIComponent(id)}`, undefined, signal),
    refetchInterval: 30_000,
  })
  const historyQ = useQuery<TaskSummary[]>({
    queryKey: ['scheduled-tasks', 'history', id],
    queryFn: ({ signal }) => api.get('/api/tasks', { scheduledTaskId: id }, signal),
    refetchInterval: 30_000,
  })

  const invalidate = () => void qc.invalidateQueries({ queryKey: ['scheduled-tasks'] })
  const toggle = useMutation<ScheduledTask, ApiError, boolean>({
    mutationFn: (enabled) => api.put(`/api/scheduled-tasks/${encodeURIComponent(id)}`, { enabled }),
    onSuccess: invalidate,
  })
  const del = useMutation<void, ApiError>({
    mutationFn: () => api.delete(`/api/scheduled-tasks/${encodeURIComponent(id)}`),
    onSuccess: () => {
      invalidate()
      void navigate({ to: '/scheduled' })
    },
  })
  const runNow = useMutation<{ taskId: string }, ApiError>({
    mutationFn: () => api.post(`/api/scheduled-tasks/${encodeURIComponent(id)}/run-now`, {}),
    onSuccess: ({ taskId }) => {
      invalidate()
      void navigate({ to: '/tasks/$id', params: { id: taskId } })
    },
  })

  if (detailQ.data === undefined && detailQ.isLoading) {
    return (
      <div className="page">
        <PageHeader title={id} />
        <LoadingState />
      </div>
    )
  }
  if (detailQ.data === undefined && detailQ.error != null) {
    return (
      <div className="page">
        <PageHeader title={id} />
        <ErrorBanner
          error={detailQ.error}
          action={
            <button type="button" className="btn btn--sm" onClick={() => void detailQ.refetch()}>
              {t('common.retry')}
            </button>
          }
        />
      </div>
    )
  }
  const s = detailQ.data
  if (s === undefined) return null

  return (
    <div className="page" data-testid="scheduled-detail">
      <PageHeader
        title={s.name}
        meta={scheduleSummary(s.scheduleSpec, lang)}
        actions={
          <>
            <button
              type="button"
              className="btn"
              onClick={() => setEditOpen(true)}
              data-testid="scheduled-edit"
            >
              {t('scheduled.edit')}
            </button>
            {/* RFC-159 → RFC-165: edit the FULL task config (any launch kind) in
              the /tasks/new wizard's editScheduled mode. A degraded payload
              still gets the entry — the wizard renders blank for repair and
              saving PUTs a full replacement payload. */}
            <Link
              to="/tasks/new"
              search={{ editScheduled: s.id }}
              className="btn"
              data-testid="scheduled-edit-config"
            >
              {t('scheduled.editConfig')}
            </Link>
            <button
              type="button"
              className="btn"
              disabled={toggle.isPending}
              onClick={() => toggle.mutate(!s.enabled)}
              data-testid="scheduled-toggle"
            >
              {s.enabled ? t('scheduled.disable') : t('scheduled.enable')}
            </button>
            <button
              type="button"
              className="btn btn--primary"
              disabled={runNow.isPending}
              onClick={() => runNow.mutate()}
              data-testid="scheduled-run-now"
            >
              {t('scheduled.runNow')}
            </button>
            <ConfirmButton
              label={t('scheduled.delete')}
              confirmLabel={t('scheduled.deleteConfirm')}
              onConfirm={() => del.mutateAsync()}
              variant="danger"
              disabled={del.isPending}
            />
          </>
        }
      />

      {detailQ.error != null && (
        <ErrorBanner
          error={detailQ.error}
          action={
            <button type="button" className="btn btn--sm" onClick={() => void detailQ.refetch()}>
              {t('common.retry')}
            </button>
          }
        />
      )}

      {/* RFC-165: degraded/legacy rows surface the repair guidance + the
          per-field parse reason so the user knows WHAT to fix. */}
      {(s.launchPayload === null || s.scheduleSpec === null) && (
        <NoticeBanner tone="warning" size="compact" className="info-box--muted">
          <div data-testid="scheduled-degraded-banner">
            <div>{t('scheduled.degradedBanner')}</div>
            {s.migrationError?.launchPayload != null && (
              <div className="muted">{s.migrationError.launchPayload}</div>
            )}
            {s.migrationError?.scheduleSpec != null && (
              <div className="muted">{s.migrationError.scheduleSpec}</div>
            )}
          </div>
        </NoticeBanner>
      )}

      {/* Mutation errors render on their own row below the header — never squeezed
          into the top-right action cluster (mirrors DetailHeaderActions). */}
      {runNow.error != null && (
        <div data-testid="scheduled-run-now-error">
          <ErrorBanner error={runNow.error} />
        </div>
      )}
      {toggle.error != null && <ErrorBanner error={toggle.error} />}
      {del.error != null && <ErrorBanner error={del.error} />}

      <section className="page__section">
        <dl className="detail-grid">
          <dt>{t('scheduled.colEnabled')}</dt>
          <dd>{s.enabled ? t('scheduled.enabledYes') : t('scheduled.enabledNo')}</dd>
          <dt>{t('scheduled.colNext')}</dt>
          <dd>{s.enabled && s.nextRunAt != null ? new Date(s.nextRunAt).toLocaleString() : '—'}</dd>
          <dt>{t('scheduled.colStatus')}</dt>
          <dd>
            {s.lastStatus == null ? (
              <span className="muted">{t('scheduled.lastNever')}</span>
            ) : (
              <StatusChip kind={s.lastStatus === 'failed' ? 'danger' : 'success'}>
                {t(`scheduled.last_${s.lastStatus}`)}
              </StatusChip>
            )}
            {s.lastError != null && s.lastError !== '' && (
              <span className="muted"> — {s.lastError}</span>
            )}
          </dd>
        </dl>
        {!s.enabled && s.consecutiveFailures > 0 && (
          <NoticeBanner tone="error" size="compact">
            <span data-testid="scheduled-auto-disabled">{t('scheduled.autoDisabled')}</span>
          </NoticeBanner>
        )}
      </section>

      <section className="page__section">
        <h2>{t('scheduled.runHistory')}</h2>
        {historyQ.isLoading && <LoadingState size="compact" />}
        {historyQ.error !== null && historyQ.error !== undefined && (
          <ErrorBanner
            error={historyQ.error}
            action={
              <button type="button" className="btn btn--sm" onClick={() => void historyQ.refetch()}>
                {t('common.retry')}
              </button>
            }
          />
        )}
        {historyQ.data !== undefined && historyQ.data.length === 0 && (
          <EmptyState size="compact" title={t('scheduled.noRuns')} />
        )}
        {historyQ.data !== undefined && historyQ.data.length > 0 && (
          <TableViewport label={t('scheduled.runHistory')} minWidth="sm">
            <table className="data-table" data-testid="scheduled-history">
              <thead>
                <tr>
                  <th>{t('tasks.colName')}</th>
                  <th>{t('tasks.colStatus')}</th>
                  <th>{t('tasks.colStarted')}</th>
                </tr>
              </thead>
              <tbody>
                {historyQ.data.map((task) => (
                  <tr key={task.id}>
                    <td>
                      <Link to="/tasks/$id" params={{ id: task.id }} className="data-table__link">
                        {task.name}
                      </Link>
                    </td>
                    <td>
                      <TaskStatusChip status={task.status} />
                    </td>
                    <td>
                      {new Date(task.startedAt).toLocaleString(undefined, {
                        dateStyle: 'short',
                        timeStyle: 'short',
                      })}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableViewport>
        )}
      </section>

      {editOpen && s.scheduleSpec !== null && (
        <ScheduleDialog
          open
          onClose={() => setEditOpen(false)}
          edit={{ id: s.id, name: s.name, scheduleSpec: s.scheduleSpec }}
        />
      )}
    </div>
  )
}

// RFC-159 — scheduled-task detail: config + last outcome + run history + actions.
import type { ScheduledTask, TaskSummary } from '@agent-workflow/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createRoute, Link, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { api, type ApiError } from '@/api/client'
import { ConfirmButton } from '@/components/ConfirmButton'
import { ErrorBanner } from '@/components/ErrorBanner'
import { ScheduleDialog } from '@/components/ScheduleDialog'
import { LoadingState } from '@/components/LoadingState'
import { StatusChip } from '@/components/StatusChip'
import { TaskStatusChip } from '@/components/TaskStatusChip'
import { useScheduledTaskWs } from '@/hooks/useScheduledTaskWs'
import { describeApiError } from '@/i18n'
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

  if (detailQ.isLoading) return <LoadingState />
  if (detailQ.error != null) {
    return (
      <div className="page">
        <ErrorBanner error={detailQ.error} />
      </div>
    )
  }
  const s = detailQ.data
  if (s === undefined) return null

  return (
    <div className="page" data-testid="scheduled-detail">
      <header className="page__header page__header--row">
        <div>
          <h1>{s.name}</h1>
          <p className="page__hint">{scheduleSummary(s.scheduleSpec, lang)}</p>
        </div>
        <div className="page__actions">
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
        </div>
      </header>

      {/* RFC-165: degraded/legacy rows surface the repair guidance + the
          per-field parse reason so the user knows WHAT to fix. */}
      {(s.launchPayload === null || s.scheduleSpec === null) && (
        <div
          className="info-box info-box--muted"
          role="status"
          data-testid="scheduled-degraded-banner"
        >
          <div>{t('scheduled.degradedBanner')}</div>
          {s.migrationError?.launchPayload != null && (
            <div className="muted">{s.migrationError.launchPayload}</div>
          )}
          {s.migrationError?.scheduleSpec != null && (
            <div className="muted">{s.migrationError.scheduleSpec}</div>
          )}
        </div>
      )}

      {/* Mutation errors render on their own row below the header — never squeezed
          into the top-right action cluster (mirrors DetailHeaderActions). */}
      {(runNow.error != null || toggle.error != null || del.error != null) && (
        <div className="form-actions">
          {runNow.error != null && (
            <span className="form-actions__error" data-testid="scheduled-run-now-error">
              {describeApiError(runNow.error)}
            </span>
          )}
          {toggle.error != null && (
            <span className="form-actions__error">{describeApiError(toggle.error)}</span>
          )}
          {del.error != null && (
            <span className="form-actions__error">{describeApiError(del.error)}</span>
          )}
        </div>
      )}

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
          <div className="error-box" data-testid="scheduled-auto-disabled">
            {t('scheduled.autoDisabled')}
          </div>
        )}
      </section>

      <section className="page__section">
        <h2>{t('scheduled.runHistory')}</h2>
        {historyQ.data === undefined || historyQ.data.length === 0 ? (
          <p className="muted">{t('scheduled.noRuns')}</p>
        ) : (
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

// RFC-159 → RFC-192 — scheduled-task list with inline operations.
//
// The page's highest-frequency actions live IN the rows now: an enable
// Switch (PUT {enabled} — the same partial-update the detail toggle uses),
// and a two-click「立即运行」(POST run-now → navigate to the new task, same
// behavior as the detail button; 决策 D3 轻确认). The last-run cell folds
// result chip + relative time + task link into one — the link renders ONLY
// for `lastStatus === 'launched'`: recordFailure never touches lastTaskId,
// so after a success→failure sequence the id still points at the OLDER
// successful launch (Codex 设计门 P1 — a failure chip must not link there).
// `consecutiveFailures > 1` adds the「连挂 ×N」danger chip. Next-run shows
// the relative time with the short absolute as a subtitle. Row click keeps
// navigating via the shared `shouldRowNavigate` guard (Switch / links /
// buttons exempt by construction — design §4).

import type { ScheduledTask } from '@agent-workflow/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, createRoute, useNavigate } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'

import { api, type ApiError } from '@/api/client'
import { ConfirmButton } from '@/components/ConfirmButton'
import { EmptyState } from '@/components/EmptyState'
import { ErrorBanner } from '@/components/ErrorBanner'
import { Switch } from '@/components/Form'
import { LoadingState } from '@/components/LoadingState'
import { RelativeTime } from '@/components/RelativeTime'
import { StatusChip } from '@/components/StatusChip'
import { useScheduledTaskWs } from '@/hooks/useScheduledTaskWs'
import { shouldRowNavigate } from '@/lib/row-nav'
import { scheduleSummary } from '@/lib/schedule-view'
import { Route as RootRoute } from './__root'

export const Route = createRoute({
  getParentRoute: () => RootRoute,
  path: '/scheduled',
  component: ScheduledPage,
})

/** Repair rows (healer-disabled payloads, unparsable JSON) cannot fire — the
 *  run-now button disables on the same structural predicate as the repair
 *  badge, MINUS lastError: a schedule whose last fire failed is run-now's
 *  primary user (design §2.3 — the two predicates differ on purpose). */
export function runNowBlocked(row: ScheduledTask): boolean {
  return row.migrationNeeded || row.launchPayload === null || row.scheduleSpec === null
}

function ScheduledPage() {
  const { t, i18n } = useTranslation()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const lang = i18n.language.startsWith('zh') ? 'zh' : 'en'
  useScheduledTaskWs()

  const { data, isLoading, error } = useQuery<ScheduledTask[]>({
    queryKey: ['scheduled-tasks', 'list'],
    queryFn: ({ signal }) => api.get('/api/scheduled-tasks', undefined, signal),
    refetchInterval: 30_000,
  })

  const invalidate = () => void qc.invalidateQueries({ queryKey: ['scheduled-tasks'] })
  // No optimistic write — WS + invalidate settle to the true value, and the
  // backend may flip `enabled` itself (consecutive-failure auto-disable), so
  // an optimistic mirror could show a phantom state (design §2.1).
  const toggle = useMutation<ScheduledTask, ApiError, { id: string; enabled: boolean }>({
    mutationFn: ({ id, enabled }) =>
      api.put(`/api/scheduled-tasks/${encodeURIComponent(id)}`, { enabled }),
    onSuccess: invalidate,
  })
  const runNow = useMutation<{ taskId: string }, ApiError, string>({
    mutationFn: (id) => api.post(`/api/scheduled-tasks/${encodeURIComponent(id)}/run-now`, {}),
    onSuccess: ({ taskId }) => {
      invalidate()
      void navigate({ to: '/tasks/$id', params: { id: taskId } })
    },
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
      {toggle.error != null && <ErrorBanner error={toggle.error} />}
      {runNow.error != null && <ErrorBanner error={runNow.error} />}
      {!isLoading && data !== undefined && data.length === 0 && (
        <EmptyState title={t('scheduled.empty')} data-testid="scheduled-empty" />
      )}
      {data !== undefined && data.length > 0 && (
        <table className="data-table">
          <thead>
            <tr>
              <th>{t('scheduled.colEnabled')}</th>
              <th>{t('scheduled.colName')}</th>
              <th>{t('scheduled.colSchedule')}</th>
              <th>{t('scheduled.colNext')}</th>
              <th>{t('scheduled.colStatus')}</th>
              <th aria-label={t('common.ariaActions')} />
            </tr>
          </thead>
          <tbody>
            {data.map((row) => (
              <tr
                key={row.id}
                className="data-table__row"
                onClick={(e) => {
                  if (shouldRowNavigate(e)) {
                    void navigate({ to: '/scheduled/$id', params: { id: row.id } })
                  }
                }}
                data-testid={`scheduled-row-${row.id}`}
              >
                <td>
                  {/* Inline enable/disable — same PUT the detail toggle fires.
                      The <label>-based Switch is exempt from row navigation
                      via the shared guard's closest() whitelist. */}
                  <Switch
                    checked={row.enabled}
                    disabled={toggle.isPending}
                    onChange={(enabled) => toggle.mutate({ id: row.id, enabled })}
                    aria-label={t('scheduled.colEnabled')}
                    data-testid={`scheduled-enable-${row.id}`}
                  />
                </td>
                <td className="data-table__nowrap">
                  <Link
                    to="/scheduled/$id"
                    params={{ id: row.id }}
                    className="data-table__link"
                    title={row.name}
                  >
                    {row.name}
                  </Link>
                  {/* RFC-165 T14: legacy/degraded rows carry a repair badge —
                      the wizard's editScheduled mode is the repair path. */}
                  {(row.migrationNeeded ||
                    row.lastError != null ||
                    row.launchPayload === null ||
                    row.scheduleSpec === null) && (
                    <>
                      {' '}
                      <StatusChip kind="warn" size="sm" data-testid={`scheduled-repair-${row.id}`}>
                        {t('scheduled.repairBadge')}
                      </StatusChip>
                    </>
                  )}
                </td>
                <td className="data-table__muted">{scheduleSummary(row.scheduleSpec, lang)}</td>
                <td className="data-table__nowrap">
                  {row.enabled && row.nextRunAt != null ? (
                    <div className="scheduled-next">
                      <RelativeTime ts={row.nextRunAt} />
                      <span className="scheduled-next__abs">
                        {new Date(row.nextRunAt).toLocaleString(undefined, {
                          dateStyle: 'short',
                          timeStyle: 'short',
                        })}
                      </span>
                    </div>
                  ) : (
                    <span className="data-table__muted">{t('common.emDash')}</span>
                  )}
                </td>
                <td className="data-table__nowrap">
                  {row.lastStatus == null ? (
                    <span className="muted">{t('scheduled.lastNever')}</span>
                  ) : (
                    <>
                      <StatusChip kind={row.lastStatus === 'failed' ? 'danger' : 'success'}>
                        {t(`scheduled.last_${row.lastStatus}`)}
                      </StatusChip>
                      {/* 连挂告警 — only when failures streak (>1); a single
                          failure is already the chip above. */}
                      {row.consecutiveFailures > 1 && (
                        <>
                          {' '}
                          <StatusChip
                            kind="danger"
                            size="sm"
                            data-testid={`scheduled-streak-${row.id}`}
                          >
                            {t('scheduled.consecutiveChip', { n: row.consecutiveFailures })}
                          </StatusChip>
                        </>
                      )}
                      {row.lastRunAt != null && (
                        <>
                          {' '}
                          <span className="data-table__muted">
                            <RelativeTime ts={row.lastRunAt} />
                          </span>
                        </>
                      )}
                      {/* Task link ONLY for launched — recordFailure leaves
                          lastTaskId pointing at the previous SUCCESSFUL task
                          (Codex 设计门 P1: never link a failure chip there). */}
                      {row.lastStatus === 'launched' && row.lastTaskId != null && (
                        <>
                          {' '}
                          <Link
                            to="/tasks/$id"
                            params={{ id: row.lastTaskId }}
                            className="data-table__link"
                            data-testid={`scheduled-last-task-${row.id}`}
                          >
                            {t('scheduled.lastTaskLink')}
                          </Link>
                        </>
                      )}
                    </>
                  )}
                </td>
                <td className="data-table__actions">
                  <ConfirmButton
                    label={t('scheduled.runNow')}
                    onConfirm={() => runNow.mutateAsync(row.id)}
                    size="sm"
                    disabled={runNowBlocked(row) || runNow.isPending}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

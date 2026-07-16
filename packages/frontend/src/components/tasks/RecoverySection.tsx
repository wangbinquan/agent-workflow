// RFC-108 — task auto-recovery audit, recast as a compact, collapsible banner.
//
// History: this lived inline in routes/tasks.detail.tsx and rendered a
// `<h2>恢复</h2>` `.page__section` with a fully-expanded `<ul>` of
// `<code>{kind}</code>` rows. Three problems (user-reported): it ate vertical
// space, it read like a *second* page heading (same 16px h2 right under the
// page title), and it leaked the raw `recovery_event` enum + English `reason`
// strings straight at the user.
//
// This recast mirrors the neighbouring <StuckTaskBanner>:
//   - a one-line summary that expands on demand (collapsed by default), so it
//     no longer dominates the page;
//   - a banner tone instead of an h2 heading (muted when it's just history,
//     warning + 「解除隔离」 when the task is quarantined);
//   - human-readable Chinese labels for every kind via describeRecoveryKind,
//     with a raw-code fallback when the backend ships a kind newer than this
//     bundle (same contract as describeRule).

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState, type ReactElement } from 'react'
import { useTranslation } from 'react-i18next'

import type { Task } from '@agent-workflow/shared'

import { api } from '@/api/client'
import { BannerDismissButton } from '@/components/NoticeBanner'
import { formatRelativeTime } from '@/lib/homepage'
import { isTerminal } from '@/lib/task-detail-tabs'

export interface RecoveryEventRow {
  id: string
  kind: string
  reason: string | null
  createdAt: number
}

// Authoritative mirror of backend `services/recovery.ts` `RecoveryEventKind`
// (10 values). When the backend adds a kind, the bundle-completeness test
// (recovery-section-kind-i18n.test.ts) flags the missing translation; until one
// lands, describeRecoveryKind() falls back to the raw code (never blank, never a
// leaked i18n key).
export const RECOVERY_EVENT_KINDS = [
  'boot-reap',
  'periodic-reap',
  'shutdown-flip',
  'limit-cancel',
  'snapshot-lost',
  'live-child-survived',
  'auto-resume',
  'auto-repair',
  'heartbeat-kill',
  'quarantine',
] as const

/**
 * Map a `recovery_event` kind code to a user-facing label. Mirrors
 * <StuckTaskBanner>'s describeRule: the i18n key shadows the code, and a missing
 * key (backend ahead of this bundle) falls back to the bare code rather than
 * leaking `tasks.recovery.kind.X`. Exported for unit tests.
 */
export function describeRecoveryKind(kind: string, t: (k: string) => string): string {
  const key = `tasks.recovery.kind.${kind}`
  const label = t(key)
  return label === key ? kind : label
}

/**
 * Per-task system-recovery audit. Invisible for the common healthy task (no
 * recovery history and not quarantined); otherwise a compact banner above the
 * tab bar. Live-polled while the task is active (RFC-108 T23).
 */
export function RecoverySection({
  taskId,
  status,
}: {
  taskId: string
  status: Task['status']
}): ReactElement | null {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const [expanded, setExpanded] = useState(false)
  const [dismissedSignature, setDismissedSignature] = useState<string | null>(null)
  const q = useQuery<{ events: RecoveryEventRow[]; suspended: boolean }>({
    queryKey: ['recovery-events', taskId],
    queryFn: ({ signal }) =>
      api.get(`/api/tasks/${encodeURIComponent(taskId)}/recovery-events`, undefined, signal),
    // RFC-108 T23: live recovery view — poll while the task is active so an
    // auto-resume / reap / quarantine shows up without a manual refresh; stop
    // once terminal (no further recovery events can land).
    refetchInterval: isTerminal(status) ? false : 5000,
  })
  const clear = useMutation({
    mutationFn: () =>
      api.post(`/api/tasks/${encodeURIComponent(taskId)}/clear-recovery-suspension`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['recovery-events', taskId] }),
  })

  const data = q.data
  if (data === undefined || (data.events.length === 0 && !data.suspended)) return null

  const { events, suspended } = data
  const recoverySignature = `${taskId}:${suspended}:${events
    .map((event) => `${event.id}:${event.kind}:${event.createdAt}`)
    .sort()
    .join('|')}`
  if (dismissedSignature === recoverySignature) return null
  const nowMs = Date.now()

  return (
    <div
      className={`task-error-banner ${
        suspended ? 'task-error-banner--warning' : 'task-error-banner--muted'
      } task-recovery`}
      role={suspended ? 'alert' : 'status'}
      data-testid="task-recovery"
    >
      <div className="task-error-banner__body">
        <div className="task-error-banner__summary">
          <strong>
            {suspended
              ? t('tasks.recovery.quarantineTitle')
              : t('tasks.recovery.summary', { count: events.length })}
          </strong>
        </div>
        {suspended && (
          <div className="task-recovery__hint muted">{t('tasks.recovery.quarantined')}</div>
        )}
        {expanded && events.length > 0 && (
          <ul className="task-recovery__list" data-testid="task-recovery-list">
            {events.map((e) => {
              const rel = formatRelativeTime(nowMs, e.createdAt)
              return (
                // `reason` stays out of the main label (it's raw English); we
                // hang it on `title` so an operator can still hover for the
                // original signal without it cluttering the row.
                <li key={e.id} className="task-recovery__item" title={e.reason ?? undefined}>
                  <span className="task-recovery__kind">{describeRecoveryKind(e.kind, t)}</span>
                  <span className="task-recovery__time muted">
                    {t(`home.taskRow.${rel.key}`, rel.opts)}
                  </span>
                </li>
              )
            })}
          </ul>
        )}
      </div>
      <div className="task-recovery__actions">
        {suspended && (
          <button
            type="button"
            className="btn btn--sm"
            disabled={clear.isPending}
            onClick={() => clear.mutate()}
            data-testid="task-recovery-clear"
          >
            {t('tasks.recovery.clearQuarantine')}
          </button>
        )}
        {events.length > 0 && (
          <button
            type="button"
            className="btn btn--sm btn--ghost"
            aria-expanded={expanded}
            onClick={() => setExpanded((v) => !v)}
            data-testid="task-recovery-toggle"
          >
            {expanded ? t('tasks.recovery.collapse') : t('tasks.recovery.expand')}
          </button>
        )}
        <BannerDismissButton
          label={t('common.close')}
          onDismiss={() => {
            setExpanded(false)
            setDismissedSignature(recoverySignature)
          }}
          testId="task-recovery-dismiss"
        />
      </div>
    </div>
  )
}

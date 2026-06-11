// RFC-053 P-6 — banner shown on the task detail page when one or more
// lifecycle alerts are currently open for this task.
//
// Renders a red strip + a short summary ("N issue(s) detected") + a
// "Diagnose" button. The button opens <TaskDiagnosePanel> which calls the
// on-demand `/diagnose` route to show the *live* invariant report (the
// stored alerts may be stale up to 1h since the last invariant scan).
//
// Banner returns null when no alerts are open — invisible by default.

import { useQuery } from '@tanstack/react-query'
import { useState, type ReactElement } from 'react'
import { useTranslation } from 'react-i18next'

import { api } from '@/api/client'
import type { LifecycleAlertRule, LifecycleAlertSeverity } from '@/types/lifecycle'

import { TaskDiagnosePanel } from './TaskDiagnosePanel'

export interface StuckTaskBannerAlert {
  id: string
  rule: LifecycleAlertRule
  severity: LifecycleAlertSeverity
  detail: Record<string, unknown>
  detectedAt: number
}

interface AlertsResponse {
  alerts: StuckTaskBannerAlert[]
}

export interface StuckTaskBannerProps {
  taskId: string
}

export function StuckTaskBanner(props: StuckTaskBannerProps): ReactElement | null {
  const { t } = useTranslation()
  const [diagnoseOpen, setDiagnoseOpen] = useState(false)
  const q = useQuery<AlertsResponse>({
    queryKey: ['tasks', props.taskId, 'alerts'],
    queryFn: ({ signal }) =>
      api.get<AlertsResponse>(
        `/api/tasks/${encodeURIComponent(props.taskId)}/alerts`,
        undefined,
        signal,
      ),
    // The lifecycle.alert WS event invalidates this query for the
    // affected taskId; polling is a fallback for missed messages.
    refetchInterval: 30_000,
  })

  const alerts = q.data?.alerts ?? []
  if (alerts.length === 0) return null

  const hasError = alerts.some((a) => a.severity === 'error')
  return (
    <>
      <div
        className={`task-error-banner${hasError ? '' : ' task-error-banner--warning'}`}
        role="alert"
        data-testid="stuck-task-banner"
      >
        <div className="task-error-banner__body">
          <div className="task-error-banner__summary">
            <strong>
              {hasError
                ? t('tasks.diagnose.bannerErrorTitle')
                : t('tasks.diagnose.bannerWarningTitle')}
            </strong>{' '}
            <span>{t('tasks.diagnose.bannerCount', { count: alerts.length })}</span>
          </div>
          <details className="task-error-banner__details">
            <summary>{t('tasks.diagnose.bannerRulesSummary')}</summary>
            <pre>{alerts.map((a) => `${a.rule}: ${describeRule(a.rule, t)}`).join('\n')}</pre>
          </details>
        </div>
        <button
          type="button"
          className={`btn btn--sm ${hasError ? 'btn--danger' : 'btn--primary'}`}
          onClick={() => setDiagnoseOpen(true)}
          data-testid="stuck-task-banner-diagnose"
        >
          {t('tasks.diagnose.bannerButton')}
        </button>
      </div>
      <TaskDiagnosePanel
        taskId={props.taskId}
        open={diagnoseOpen}
        onClose={() => setDiagnoseOpen(false)}
      />
    </>
  )
}

function describeRule(rule: LifecycleAlertRule, t: (k: string) => string): string {
  // i18n keys mirror the rule code so future additions only need a new
  // entry under tasks.diagnose.rule.<code>.
  const key = `tasks.diagnose.rule.${rule}`
  const label = t(key)
  // RFC-098: a backend ahead of this bundle can emit a rule we have no entry
  // for — i18next then returns the raw key. Fall back to the bare rule code
  // instead of leaking 'tasks.diagnose.rule.X' into the banner.
  return label === key ? rule : label
}

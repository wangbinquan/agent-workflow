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
import { BannerDismissButton } from '@/components/NoticeBanner'
import type { LifecycleAlertRule, LifecycleAlertSeverity } from '@/types/lifecycle'

import { TaskDiagnosePanel } from './TaskDiagnosePanel'
import { labelForCode } from '@/i18n/errors'

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
  const [dismissedSignature, setDismissedSignature] = useState<string | null>(null)
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

  const alertSignature = alerts
    .map(
      (alert) => `${props.taskId}:${alert.id}:${alert.rule}:${alert.severity}:${alert.detectedAt}`,
    )
    .sort()
    .join('|')
  if (dismissedSignature === alertSignature) return null

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
            <pre>
              {alerts
                .map((a) => `${a.rule}: ${labelForCode('tasks.diagnose.rule', a.rule)}`)
                .join('\n')}
            </pre>
          </details>
        </div>
        <div className="task-error-banner__actions">
          <button
            type="button"
            className={`btn btn--sm ${hasError ? 'btn--danger' : 'btn--primary'}`}
            onClick={() => setDiagnoseOpen(true)}
            data-testid="stuck-task-banner-diagnose"
          >
            {t('tasks.diagnose.bannerButton')}
          </button>
          <BannerDismissButton
            label={t('common.close')}
            onDismiss={() => {
              setDiagnoseOpen(false)
              setDismissedSignature(alertSignature)
            }}
            testId="stuck-task-banner-dismiss"
          />
        </div>
      </div>
      <TaskDiagnosePanel
        taskId={props.taskId}
        open={diagnoseOpen}
        onClose={() => setDiagnoseOpen(false)}
      />
    </>
  )
}

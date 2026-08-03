import { useMutation } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import { useId, type ReactElement, type ReactNode } from 'react'

import { api, type ApiError } from '@/api/client'
import { ConfirmButton } from '@/components/ConfirmButton'
import { ErrorBanner } from '@/components/ErrorBanner'
import { NoticeBanner } from '@/components/NoticeBanner'
import type { RunNowEligibility } from '@/lib/schedule-view'
import { classifyWriteOutcome } from '@/lib/write-outcome'

export interface ScheduledRunNowSlots {
  action: ReactElement
  feedback: ReactElement | null
}

export interface ScheduledRunNowActionProps {
  scheduleId: string
  eligibility: RunNowEligibility
  onSuccess: (taskId: string) => void
  size?: 'sm'
  variant?: 'default' | 'primary'
  testid?: string
  errorTestid?: string
  children?: (slots: ScheduledRunNowSlots) => ReactNode
}

/**
 * One run-now transaction contract for both scheduled surfaces. The caller
 * chooses where the action and feedback slots live, while confirmation,
 * pending, retry, eligibility, and the POST remain identical.
 */
export function ScheduledRunNowAction(props: ScheduledRunNowActionProps) {
  const { t } = useTranslation()
  const blockedReasonId = useId()
  const mutation = useMutation<{ taskId: string }, ApiError>({
    mutationFn: () =>
      api.post(`/api/scheduled-tasks/${encodeURIComponent(props.scheduleId)}/run-now`, {}),
    onSuccess: ({ taskId }) => props.onSuccess(taskId),
  })
  const blockedReason = props.eligibility.allowed
    ? undefined
    : t(`scheduled.runNowBlocked.${props.eligibility.reason}`)
  const writeOutcome =
    mutation.error === null ? null : classifyWriteOutcome(mutation.error, { idempotent: false })
  const outcomeUnknown = writeOutcome !== null && writeOutcome !== 'definitive'
  const confirmationKey = `${props.scheduleId}:${
    props.eligibility.allowed ? 'allowed' : props.eligibility.reason
  }`

  const action = (
    <span className="scheduled-run-now-action" title={blockedReason}>
      <ConfirmButton
        label={t('scheduled.runNow')}
        confirmationKey={confirmationKey}
        onConfirm={() => mutation.mutateAsync()}
        disabled={!props.eligibility.allowed || mutation.isPending || mutation.error !== null}
        ariaDescribedBy={blockedReason === undefined ? undefined : blockedReasonId}
        size={props.size}
        variant={props.variant}
        data-testid={props.testid}
      />
      {blockedReason !== undefined && (
        <span id={blockedReasonId} className="sr-only">
          {blockedReason}
        </span>
      )}
    </span>
  )
  const feedback =
    mutation.error === null ? null : outcomeUnknown ? (
      <NoticeBanner
        tone="warning"
        title={t('scheduled.runNowUnknownTitle')}
        action={
          <Link to="/tasks" className="btn btn--sm">
            {t('scheduled.runNowUnknownInspect')}
          </Link>
        }
        testid={props.errorTestid}
      >
        {t('scheduled.runNowUnknownBody')}
      </NoticeBanner>
    ) : (
      <ErrorBanner
        error={mutation.error}
        onRetry={() => mutation.mutate()}
        testid={props.errorTestid}
      />
    )
  const slots = { action, feedback }

  if (props.children !== undefined) return <>{props.children(slots)}</>
  return (
    <div className="scheduled-run-now-action__stack">
      {action}
      {feedback}
    </div>
  )
}

// RFC-057 — second-confirm modal nested under <RepairChoiceDialog>.
//
// The choice dialog renders the option list + preview steps. This modal
// is the gating "are you sure?" step required by RFC-057 §4
// destructive-action policy. It:
//   - re-renders the <RepairPreview> (so the user re-sees the steps
//     they're about to apply)
//   - shows a danger-styled Confirm button when option.destructive=true
//   - POSTs { optionId, confirm: true } and forwards the response
//   - surfaces backend errors inline via <ErrorBanner>
//
// `confirm: true` is enforced server-side via Zod; the modal sends it
// unconditionally so a UI-state bug can never trigger an apply.
//
// RFC-202 T7: a 200 response with `ok:false` (outcome 'apply-failed' — the
// state mutations landed but resumeTask blew up) used to be forwarded to
// onApplied like a success, silently closing every dialog while the task sat
// unresumed and the alert stayed open (audit P1 F-14; `outcomeMessage` had
// ZERO consumers repo-wide). Now the modal stays open, explains what
// happened in Chinese, and only forwards genuine successes.

import { useMutation } from '@tanstack/react-query'
import { useState, type ReactElement } from 'react'
import { useTranslation } from 'react-i18next'

import type { RepairOption, RepairRequest, RepairResponse } from '@agent-workflow/shared'

import { api, type ApiError } from '@/api/client'
import { Dialog } from '@/components/Dialog'
import { ErrorBanner } from '@/components/ErrorBanner'

import { RepairPreview } from './RepairPreview'

export interface RepairConfirmModalProps {
  taskId: string
  alertId: string
  option: RepairOption
  open: boolean
  onCancel: () => void
  onApplied: (result: RepairResponse) => void
}

export function RepairConfirmModal(props: RepairConfirmModalProps): ReactElement {
  const { t } = useTranslation()
  const { taskId, alertId, option, open, onCancel, onApplied } = props
  const [failedResult, setFailedResult] = useState<RepairResponse | null>(null)

  const apply = useMutation<RepairResponse, ApiError>({
    mutationFn: () => {
      const body: RepairRequest = { optionId: option.id, confirm: true }
      return api.post<RepairResponse>(
        `/api/tasks/${encodeURIComponent(taskId)}/alerts/${encodeURIComponent(alertId)}/repair`,
        body,
      )
    },
    onSuccess: (result) => {
      if (result.ok === false) {
        setFailedResult(result)
        return
      }
      onApplied(result)
    },
  })

  const confirmDisabled = !option.available || apply.isPending
  const confirmClass = option.destructive ? 'btn btn--sm btn--danger' : 'btn btn--sm btn--primary'

  return (
    <Dialog
      open={open}
      onClose={onCancel}
      title={t('tasks.diagnose.repair.confirmTitle')}
      size="md"
      data-testid="repair-confirm-modal"
      panelClassName={option.destructive ? 'repair-confirm--destructive' : undefined}
      footer={
        failedResult !== null ? (
          <button
            type="button"
            className="btn btn--sm"
            onClick={onCancel}
            data-testid="repair-confirm-close-failed"
          >
            {t('tasks.diagnose.repair.closeAfterFailure')}
          </button>
        ) : (
          <>
            <button
              type="button"
              className="btn btn--sm"
              onClick={onCancel}
              disabled={apply.isPending}
              data-testid="repair-confirm-cancel"
            >
              {t('tasks.diagnose.repair.cancel')}
            </button>
            <button
              type="button"
              className={confirmClass}
              onClick={() => apply.mutate()}
              disabled={confirmDisabled}
              data-testid="repair-confirm-apply"
            >
              {apply.isPending
                ? t('tasks.diagnose.repair.applying')
                : t('tasks.diagnose.repair.confirmApply')}
            </button>
          </>
        )
      }
    >
      <p className="repair-confirm__lead">
        {t('tasks.diagnose.repair.confirmLead', {
          option: t(option.labelKey),
        })}
      </p>
      <RepairPreview option={option} data-testid="repair-confirm-preview" />
      {failedResult !== null && (
        <ErrorBanner error={null} message={t('tasks.diagnose.repair.applyFailedBanner')} />
      )}
      {failedResult?.outcomeMessage !== undefined && (
        <details className="repair-confirm__failure-detail">
          <summary>{t('tasks.diagnose.repair.applyFailedDetail')}</summary>
          <pre>{failedResult.outcomeMessage}</pre>
        </details>
      )}
      {apply.error !== null && apply.error !== undefined && <ErrorBanner error={apply.error} />}
    </Dialog>
  )
}

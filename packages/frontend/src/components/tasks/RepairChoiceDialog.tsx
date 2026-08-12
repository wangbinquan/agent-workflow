// RFC-057 — primary repair dialog opened from <TaskDiagnosePanel>.
//
// Lifecycle:
//   1. Mount with (taskId, alertId, alertRule). Fire `GET
//      /api/tasks/:taskId/alerts/:alertId/repair-options` (cancelled on
//      unmount via react-query's AbortSignal).
//   2. Render a <Select> with all options. Unavailable options sit
//      disabled with a tooltip-style description picked up from the
//      `unavailableReasonKey` field on the response (rendered inside
//      <RepairPreview>).
//   3. Render <RepairPreview> for the currently-selected option.
//   4. Clicking "Next" hands the selected option to <RepairConfirmModal>;
//      that modal is responsible for the actual POST.
//
// Apply is intentionally a two-step UX (choose → confirm) to match
// RFC-057 §4 destructive-action policy: no single click can mutate state.

import { TASK_QUERY_KEYS } from '@/lib/query-keys'
import { useQuery } from '@tanstack/react-query'
import { useEffect, useMemo, useState, type ReactElement } from 'react'
import { useTranslation } from 'react-i18next'

import type {
  LifecycleAlertRule,
  RepairOption,
  RepairOptionsResponse,
  RepairResponse,
} from '@agent-workflow/shared'

import { api, type ApiError } from '@/api/client'
import { Dialog } from '@/components/Dialog'
import { ErrorBanner } from '@/components/ErrorBanner'
import { LoadingState } from '@/components/LoadingState'
import { Select, type SelectOption } from '@/components/Select'

import { RepairConfirmModal } from './RepairConfirmModal'
import { RepairPreview } from './RepairPreview'

export interface RepairChoiceDialogProps {
  taskId: string
  alertId: string
  alertRule: LifecycleAlertRule
  open: boolean
  onClose: () => void
  /** Fires after a successful apply so the parent can refresh the alert list. */
  onApplied: (result: RepairResponse) => void
}

export function RepairChoiceDialog(props: RepairChoiceDialogProps): ReactElement {
  const { t } = useTranslation()
  const { taskId, alertId, alertRule, open, onClose, onApplied } = props

  const query = useQuery<RepairOptionsResponse, ApiError>({
    queryKey: [...TASK_QUERY_KEYS.alerts(taskId), alertId, 'repair-options'],
    enabled: open,
    queryFn: ({ signal }) =>
      api.get<RepairOptionsResponse>(
        `/api/tasks/${encodeURIComponent(taskId)}/alerts/${encodeURIComponent(alertId)}/repair-options`,
        undefined,
        signal,
      ),
  })

  // Wrap in useMemo so the array identity is stable across renders — without
  // this the `?? []` fallback creates a new array literal every render and
  // every downstream useEffect/useMemo that lists it as a dep re-runs.
  const options = useMemo<ReadonlyArray<RepairOption>>(
    () => query.data?.options ?? [],
    [query.data],
  )

  // Default selection: the first available option, else the first option.
  // Resetting whenever a fresh fetch lands keeps the dropdown synced to
  // whatever the server thinks is recoverable right now.
  const [selectedId, setSelectedId] = useState<string | null>(null)
  useEffect(() => {
    if (options.length === 0) {
      setSelectedId(null)
      return
    }
    const firstAvailable = options.find((o) => o.available)
    setSelectedId((firstAvailable ?? options[0]!).id)
  }, [options])

  // Reset when dialog closes so the next open isn't pre-populated.
  useEffect(() => {
    if (!open) setSelectedId(null)
  }, [open])

  const [confirmOpen, setConfirmOpen] = useState(false)

  const selected: RepairOption | undefined = useMemo(
    () => options.find((o) => o.id === selectedId),
    [options, selectedId],
  )

  const selectOptions: ReadonlyArray<SelectOption<string>> = useMemo(
    () =>
      options.map((o) => ({
        value: o.id,
        label: t(o.labelKey),
        disabled: !o.available,
      })),
    [options, t],
  )

  const canProceed = selected !== undefined && selected.available
  const title = t('tasks.diagnose.repair.dialogTitle', { rule: alertRule })

  return (
    <>
      <Dialog
        open={open && !confirmOpen}
        onClose={onClose}
        title={title}
        size="md"
        data-testid="repair-choice-dialog"
        footer={
          <>
            <button type="button" className="btn btn--sm" onClick={onClose}>
              {t('tasks.diagnose.repair.cancel')}
            </button>
            <button
              type="button"
              className="btn btn--sm btn--primary"
              disabled={!canProceed}
              onClick={() => setConfirmOpen(true)}
              data-testid="repair-choice-next"
            >
              {t('tasks.diagnose.repair.next')}
            </button>
          </>
        }
      >
        {query.isPending && <LoadingState label={t('tasks.diagnose.repair.loading')} />}
        {query.error !== null && query.error !== undefined && <ErrorBanner error={query.error} />}
        {query.data !== undefined && options.length === 0 && (
          <div className="muted" data-testid="repair-choice-empty">
            {t('tasks.diagnose.repair.empty')}
          </div>
        )}
        {query.data !== undefined && options.length > 0 && selected !== undefined && (
          <div className="repair-choice">
            <label className="repair-choice__label" htmlFor="repair-choice-select">
              {t('tasks.diagnose.repair.optionPickerLabel')}
            </label>
            <Select<string>
              value={selected.id}
              options={selectOptions}
              onChange={(v) => setSelectedId(v)}
              ariaLabel={t('tasks.diagnose.repair.optionPickerLabel')}
            />
            <RepairPreview option={selected} data-testid="repair-choice-preview" />
          </div>
        )}
      </Dialog>
      {selected !== undefined && (
        <RepairConfirmModal
          taskId={taskId}
          alertId={alertId}
          option={selected}
          open={confirmOpen}
          onCancel={() => setConfirmOpen(false)}
          onApplied={(result) => {
            setConfirmOpen(false)
            onApplied(result)
            onClose()
          }}
        />
      )}
    </>
  )
}

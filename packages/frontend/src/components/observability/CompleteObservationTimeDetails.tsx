import type { RefObject } from 'react'
import { useTranslation } from 'react-i18next'
import type { CompleteObservationTimePartition } from '@agent-workflow/shared'
import { Dialog } from '@/components/Dialog'
import { TableViewport } from '@/components/TableViewport'
import { CompleteObservationPage } from './CompleteObservationPager'
import { CompleteTokens, CompleteCost } from './CompleteObservationMetrics'
import { useCompleteObservationPage, type ReadableObservationReport } from './completeReportClient'

export function CompleteObservationTimeDetails({
  report,
  onClose,
  onTask,
  triggerRef,
}: {
  report: ReadableObservationReport
  onClose: () => void
  onTask: (id: string, trigger: HTMLElement) => void
  triggerRef: RefObject<HTMLElement | null>
}) {
  const { t } = useTranslation()
  const rows = useCompleteObservationPage<CompleteObservationTimePartition>(
    report,
    'time-unassigned',
  )
  return (
    <Dialog
      open
      onClose={onClose}
      title={t('runObservability.unassignedTime')}
      triggerRef={triggerRef}
      bodyTabIndex={0}
    >
      <p className="muted">{t('runObservability.unassignedTimeHint')}</p>
      <div data-observation-contributions="usage-time">
        <CompleteObservationPage query={rows}>
          {(items) => (
            <TableViewport label={t('runObservability.unassignedTime')}>
              <table className="data-table data-table--compact">
                <thead>
                  <tr>
                    {['task', 'usageRecords', 'tokens', 'cost', 'gapReason'].map((key) => (
                      <th key={key} scope="col">
                        {t('runObservability.' + key)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {items.map((row) => (
                    <tr key={row.identity}>
                      <th scope="row">
                        {row.task ? (
                          <button
                            type="button"
                            className="link link--button data-table__link task-operations__name"
                            data-observation-task={row.task.id}
                            onClick={(event) => onTask(row.task!.id, event.currentTarget)}
                          >
                            {row.task.name}
                          </button>
                        ) : (
                          t('runObservability.historicalIndependent')
                        )}
                      </th>
                      <td>{row.recordId}</td>
                      <td>
                        <CompleteTokens value={row.metrics} />
                      </td>
                      <td>
                        <CompleteCost value={row.metrics} />
                      </td>
                      <td>
                        {t(
                          'runObservability.gap_' +
                            (row.occurrence.reason ?? 'time-evidence-missing'),
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableViewport>
          )}
        </CompleteObservationPage>
      </div>
    </Dialog>
  )
}

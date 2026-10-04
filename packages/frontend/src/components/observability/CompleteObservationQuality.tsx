import type { ReactNode, RefObject } from 'react'
import { useTranslation } from 'react-i18next'
import type { CompleteObservationQuality as Quality } from '@agent-workflow/shared'
import { Card } from '@/components/Card'
import { Dialog } from '@/components/Dialog'
import { TableViewport } from '@/components/TableViewport'
import { NoticeBanner } from '@/components/NoticeBanner'
import { CompleteObservationPage } from './CompleteObservationPager'
import { useCompleteObservationPage, type ReadableObservationReport } from './completeReportClient'
import { observationGapLabel } from './observationGapLabel'

export function CompleteObservationQuality({
  report,
  onSelect,
  selectedKey,
  triggerRef,
}: {
  report: ReadableObservationReport
  onSelect: (row: Quality, trigger: HTMLElement) => void
  selectedKey?: string
  triggerRef?: RefObject<HTMLElement | null>
}) {
  const { t, i18n } = useTranslation()
  const query = useCompleteObservationPage<Quality>(report, 'quality')
  // Old immutable reports cannot acquire associations that were never sealed in their source.
  return (
    <Card title={t('runObservability.dataQuality')}>
      <CompleteObservationPage query={query} hideSinglePageActions>
        {(rows) =>
          rows.length ? (
            <TableViewport label={t('runObservability.dataQuality')}>
              <table className="data-table data-table--compact">
                <thead>
                  <tr>
                    <th scope="col">{t('runObservability.gapReason')}</th>
                    <th scope="col">{t('runObservability.affectedTasks')}</th>
                    <th scope="col">{t('runObservability.detail')}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.key}>
                      <th scope="row">{observationGapLabel(row.key, t)}</th>
                      <td>{BigInt(row.taskCount).toLocaleString(i18n.language)}</td>
                      <td>
                        {row.taskIndexVersion === 1 ? (
                          <button
                            ref={(element) => {
                              if (element && triggerRef && selectedKey === row.key)
                                triggerRef.current = element
                            }}
                            type="button"
                            className="link link--button data-table__link"
                            aria-label={t('runObservability.viewGapTasks', {
                              reason: observationGapLabel(row.key, t),
                            })}
                            onClick={(event) => onSelect(row, event.currentTarget)}
                          >
                            {t('runObservability.affectedTasks')}
                          </button>
                        ) : (
                          <span className="muted">{t('runObservability.gapIndexUnavailable')}</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableViewport>
          ) : (
            <p className="muted">{t('runObservability.fullQualityClear')}</p>
          )
        }
      </CompleteObservationPage>
    </Card>
  )
}
export function CompleteQualityDetails({
  row,
  onClose,
  triggerRef,
  fallbackRef,
  children,
}: {
  row: Quality
  onClose: () => void
  triggerRef: RefObject<HTMLElement | null>
  fallbackRef: RefObject<HTMLElement | null>
  children: ReactNode
}) {
  const { t } = useTranslation()
  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title={t('runObservability.viewGapTasks', { reason: observationGapLabel(row.key, t) })}
      triggerRef={triggerRef}
      restoreFocusFallbackRef={fallbackRef}
      footer={
        <button type="button" className="btn" onClick={onClose}>
          {t('common.close')}
        </button>
      }
    >
      <div
        className="stack--md"
        data-observation-contributions={JSON.stringify(['quality', row.key])}
      >
        <NoticeBanner tone="info" size="compact">
          {t('runObservability.gapTasksHint')}
        </NoticeBanner>
        {children}
      </div>
    </Dialog>
  )
}

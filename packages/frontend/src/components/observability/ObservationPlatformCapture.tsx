import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ObservationTaskDetail } from '@agent-workflow/shared'
import { Card } from '@/components/Card'
import { Dialog } from '@/components/Dialog'
import { TableViewport } from '@/components/TableViewport'
import { observationReasonKey } from './ObservationMetrics'

type Row = NonNullable<ObservationTaskDetail['platformCaptures']>[number]
const rowKey = (row: Row) => JSON.stringify([row.invocationId, row.sourceId, row.capture?.id])

export function ObservationPlatformCapture({ rows }: { rows: readonly Row[] }) {
  const { t, i18n } = useTranslation()
  const [selected, select] = useState<string | null>(null)
  const trigger = useRef<HTMLButtonElement | null>(null)
  const chosen = rows.find((row) => rowKey(row) === selected)
  if (!rows.length) return null
  const count = (value: number | undefined) =>
    value === undefined ? '—' : value.toLocaleString(i18n.language)
  return (
    <>
      <Card title={t('runObservability.platformCaptureTitle')}>
        <div className="stack--sm">
          <p className="muted">{t('runObservability.platformCaptureHint')}</p>
          <TableViewport label={t('runObservability.platformCaptureTitle')}>
            <table className="data-table data-table--compact">
              <thead>
                <tr>
                  {[
                    'attempt',
                    'nativeTurn',
                    'state',
                    'nativeReceived',
                    'lastObserved',
                    'captureActions',
                  ].map((key) => (
                    <th key={key} scope="col">
                      {t('runObservability.' + key)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={rowKey(row)}>
                    <th scope="row">
                      {row.nodeRunId ?? row.invocationId}
                      <div className="muted">{row.invocationId}</div>
                    </th>
                    <td>{row.capture?.proof.turn ?? '—'}</td>
                    <td>
                      {t('runObservability.nativeState_' + (row.capture?.state ?? 'unobserved'))}
                    </td>
                    <td>{count(row.capture?.receivedSteps)}</td>
                    <td>
                      {row.capture
                        ? new Date(row.capture.proof.observedAt).toLocaleString(i18n.language)
                        : t('runObservability.unknown')}
                    </td>
                    <td>
                      <button
                        type="button"
                        className="btn btn--sm"
                        onClick={(event) => {
                          trigger.current = event.currentTarget
                          select(rowKey(row))
                        }}
                      >
                        {t('runObservability.nativeCaptureDetails')}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableViewport>
        </div>
      </Card>
      <Dialog
        open={chosen !== undefined}
        triggerRef={trigger}
        onClose={() => select(null)}
        title={t('runObservability.platformCaptureTitle')}
      >
        {chosen && (
          <div className="stack--md">
            <p>{t('runObservability.platformCaptureHint')}</p>
            <TableViewport label={t('runObservability.platformCaptureTitle')}>
              <table className="data-table data-table--compact">
                <tbody>
                  <tr>
                    <th scope="row">{t('runObservability.nativeTurn')}</th>
                    <td>{chosen.capture?.proof.turn ?? '—'}</td>
                  </tr>
                  <tr>
                    <th scope="row">{t('runObservability.nativeScanSize')}</th>
                    <td>
                      {chosen.capture
                        ? `${count(chosen.capture.proof.sessions)} / ${count(chosen.capture.proof.steps)}`
                        : '—'}
                    </td>
                  </tr>
                  <tr>
                    <th scope="row">{t('runObservability.nativeReceived')}</th>
                    <td>{count(chosen.capture?.receivedSteps)}</td>
                  </tr>
                  <tr>
                    <th scope="row">{t('runObservability.nativeUnresolved')}</th>
                    <td>{count(chosen.capture?.unresolvedBaselineSteps)}</td>
                  </tr>
                  <tr>
                    <th scope="row">{t('runObservability.nativeCorrected')}</th>
                    <td>{count(chosen.capture?.correctedBaselineSteps)}</td>
                  </tr>
                  <tr>
                    <th scope="row">{t('runObservability.sourceGaps')}</th>
                    <td>
                      {chosen.issues.length
                        ? chosen.issues
                            .map((issue) => t('runObservability.' + observationReasonKey(issue)))
                            .join(' · ')
                        : t('runObservability.gapsAbsent')}
                    </td>
                  </tr>
                </tbody>
              </table>
            </TableViewport>
          </div>
        )}
      </Dialog>
    </>
  )
}

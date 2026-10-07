import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ObservationTaskDetail } from '@agent-workflow/shared'
import { Card } from '@/components/Card'
import { Dialog } from '@/components/Dialog'
import { TableViewport } from '@/components/TableViewport'
import { observationReasonKey } from './ObservationMetrics'

type CaptureRow = NonNullable<ObservationTaskDetail['nativeCaptures']>[number] & {
  readonly taskName?: string
}
function revisions(row: CaptureRow) {
  const proof = row.proof?.contract === 'opencode-child-steps-v1' ? row.proof : null
  const entries = new Map(
    (proof?.priorRevisions ?? []).map((value) => [
      value.stepId,
      { ...value, owner: null as string | null },
    ]),
  )
  for (const resolution of row.revisions ?? []) {
    if (resolution.previous)
      entries.set(resolution.stepId, {
        stepId: resolution.stepId,
        sessionId: resolution.sessionId,
        before: resolution.previous,
        after: resolution.current ?? null,
        owner: resolution.invocationId,
      })
    else if (entries.has(resolution.stepId) && resolution.status === 'resolved')
      entries.set(resolution.stepId, {
        ...entries.get(resolution.stepId)!,
        owner: resolution.invocationId,
      })
  }
  return [...entries.values()]
}

export function ObservationNativeCapture({
  rows,
  embedded = false,
}: {
  rows: readonly CaptureRow[]
  embedded?: boolean
}) {
  const { t, i18n } = useTranslation(),
    [selected, select] = useState<string | null>(null)
  const chosen = rows.find((row) => row.invocationId === selected)
  if (!rows.length) return null
  const count = (value: string | null | undefined) =>
    value == null ? t('runObservability.unknown') : BigInt(value).toLocaleString(i18n.language)
  const identity = (row: CaptureRow) => row.taskName?.trim() || row.nodeRunId || row.invocationId
  const scanSize = (row: CaptureRow) => {
    const proof = row.proof
    if (!proof) return '—'
    if (proof.contract === 'opencode-child-steps-v1')
      return `${count(String(proof.scannedSessions))} / ${count(String(proof.scannedSteps))}`
    if (proof.contract === 'opencode-child-root-pages-v3')
      return t('runObservability.nativeRootsAndRecords', {
        roots: count(proof.roots.count),
        records: count(proof.emissions.records),
      })
    const counts = proof.final?.ack.counts ?? proof.finalProgress?.counts
    return `${count(counts?.sessions)} / ${count(counts?.steps)}`
  }
  const content = (
    <div className="stack--sm">
      <p className="muted">{t('runObservability.nativeCaptureHint')}</p>
      <TableViewport label={t('runObservability.nativeCaptureTitle')}>
        <table className="data-table data-table--compact">
          <thead>
            <tr>
              {[
                'nativeCaptureIdentity',
                'state',
                'nativeCapturedScope',
                'lastObserved',
                'sourceGaps',
              ].map((key) => (
                <th key={key} scope="col">
                  {t('runObservability.' + key)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.invocationId}>
                <th scope="row">
                  {identity(row)}
                  {identity(row) !== row.invocationId && (
                    <div className="muted">{row.invocationId}</div>
                  )}
                </th>
                <td>{t('runObservability.nativeState_' + row.state)}</td>
                <td>{scanSize(row)}</td>
                <td>
                  {row.proof
                    ? new Date(row.proof.observedAt).toLocaleString(i18n.language)
                    : t('runObservability.unknown')}
                </td>
                <td>
                  {[
                    ...new Set(
                      (row.issues ?? row.proof?.issues ?? []).map((issue) =>
                        t('runObservability.' + observationReasonKey(issue)),
                      ),
                    ),
                  ].join(' · ')}
                  {row.priorRevisionGap && <div>{t('runObservability.nativePriorRevision')}</div>}
                  {revisions(row).length > 0 && (
                    <button
                      type="button"
                      className="btn btn--sm"
                      onClick={() => select(row.invocationId)}
                    >
                      {t('runObservability.nativeRevisionDetails')}
                    </button>
                  )}
                  {row.state === 'complete' && t('runObservability.gapsAbsent')}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableViewport>
    </div>
  )
  return (
    <>
      {embedded ? content : <Card title={t('runObservability.nativeCaptureTitle')}>{content}</Card>}
      <Dialog
        open={chosen !== undefined}
        onClose={() => select(null)}
        title={t('runObservability.nativeRevisionDetails')}
      >
        <div className="stack--md">
          <p>{t('runObservability.nativeRevisionHint')}</p>
          <TableViewport label={t('runObservability.nativeRevisionDetails')}>
            <table className="data-table data-table--compact">
              <thead>
                <tr>
                  {['nativeStep', 'model', 'input', 'output', 'cacheRead', 'cacheWrite'].map(
                    (key) => (
                      <th scope="col" key={key}>
                        {t('runObservability.' + key)}
                      </th>
                    ),
                  )}
                </tr>
              </thead>
              <tbody>
                {(chosen ? revisions(chosen) : []).map((revision) => (
                  <tr key={JSON.stringify([revision.sessionId, revision.stepId])}>
                    <th scope="row">
                      {revision.sessionId}
                      <div>{revision.stepId}</div>
                      <div className="muted">
                        {revision.owner
                          ? t('runObservability.nativeRevisionOwner', { id: revision.owner })
                          : t('runObservability.nativeRevisionUnresolved')}
                      </div>
                    </th>
                    <td>
                      {revision.before.model
                        ? `${revision.before.model.provider} / ${revision.before.model.id}`
                        : t('runObservability.unknown')}
                      {' → '}
                      {revision.after?.model
                        ? `${revision.after.model.provider} / ${revision.after.model.id}`
                        : t('runObservability.unknown')}
                    </td>
                    {(['input', 'output', 'cacheRead', 'cacheWrite'] as const).map((bucket) => (
                      <td key={bucket}>
                        {count(revision.before.usage[bucket])}
                        {' → '}
                        {count(revision.after?.usage[bucket])}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </TableViewport>
        </div>
      </Dialog>
    </>
  )
}

import { Fragment, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type {
  CompleteHistoricalObservationExecution,
  CompleteHistoricalObservationRecord,
  CompleteHistoricalObservationReference,
} from '@agent-workflow/shared'
import { Card } from '@/components/Card'
import { Dialog } from '@/components/Dialog'
import { TableViewport } from '@/components/TableViewport'
import { ExecutionSwimlane } from '@/components/ExecutionSwimlane'
import { CompleteMetrics, CompleteTokens } from './CompleteObservationMetrics'
import { CompleteObservationPage } from './CompleteObservationPager'
import { useCompleteObservationPage, type ReadableObservationReport } from './completeReportClient'
import { OBSERVATION_TOKEN_BUCKETS } from './formatObservations'
import { observationGapLabel } from './observationGapLabel'

function HistoricalRecordRows({
  rows,
  onRecord,
}: {
  rows: readonly CompleteHistoricalObservationRecord[]
  onRecord?: (record: CompleteHistoricalObservationRecord, trigger: HTMLButtonElement) => void
}) {
  const { t, i18n } = useTranslation()
  return (
    <TableViewport label={t('runObservability.historicalRecords')}>
      <table className="data-table data-table--compact">
        <thead>
          <tr>
            {['actualModel', ...OBSERVATION_TOKEN_BUCKETS, 'historicalMembership', 'cost'].map(
              (key) => (
                <th scope="col" key={key}>
                  {t('runObservability.' + key)}
                </th>
              ),
            )}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={JSON.stringify([row.nativeSource, row.recordId, row.versionFingerprint ?? null])}
            >
              <th scope="row">
                {onRecord ? (
                  <button
                    type="button"
                    className="link link--button data-table__link"
                    onClick={(event) => onRecord(row, event.currentTarget)}
                  >
                    {row.model?.id ?? t('runObservability.modelUnknown')}
                  </button>
                ) : (
                  (row.model?.id ?? t('runObservability.modelUnknown'))
                )}
                <div className="muted">{row.model?.provider}</div>
              </th>
              {OBSERVATION_TOKEN_BUCKETS.map((bucket) => (
                <td key={bucket}>
                  {row.originalUsage[bucket] === null
                    ? t('runObservability.unknown')
                    : BigInt(row.originalUsage[bucket]!).toLocaleString(i18n.language)}
                </td>
              ))}
              <td>
                {t(
                  'runObservability.' +
                    (row.coveredByAcceptedRecords
                      ? 'historicalAlreadyIncluded'
                      : row.includedInTotals
                        ? 'historicalIncluded'
                        : row.scopeMatch === 'excluded'
                          ? 'historicalExcluded'
                          : 'historicalUnresolved'),
                )}
              </td>
              <td>
                {row.coveredByAcceptedRecords
                  ? t('runObservability.historicalOriginalEstimate')
                  : t('runObservability.historicalPriceMissing')}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </TableViewport>
  )
}
export function CompleteHistoricalRecords({
  report,
  parent = null,
}: {
  report: ReadableObservationReport
  parent?: string | null
}) {
  const { t } = useTranslation(),
    enabled = BigInt(report.counts['historical-records'] ?? '0') > 0n
  const query = useCompleteObservationPage<CompleteHistoricalObservationRecord>(
    report,
    'historical-records',
    parent,
    enabled,
  )
  const [chosen, setChosen] = useState<{
      reportId: string
      row: CompleteHistoricalObservationRecord
    } | null>(null),
    trigger = useRef<HTMLButtonElement | null>(null)
  const selected = chosen?.reportId === report.header.reportId ? chosen.row : null
  const recordKey =
    selected === null ? null : JSON.stringify([selected.nativeSource, selected.recordId])
  // The opaque report row key is not available to the browser; retain the original identities as the parent.
  const references = useCompleteObservationPage<CompleteHistoricalObservationReference>(
    report,
    'historical-record-references',
    recordKey,
    selected !== null,
  )
  const versions = useCompleteObservationPage<CompleteHistoricalObservationRecord>(
    report,
    'historical-record-versions',
    recordKey,
    selected !== null && selected.issues.includes('historical-native-record-conflict'),
  )
  if (!enabled) return null
  return (
    <div className="stack--md">
      <CompleteObservationPage query={query}>
        {(rows) => (
          <HistoricalRecordRows
            rows={rows}
            onRecord={(row, node) => {
              trigger.current = node
              setChosen({ reportId: report.header.reportId, row })
            }}
          />
        )}
      </CompleteObservationPage>
      {selected && (
        <Dialog
          open
          size="lg"
          title={t('runObservability.historicalRecords')}
          triggerRef={trigger}
          onClose={() => setChosen(null)}
        >
          <div className="stack--md">
            <HistoricalRecordRows rows={[selected]} />
            <p className="muted">{t('runObservability.historicalRecordsHint')}</p>
            <dl className="detail-grid observation-metrics">
              <dt>{t('runObservability.traceNativeCall')}</dt>
              <dd>{selected.recordId}</dd>
              <dt>{t('runObservability.traceNativeSession')}</dt>
              <dd>{selected.sessionId}</dd>
            </dl>
            <CompleteObservationPage query={references}>
              {(rows) => (
                <TableViewport label={t('runObservability.historicalReferences')}>
                  <table className="data-table data-table--compact">
                    <tbody>
                      {rows.map((row) => (
                        <tr key={row.referenceId}>
                          <th scope="row">{row.execution.name}</th>
                          <td>
                            {t('runObservability.historicalSource_' + row.execution.sourceKind)}
                          </td>
                          <td>
                            {t(
                              'runObservability.' +
                                (row.scopeMatch === 'matched'
                                  ? 'historicalIncluded'
                                  : row.scopeMatch === 'excluded'
                                    ? 'historicalExcluded'
                                    : 'historicalUnresolved'),
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </TableViewport>
              )}
            </CompleteObservationPage>
            {selected.issues.includes('historical-native-record-conflict') && (
              <Card title={t('runObservability.historicalVersions')}>
                <CompleteObservationPage query={versions}>
                  {(rows) => <HistoricalRecordRows rows={rows} />}
                </CompleteObservationPage>
              </Card>
            )}
          </div>
        </Dialog>
      )}
    </div>
  )
}
export function CompleteHistoricalExecutions({
  report,
  parent = null,
  timeline = false,
}: {
  report: ReadableObservationReport
  parent?: string | null
  timeline?: boolean
}) {
  const { t, i18n } = useTranslation(),
    enabled = BigInt(report.counts['historical-executions'] ?? '0') > 0n
  const query = useCompleteObservationPage<CompleteHistoricalObservationExecution>(
    report,
    'historical-executions',
    parent,
    enabled,
  )
  const [chosen, setChosen] = useState<{
      reportId: string
      row: CompleteHistoricalObservationExecution
    } | null>(null),
    trigger = useRef<HTMLButtonElement | null>(null)
  const selected = chosen?.reportId === report.header.reportId ? chosen.row : null
  const select = (row: CompleteHistoricalObservationExecution, node: HTMLButtonElement) => {
    trigger.current = node
    setChosen({ reportId: report.header.reportId, row })
  }
  if (!enabled) return null
  return (
    <Card title={t('runObservability.historicalExecutions')}>
      <div className="stack--md">
        <CompleteObservationPage query={query}>
          {(rows) => {
            const starts = rows.flatMap((row) =>
              row.execution.startedAt === null ? [] : [row.execution.startedAt],
            )
            const ends = rows.flatMap((row) =>
              row.execution.finishedAt !== null
                ? [row.execution.finishedAt]
                : row.execution.status === 'running' && row.execution.startedAt !== null
                  ? [report.header.asOf]
                  : [],
            )
            return (
              <div className="stack--md">
                {timeline && (
                  <ExecutionSwimlane
                    label={t('runObservability.historicalExecutions')}
                    rowHeading={t('runObservability.agent')}
                    timeHeading={t('runObservability.pageExecutionRange')}
                    unknownLabel={t('runObservability.unknownInterval')}
                    from={starts.length ? Math.min(...starts) : report.header.asOf}
                    to={ends.length ? Math.max(...ends) : report.header.asOf}
                    onSelect={(id, node) => {
                      const row = rows.find((value) => value.execution.referenceId === id)
                      if (row) select(row, node)
                    }}
                    rows={rows.map((row) => ({
                      id: row.execution.referenceId,
                      label: (
                        <>
                          {row.execution.agentName ?? row.execution.name}
                          <div className="muted">{row.parentTaskName}</div>
                        </>
                      ),
                      start: row.execution.startedAt,
                      end:
                        row.execution.finishedAt ??
                        (row.execution.status === 'running' && row.execution.startedAt !== null
                          ? report.header.asOf
                          : null),
                      open: row.execution.status === 'running',
                      description: row.execution.name,
                      detail:
                        row.execution.startedAt === null
                          ? t('runObservability.unknownInterval')
                          : new Date(row.execution.startedAt).toLocaleString(i18n.language) +
                            ' → ' +
                            (row.execution.finishedAt === null
                              ? t('runObservability.unknownInterval')
                              : new Date(row.execution.finishedAt).toLocaleString(i18n.language)),
                    }))}
                  />
                )}
                <TableViewport label={t('runObservability.historicalExecutions')}>
                  <table className="data-table data-table--compact">
                    <thead>
                      <tr>
                        {[
                          'agent',
                          'task',
                          'state',
                          'runtime',
                          'totalTokens',
                          'historicalMembership',
                        ].map((key) => (
                          <th scope="col" key={key}>
                            {t('runObservability.' + key)}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((row) => (
                        <tr key={row.execution.referenceId}>
                          <th scope="row">
                            <button
                              type="button"
                              className="link link--button data-table__link task-operations__name"
                              onClick={(event) => select(row, event.currentTarget)}
                            >
                              {row.execution.agentName ?? row.execution.name}
                            </button>
                            <div className="muted">
                              {t('runObservability.historicalSource_' + row.execution.sourceKind)}
                              {row.execution.attemptId !== null
                                ? ' · ' + row.execution.attemptId
                                : ''}
                            </div>
                          </th>
                          <td>
                            {row.parentTaskName ?? t('runObservability.historicalIndependent')}
                          </td>
                          <td>
                            {t('tasks.status.' + row.execution.status, {
                              defaultValue: row.execution.status,
                            })}
                          </td>
                          <td>
                            {row.execution.runtime?.name ??
                              t('runObservability.runtimeNameUnknown')}
                            {row.execution.runtime?.protocol && (
                              <div className="muted">{row.execution.runtime.protocol}</div>
                            )}
                          </td>
                          <td>
                            {row.coveredByAcceptedRecords ? (
                              t('runObservability.historicalAlreadyIncluded')
                            ) : (
                              <CompleteTokens value={row.metrics} />
                            )}
                          </td>
                          <td>
                            {t(
                              'runObservability.' +
                                (row.scopeMatch === 'matched'
                                  ? 'historicalIncluded'
                                  : row.scopeMatch === 'excluded'
                                    ? 'historicalExcluded'
                                    : 'historicalUnresolved'),
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </TableViewport>
              </div>
            )
          }}
        </CompleteObservationPage>
        {selected && (
          <Dialog
            open
            size="lg"
            title={selected.execution.name}
            triggerRef={trigger}
            onClose={() => setChosen(null)}
          >
            <div className="stack--md">
              <CompleteMetrics value={selected.metrics} />
              <p className="muted">
                {selected.issues.map((reason) => observationGapLabel(reason, t)).join(' · ')}
              </p>
              {selected.execution.recordedUsage && (
                <Card title={t('runObservability.historicalOwnerUsage')}>
                  <p className="muted">{t('runObservability.historicalOwnerUsageHint')}</p>
                  <dl className="detail-grid observation-metrics">
                    {OBSERVATION_TOKEN_BUCKETS.map((bucket) => (
                      <Fragment key={bucket}>
                        <dt>{t('runObservability.' + bucket)}</dt>
                        <dd>
                          {selected.execution.recordedUsage![bucket] === null
                            ? t('runObservability.unknown')
                            : BigInt(selected.execution.recordedUsage![bucket]!).toLocaleString(
                                i18n.language,
                              )}
                        </dd>
                      </Fragment>
                    ))}
                  </dl>
                </Card>
              )}
              <dl className="detail-grid observation-metrics">
                <dt>{t('runObservability.task')}</dt>
                <dd>{selected.parentTaskName ?? t('runObservability.historicalIndependent')}</dd>
                <dt>{t('runObservability.historicalTimeBasis')}</dt>
                <dd>{t('runObservability.historicalTime_' + selected.timeBasis)}</dd>
                <dt>{t('runObservability.historicalPriceMissing')}</dt>
                <dd>{t('runObservability.unknown')}</dd>
              </dl>
              <CompleteHistoricalRecords
                report={report}
                parent={JSON.stringify(['historical-execution', selected.execution.referenceId])}
              />
            </div>
          </Dialog>
        )}
      </div>
    </Card>
  )
}

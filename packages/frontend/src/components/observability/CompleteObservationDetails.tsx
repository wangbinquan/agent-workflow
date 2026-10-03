import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type {
  CompleteObservationAllocation,
  CompleteObservationAttempt,
  CompleteObservationInvocation,
  CompleteObservationQuality as Quality,
  ObservationCaptureCommit,
  ObservationNativeRevisionResolution,
  ObservationTaskDetail,
} from '@agent-workflow/shared'
import { Card } from '@/components/Card'
import { EmptyState } from '@/components/EmptyState'
import { Dialog } from '@/components/Dialog'
import { ExecutionSwimlane } from '@/components/ExecutionSwimlane'
import { TableViewport } from '@/components/TableViewport'
import { CompleteMetrics } from './CompleteObservationMetrics'
import { CompleteObservationPage } from './CompleteObservationPager'
import { CompleteInvocationRows, CompleteAllocationRows } from './CompleteObservationTables'
import { useCompleteObservationPage, type ReadyObservationReport } from './completeReportClient'
import { ObservationNativeCapture } from './ObservationNativeCapture'
import { ObservationPlatformCapture } from './ObservationPlatformCapture'

type Attempt = CompleteObservationAttempt & { readonly taskId: string; readonly taskName: string }
type NativeCapture = ObservationCaptureCommit & {
  readonly priorRevisionGap: boolean
  readonly resolutions: readonly ObservationNativeRevisionResolution[]
}
export function CompleteObservationCalls({
  report,
  parent = null,
}: {
  report: ReadyObservationReport
  parent?: string | null
}) {
  const { t } = useTranslation(),
    calls = useCompleteObservationPage<CompleteObservationInvocation>(report, 'invocations', parent)
  const [chosen, setChosen] = useState<{
    reportId: string
    call: CompleteObservationInvocation
  } | null>(null)
  const callTrigger = useRef<HTMLButtonElement | null>(null)
  return (
    <div className="stack--md">
      <CompleteObservationPage query={calls}>
        {(rows) => (
          <CompleteInvocationRows
            rows={rows}
            onCall={(call, trigger) => {
              callTrigger.current = trigger
              setChosen({ reportId: report.header.reportId, call })
            }}
          />
        )}
      </CompleteObservationPage>
      {chosen?.reportId === report.header.reportId && (
        <Dialog
          open
          onClose={() => setChosen(null)}
          title={chosen.call.agentName ?? t('runObservability.calls')}
          size="lg"
          triggerRef={callTrigger}
        >
          <div className="stack--md">
            <CompleteMetrics value={chosen.call.metrics} />
            <dl className="detail-grid observation-metrics">
              <dt>{t('runObservability.task')}</dt>
              <dd>{chosen.call.taskName}</dd>
              <dt>{t('runObservability.runtime')}</dt>
              <dd>
                {chosen.call.authority.kind === 'local'
                  ? (chosen.call.authority.runtime?.acceptedName ??
                    t('runObservability.registrationUnknown'))
                  : 'CrewStation'}
              </dd>
              <dt>{t('runObservability.purpose')}</dt>
              <dd>{t('runObservability.purpose_' + chosen.call.purpose)}</dd>
            </dl>
            <Card title={t('runObservability.usageRecords')}>
              <CompleteObservationAllocations
                report={report}
                parent={JSON.stringify(['invocation', chosen.call.invocationId])}
              />
            </Card>
          </div>
        </Dialog>
      )}
    </div>
  )
}
export function CompleteObservationAllocations({
  report,
  parent = null,
}: {
  report: ReadyObservationReport
  parent?: string | null
}) {
  const query = useCompleteObservationPage<CompleteObservationAllocation>(
    report,
    'allocations',
    parent,
  )
  return (
    <CompleteObservationPage query={query}>
      {(rows) => <CompleteAllocationRows rows={rows} />}
    </CompleteObservationPage>
  )
}
export function CompleteObservationTimeline({
  report,
  parent = null,
}: {
  report: ReadyObservationReport
  parent?: string | null
}) {
  const { t, i18n } = useTranslation(),
    query = useCompleteObservationPage<Attempt>(report, 'attempts', parent)
  const [selected, setSelected] = useState<{ reportId: string; attempt: Attempt } | null>(null)
  const attemptTrigger = useRef<HTMLButtonElement | null>(null)
  const date = (time: number) => new Date(time).toLocaleString(i18n.language)
  return (
    <div className="stack--md">
      <CompleteObservationPage query={query}>
        {(rows) => {
          const starts = rows.flatMap((row) => (row.startedAt === null ? [] : [row.startedAt]))
          const ends = rows.flatMap((row) =>
            row.finishedAt === null ? (row.open ? [report.header.asOf] : []) : [row.finishedAt],
          )
          const from = starts.length ? Math.min(...starts) : report.header.asOf,
            to = ends.length ? Math.max(from + 1, ...ends) : report.header.asOf + 1
          return (
            <ExecutionSwimlane
              label={t('runObservability.timeline')}
              rowHeading={t('runObservability.attempt')}
              timeHeading={t('runObservability.pageExecutionRange')}
              unknownLabel={t('runObservability.unknownInterval')}
              from={from}
              to={to}
              onSelect={(id, trigger) => {
                const attempt = rows.find((row) => row.id === id)
                if (attempt) {
                  attemptTrigger.current = trigger
                  setSelected({ reportId: report.header.reportId, attempt })
                }
              }}
              rows={rows.map((row) => ({
                id: row.id,
                label: (
                  <>
                    {row.nodeId}
                    <div className="muted">{row.taskName}</div>
                  </>
                ),
                start: row.startedAt,
                end: row.finishedAt ?? (row.open ? report.header.asOf : null),
                open: row.open,
                description: t('runObservability.detail') + ' · ' + row.nodeId,
                detail:
                  row.startedAt === null || row.durationMs === null
                    ? t('runObservability.unknownInterval')
                    : date(row.startedAt) +
                      ' → ' +
                      date(row.finishedAt ?? report.header.asOf) +
                      ' · ' +
                      BigInt(row.durationMs).toLocaleString(i18n.language) +
                      ' ms',
              }))}
            />
          )
        }}
      </CompleteObservationPage>
      {selected?.reportId === report.header.reportId && (
        <Dialog
          open
          onClose={() => setSelected(null)}
          title={selected.attempt.nodeId}
          size="lg"
          triggerRef={attemptTrigger}
        >
          <div className="stack--md">
            <CompleteMetrics value={selected.attempt.metrics} />
            <CompleteObservationCalls
              report={report}
              parent={JSON.stringify(['attempt', selected.attempt.id])}
            />
          </div>
        </Dialog>
      )}
    </div>
  )
}
export function CompleteObservationCaptures({ report }: { report: ReadyObservationReport }) {
  const { t } = useTranslation(),
    native = useCompleteObservationPage<NativeCapture>(report, 'native-captures')
  const platform = useCompleteObservationPage<
    NonNullable<ObservationTaskDetail['platformCaptures']>[number]
  >(report, 'platform-captures')
  return (
    <div className="stack--md">
      <CompleteObservationPage query={native}>
        {(rows) =>
          rows.length ? (
            <ObservationNativeCapture
              rows={rows.map((row) => ({
                invocationId: row.invocationId,
                nodeRunId: null,
                state: row.capture.state,
                priorRevisionGap: row.priorRevisionGap,
                proof: row.capture,
                revisions: row.resolutions,
              }))}
            />
          ) : (
            <Card title={t('runObservability.nativeCaptureTitle')}>
              <EmptyState title={t('runObservability.emptyCaptures')} size="compact" />
            </Card>
          )
        }
      </CompleteObservationPage>
      <CompleteObservationPage query={platform}>
        {(rows) =>
          rows.length ? (
            <ObservationPlatformCapture rows={rows} />
          ) : (
            <Card title={t('runObservability.platformCaptureTitle')}>
              <EmptyState title={t('runObservability.emptyCaptures')} size="compact" />
            </Card>
          )
        }
      </CompleteObservationPage>
    </div>
  )
}
export function CompleteObservationTiming({ report }: { report: ReadyObservationReport }) {
  const { t, i18n } = useTranslation(),
    root = report.summary.rootTask
  const timing = root?.timing
  const ms = (value: string | null) =>
    value === null ? '—' : BigInt(value).toLocaleString(i18n.language) + ' ms'
  return (
    <dl className="detail-grid observation-metrics">
      <dt>{t('runObservability.wall')}</dt>
      <dd>{ms(timing ? timing.wallMs : report.summary.timing.wallMs)}</dd>
      <dt>{t('runObservability.running')}</dt>
      <dd>{ms(timing ? timing.runningMs : report.summary.timing.runningMs)}</dd>
      {timing && (
        <>
          <dt>{t('runObservability.cumulative')}</dt>
          <dd>
            {ms(timing.intervals.state === 'complete' ? timing.intervals.cumulativeMs : null)}
          </dd>
          <dt>{t('runObservability.union')}</dt>
          <dd>
            {ms(timing.intervals.state === 'complete' ? timing.intervals.activeUnionMs : null)}
          </dd>
        </>
      )}
      <dt>{t('runObservability.p50')}</dt>
      <dd>{ms(report.summary.timing.p50Ms)}</dd>
      <dt>{t('runObservability.p95')}</dt>
      <dd>{ms(report.summary.timing.p95Ms)}</dd>
      <dt>{t('runObservability.unknownIntervals')}</dt>
      <dd>
        {timing?.intervals.state === 'not-ready'
          ? timing.intervals.unknown
          : report.summary.timing.unknown}
      </dd>
    </dl>
  )
}
export function CompleteObservationStatuses({ report }: { report: ReadyObservationReport }) {
  const { t, i18n } = useTranslation()
  return (
    <TableViewport label={t('runObservability.states')}>
      <table className="data-table data-table--compact">
        <tbody>
          {Object.entries(report.summary.statuses).map(([key, count]) => (
            <tr key={key}>
              <th scope="row">{t('tasks.status.' + key, { defaultValue: key })}</th>
              <td>{BigInt(count).toLocaleString(i18n.language)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </TableViewport>
  )
}

export function CompleteObservationQuality({ report }: { report: ReadyObservationReport }) {
  const { t, i18n } = useTranslation(),
    query = useCompleteObservationPage<Quality>(report, 'quality')
  return (
    <Card title={t('runObservability.dataQuality')}>
      <CompleteObservationPage query={query}>
        {(rows) =>
          rows.length ? (
            <TableViewport label={t('runObservability.dataQuality')}>
              <table className="data-table data-table--compact">
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.key}>
                      <th scope="row">{row.key}</th>
                      <td>{BigInt(row.taskCount).toLocaleString(i18n.language)}</td>
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

export function CompleteObservationCapabilities() {
  const { t } = useTranslation()
  return (
    <Card title={t('runObservability.captureCapabilities')}>
      <p className="muted">{t('runObservability.captureCapabilitiesHint')}</p>
      <dl className="detail-grid detail-grid--centered observation-metrics">
        <dt>Claude Code</dt>
        <dd>{t('runObservability.claudeCapability')}</dd>
        <dt>OpenCode</dt>
        <dd>{t('runObservability.opencodeCapability')}</dd>
        <dt>CrewStation</dt>
        <dd>{t('runObservability.platformCapability')}</dd>
      </dl>
    </Card>
  )
}

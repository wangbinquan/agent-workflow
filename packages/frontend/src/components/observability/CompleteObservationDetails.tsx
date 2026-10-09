import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type {
  CompleteObservationAllocation,
  CompleteObservationAttempt,
  CompleteObservationInvocation,
  ObservationUsageCaptureCommit,
  ObservationNativeRevisionResolution,
  ObservationTaskDetail,
} from '@agent-workflow/shared'
import { Card } from '@/components/Card'
import { EmptyState } from '@/components/EmptyState'
import { Dialog } from '@/components/Dialog'
import { Segmented } from '@/components/Segmented'
import { ExecutionSwimlane } from '@/components/ExecutionSwimlane'
import { TableViewport } from '@/components/TableViewport'
import { CompleteMetrics } from './CompleteObservationMetrics'
import { CompleteObservationPage } from './CompleteObservationPager'
import { CompleteInvocationRows, CompleteAllocationRows } from './CompleteObservationTables'
import { useCompleteObservationPage, type ReadableObservationReport } from './completeReportClient'
import { ObservationNativeCapture } from './ObservationNativeCapture'
import { ObservationPlatformCapture } from './ObservationPlatformCapture'
import { CompleteObservationTrace } from './CompleteObservationTrace'
import {
  projectCompleteAttemptTimeline,
  type CompleteTimelineAlignment,
} from './completeAttemptTimeline'

type Attempt = CompleteObservationAttempt & { readonly taskId: string; readonly taskName: string }
type NativeCapture = ObservationUsageCaptureCommit & {
  readonly taskName?: string
  readonly priorRevisionGap: boolean
  readonly resolutions: readonly ObservationNativeRevisionResolution[]
}
export function CompleteObservationCalls({
  report,
  parent = null,
}: {
  report: ReadableObservationReport
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
            {report.summary.metrics.state !== 'not-ready' && (
              <Card title={t('runObservability.usageRecords')}>
                <CompleteObservationAllocations
                  report={report}
                  parent={JSON.stringify(['invocation', chosen.call.invocationId])}
                />
              </Card>
            )}
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
  report: ReadableObservationReport
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
  report: ReadableObservationReport
  parent?: string | null
}) {
  const { t, i18n } = useTranslation(),
    query = useCompleteObservationPage<Attempt>(report, 'attempts', parent)
  const scope = JSON.stringify([report.header.taskId, report.header.filters, parent])
  const [selected, setSelected] = useState<{
    scope: string
    reportId: string
    attempt: Attempt
  } | null>(null)
  const [returnAttempt, setReturnAttempt] = useState<{
    scope: string
    reportId: string
    attemptId: string
    taskId: string
  } | null>(null)
  const timeline = useRef<HTMLDivElement | null>(null)
  const attemptTrigger = useRef<HTMLButtonElement | null>(null)
  const [alignment, setAlignment] = useState<CompleteTimelineAlignment>('task-relative')
  const crossTask = report.header.taskId === null
  const date = (time: number) => new Date(time).toLocaleString(i18n.language)

  useEffect(() => {
    if (!selected) return
    if (selected.scope !== scope) {
      setSelected(null)
      setReturnAttempt(null)
    } else if (selected.reportId !== report.header.reportId) {
      // The old Dialog closes immediately; its replacement button may not have loaded yet.
      setReturnAttempt({
        scope,
        reportId: report.header.reportId,
        attemptId: selected.attempt.id,
        taskId: selected.attempt.taskId,
      })
      setSelected(null)
    }
  }, [scope, report.header.reportId, selected])

  useEffect(() => {
    if (!returnAttempt) return
    const cancel = () => setReturnAttempt((old) => (old === returnAttempt ? null : old))
    if (
      returnAttempt.scope !== scope ||
      returnAttempt.reportId !== report.header.reportId ||
      query.error ||
      (document.activeElement !== null && document.activeElement !== document.body)
    ) {
      cancel()
      return
    }
    if (query.data && !query.isFetching) {
      const member = query.data.items.find(
        (row) => row.id === returnAttempt.attemptId && row.taskId === returnAttempt.taskId,
      )
      const target = member
        ? Array.from(
            timeline.current?.querySelectorAll<HTMLButtonElement>('[data-execution-id]') ?? [],
          ).find((button) => button.dataset.executionId === member.id)
        : undefined
      target?.focus({ preventScroll: true })
      cancel()
      return
    }
    // Remember any intervening user move, even if its target later unmounts back to body.
    const onFocus = (event: FocusEvent) => {
      if (event.target !== document.body) cancel()
    }
    document.addEventListener('focusin', onFocus)
    document.addEventListener('pointerdown', cancel, true)
    return () => {
      document.removeEventListener('focusin', onFocus)
      document.removeEventListener('pointerdown', cancel, true)
    }
  }, [scope, report.header.reportId, returnAttempt, query.data, query.error, query.isFetching])

  return (
    <div className="stack--md" ref={timeline}>
      <CompleteObservationPage query={query}>
        {(rows) => {
          const display = projectCompleteAttemptTimeline(
            rows,
            report.header.asOf,
            crossTask ? alignment : 'absolute',
          )
          return (
            <div className="stack--md">
              {crossTask && (
                <>
                  <div className="action-row">
                    <Segmented
                      value={alignment}
                      onChange={setAlignment}
                      ariaLabel={t('runObservability.timelineAlignment')}
                      options={[
                        { value: 'task-relative', label: t('runObservability.timelineAlignTasks') },
                        { value: 'absolute', label: t('runObservability.timelineActualTime') },
                      ]}
                    />
                  </div>
                  <p className="muted">
                    {alignment === 'task-relative'
                      ? t('runObservability.timelineAlignedHint')
                      : t('runObservability.timelineActualTimeHint', {
                          from: date(display.from),
                          to: date(display.to),
                        })}
                  </p>
                </>
              )}
              <ExecutionSwimlane
                label={t('runObservability.timeline')}
                rowHeading={t('runObservability.attempt')}
                timeHeading={t(
                  crossTask && alignment === 'task-relative'
                    ? 'runObservability.pageAlignedExecutionRange'
                    : 'runObservability.pageExecutionRange',
                )}
                unknownLabel={t('runObservability.unknownInterval')}
                from={display.from}
                to={display.to}
                onSelect={(id, trigger) => {
                  const attempt = rows.find((row) => row.id === id)
                  if (attempt) {
                    attemptTrigger.current = trigger
                    setSelected({ scope, reportId: report.header.reportId, attempt })
                  }
                }}
                rows={rows.map((row, index) => ({
                  id: row.id,
                  label: (
                    <>
                      {row.nodeId}
                      <div className="muted">{row.taskName}</div>
                    </>
                  ),
                  start: display.intervals[index]!.start,
                  end: display.intervals[index]!.end,
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
            </div>
          )
        }}
      </CompleteObservationPage>
      {selected?.scope === scope && selected.reportId === report.header.reportId && (
        <Dialog
          open
          onClose={() => setSelected(null)}
          title={t('runObservability.attemptDialogTitle', { node: selected.attempt.nodeId })}
          size="lg"
          triggerRef={attemptTrigger}
        >
          <div className="stack--md">
            <CompleteMetrics value={selected.attempt.metrics} />
            <CompleteObservationCalls
              report={report}
              parent={JSON.stringify(['attempt', selected.attempt.id])}
            />
            <CompleteObservationTrace report={report} nodeRunId={selected.attempt.id} />
          </div>
        </Dialog>
      )}
    </div>
  )
}
export function CompleteObservationCaptures({ report }: { report: ReadableObservationReport }) {
  const { t } = useTranslation(),
    native = useCompleteObservationPage<NativeCapture>(report, 'native-captures')
  const platform = useCompleteObservationPage<
    NonNullable<ObservationTaskDetail['platformCaptures']>[number]
  >(report, 'platform-captures')
  return (
    <div className="stack--md">
      <Card title={t('runObservability.nativeCaptureTitle')}>
        <CompleteObservationPage query={native}>
          {(rows) =>
            rows.length ? (
              <ObservationNativeCapture
                embedded
                rows={rows.map((row) => ({
                  invocationId: row.invocationId,
                  taskName: row.taskName,
                  nodeRunId: null,
                  state: row.capture.state,
                  priorRevisionGap: row.priorRevisionGap,
                  proof: row.capture,
                  revisions: row.resolutions,
                }))}
              />
            ) : (
              <EmptyState title={t('runObservability.emptyCaptures')} size="compact" />
            )
          }
        </CompleteObservationPage>
      </Card>
      <Card title={t('runObservability.platformCaptureTitle')}>
        <CompleteObservationPage query={platform}>
          {(rows) =>
            rows.length ? (
              <ObservationPlatformCapture embedded rows={rows} />
            ) : (
              <EmptyState title={t('runObservability.emptyCaptures')} size="compact" />
            )
          }
        </CompleteObservationPage>
      </Card>
    </div>
  )
}
export function CompleteObservationTiming({ report }: { report: ReadableObservationReport }) {
  const { t, i18n } = useTranslation(),
    root = report.summary.rootTask
  const timing = root?.timing
  const ms = (value: string | null) =>
    value === null ? '—' : BigInt(value).toLocaleString(i18n.language) + ' ms'
  return (
    <dl className="detail-grid observation-metrics">
      <dt>{t('runObservability.wall')}</dt>
      <dd>{ms(timing ? timing.wallMs : report.summary.timing.wallMs)}</dd>
      {(!root || root.task.runningMs !== null) && (
        <>
          <dt>
            {t(
              !timing && report.summary.timing.recordedRunningMs !== undefined
                ? 'runObservability.recordedRunning'
                : 'runObservability.running',
            )}
          </dt>
          <dd>
            {ms(
              timing
                ? timing.runningMs
                : (report.summary.timing.recordedRunningMs ?? report.summary.timing.runningMs),
            )}
            {!timing && report.summary.timing.runningCoverage && (
              <span className="muted">
                {' · '}
                {t('runObservability.runningCoverage', {
                  observed: BigInt(
                    report.summary.timing.runningCoverage.observedTasks,
                  ).toLocaleString(i18n.language),
                  tasks: BigInt(report.summary.timing.runningCoverage.tasks).toLocaleString(
                    i18n.language,
                  ),
                })}
              </span>
            )}
          </dd>
        </>
      )}
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
export function CompleteObservationStatuses({ report }: { report: ReadableObservationReport }) {
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

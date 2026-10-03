import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { CompleteObservationTraceStatus, ObservationSpanDetail } from '@agent-workflow/shared'
import { Card } from '@/components/Card'
import { Dialog } from '@/components/Dialog'
import { EmptyState } from '@/components/EmptyState'
import { ExecutionSwimlane } from '@/components/ExecutionSwimlane'
import { NoticeBanner } from '@/components/NoticeBanner'
import { CompleteObservationPage } from './CompleteObservationPager'
import { useCompleteObservationPage, type ReadableObservationReport } from './completeReportClient'
import { formatObservationCny } from './formatObservations'
import './ObservationTrace.css'

/** Display one page from the same sealed full Task report, with no cumulative-page ceiling. */
export function CompleteObservationTrace({
  report,
  nodeRunId,
}: {
  readonly report: ReadableObservationReport
  readonly nodeRunId: string
}) {
  const { t, i18n } = useTranslation(),
    parent = JSON.stringify(['attempt', nodeRunId])
  const statuses = useCompleteObservationPage<CompleteObservationTraceStatus>(
      report,
      'span-statuses',
      parent,
    ),
    query = useCompleteObservationPage<ObservationSpanDetail>(report, 'span-facts', parent)
  const [chosen, setChosen] = useState<{
    reportId: string
    nodeRunId: string
    span: ObservationSpanDetail
  } | null>(null)
  const trigger = useRef<HTMLButtonElement | null>(null)
  const title = (span: ObservationSpanDetail) =>
    `${t(`runObservability.traceKind_${span.fact.scope.kind}`)} · ${span.fact.label}`
  const date = (time: number | null) =>
    time === null ? t('runObservability.unknown') : new Date(time).toLocaleString(i18n.language)
  const identity = (span: ObservationSpanDetail) =>
    JSON.stringify([span.fact.invocationId, span.fact.spanKey])
  const selected =
    chosen?.reportId === report.header.reportId && chosen.nodeRunId === nodeRunId
      ? chosen.span
      : null
  return (
    <div className="stack--md observation-trace">
      <h3>{t('runObservability.traceTitle')}</h3>
      <p className="muted">{t('runObservability.traceHint')}</p>
      <CompleteObservationPage query={statuses}>
        {(rows) => {
          const status = rows[0]
          return status?.state === 'complete' ? (
            <>
              <p className="muted">
                {t('runObservability.traceCompleteCount', {
                  total: BigInt(status.spanCount).toLocaleString(i18n.language),
                })}
              </p>
              {status.priorRepairCount !== '0' && (
                <NoticeBanner tone="info" size="compact">
                  {t('runObservability.tracePriorRepairExact', {
                    total: BigInt(status.priorRepairCount).toLocaleString(i18n.language),
                  })}
                </NoticeBanner>
              )}
            </>
          ) : status?.state === 'not-applicable' ? (
            <p className="muted">{t('runObservability.notApplicable')}</p>
          ) : (
            <NoticeBanner tone="warning" size="compact">
              {t('runObservability.tracePartial')}
            </NoticeBanner>
          )
        }}
      </CompleteObservationPage>
      <CompleteObservationPage query={query}>
        {(rows) => {
          const status = statuses.data?.items[0],
            range =
              status?.state === 'complete'
                ? status.range
                : status?.state === 'not-ready'
                  ? status.knownRange
                  : null,
            from = range?.from ?? report.header.asOf,
            to = Math.max(from + 1, range?.to ?? from + 1)
          return rows.length ? (
            <ExecutionSwimlane
              label={t('runObservability.traceTitle')}
              rowHeading={t('runObservability.traceName')}
              timeHeading={
                range ? `${date(from)} → ${date(to)}` : t('runObservability.unknownInterval')
              }
              unknownLabel={t('runObservability.unknownInterval')}
              from={from}
              to={to}
              onSelect={(id, button) => {
                const span = rows.find((row) => identity(row) === id)
                if (span) {
                  trigger.current = button
                  setChosen({ reportId: report.header.reportId, nodeRunId, span })
                }
              }}
              rows={rows.map((span) => ({
                id: identity(span),
                label: (
                  <>
                    {title(span)}
                    <div className="muted">
                      {t(`runObservability.traceStatus_${span.fact.state.status}`)}
                    </div>
                  </>
                ),
                start: span.fact.state.startedAt,
                end: span.fact.state.endedAt,
                open: span.fact.state.status === 'open',
                point: span.fact.state.startedAt === null && span.fact.state.endedAt !== null,
                description: title(span),
                detail:
                  span.durationMs === null
                    ? t('runObservability.unknownInterval')
                    : `${BigInt(span.durationMs).toLocaleString(i18n.language)} ms`,
              }))}
            />
          ) : (
            <EmptyState title={t('runObservability.traceEmpty')} size="compact" />
          )
        }}
      </CompleteObservationPage>
      {selected && (
        <Dialog
          open
          onClose={() => setChosen(null)}
          title={title(selected)}
          size="lg"
          triggerRef={trigger}
        >
          <div className="stack--md">
            <Card title={t('runObservability.traceTitle')}>
              <dl className="observation-trace__details">
                <div>
                  <dt>{t('runObservability.traceStart')}</dt>
                  <dd>{date(selected.fact.state.startedAt)}</dd>
                </div>
                <div>
                  <dt>{t('runObservability.traceEnd')}</dt>
                  <dd>{date(selected.fact.state.endedAt)}</dd>
                </div>
                <div>
                  <dt>{t('runObservability.traceDuration')}</dt>
                  <dd>
                    {selected.durationMs === null
                      ? t('runObservability.unknownInterval')
                      : `${BigInt(selected.durationMs).toLocaleString(i18n.language)} ms`}
                  </dd>
                </div>
                <div>
                  <dt>{t('runObservability.traceResult')}</dt>
                  <dd>{t(`runObservability.traceStatus_${selected.fact.state.status}`)}</dd>
                </div>
                <div>
                  <dt>{t('runObservability.actualModel')}</dt>
                  <dd>{selected.fact.model?.id ?? t('runObservability.modelUnknown')}</dd>
                </div>
                <div>
                  <dt>{t('runObservability.cost')}</dt>
                  <dd>
                    {selected.cost?.completeness === 'complete' &&
                    selected.cost.amountDecimal !== null
                      ? formatObservationCny(selected.cost.amountDecimal, true)
                      : '—'}
                  </dd>
                </div>
              </dl>
            </Card>
            <Card title={t('runObservability.usageRecords')}>
              <dl className="observation-token-buckets">
                {(['input', 'cacheRead', 'cacheWrite', 'output'] as const).map((bucket) => (
                  <div key={bucket}>
                    <dt>{t(`runObservability.${bucket}`)}</dt>
                    <dd>
                      {selected.usage?.[bucket] == null
                        ? '—'
                        : BigInt(selected.usage[bucket]!).toLocaleString(i18n.language)}
                    </dd>
                  </div>
                ))}
              </dl>
              <p className="muted">{t('runObservability.traceCostHint')}</p>
              <details>
                <summary>{t('runObservability.traceIdentity')}</summary>
                <dl className="observation-trace__details">
                  <div>
                    <dt>{t('runObservability.traceNativeCall')}</dt>
                    <dd>{selected.fact.scope.callId}</dd>
                  </div>
                  <div>
                    <dt>{t('runObservability.traceNativeSession')}</dt>
                    <dd>{selected.fact.scope.nativeSessionId}</dd>
                  </div>
                  <div>
                    <dt>{t('runObservability.traceParentCall')}</dt>
                    <dd>{selected.fact.parentCallId ?? '—'}</dd>
                  </div>
                </dl>
              </details>
            </Card>
          </div>
        </Dialog>
      )}
    </div>
  )
}

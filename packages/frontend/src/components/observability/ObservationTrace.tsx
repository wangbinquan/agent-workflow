import { useInfiniteQuery } from '@tanstack/react-query'
import { useEffect, useMemo, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import type { ObservationSpanDetail, ObservationTaskSpans } from '@agent-workflow/shared'
import { api } from '@/api/client'
import { Card } from '@/components/Card'
import { EmptyState } from '@/components/EmptyState'
import { ErrorBanner } from '@/components/ErrorBanner'
import { ExecutionSwimlane } from '@/components/ExecutionSwimlane'
import { LoadingState } from '@/components/LoadingState'
import { NoticeBanner } from '@/components/NoticeBanner'
import { formatDurationMs } from '@/lib/duration'
import { formatObservationCny } from './formatObservations'
import './ObservationTrace.css'

export default function ObservationTrace(props: {
  readonly taskId: string
  readonly nodeRunId: string
  readonly selectedSpan?: string
  readonly onSelectSpan: (value: string | undefined) => void
}) {
  const { t, i18n } = useTranslation(),
    trigger = useRef<HTMLButtonElement | null>(null),
    heading = useRef<HTMLHeadingElement | null>(null),
    panel = useRef<HTMLDivElement | null>(null)
  const query = useInfiniteQuery({
    queryKey: ['run-observability', 'spans', props.taskId, props.nodeRunId],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) =>
      api.get<ObservationTaskSpans>(
        `/api/observability/tasks/${encodeURIComponent(props.taskId)}/spans`,
        { nodeRunId: props.nodeRunId, limit: '200', ...(pageParam ? { after: pageParam } : {}) },
        signal,
      ),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  })
  const spans = useMemo(
    () => [
      ...new Map(
        (query.data?.pages.flatMap((page) => page.spans) ?? []).map((span) => [
          span.fact.spanKey,
          span,
        ]),
      ).values(),
    ],
    [query.data],
  )
  const selected = spans.find((span) => span.fact.spanKey === props.selectedSpan)
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = query
  const pageCount = query.data?.pages.length ?? 0,
    selectedKey = selected?.fact.spanKey
  useEffect(() => {
    if (props.selectedSpan && !selected && hasNextPage && !isFetchingNextPage && pageCount < 100)
      void fetchNextPage()
  }, [props.selectedSpan, selected, hasNextPage, isFetchingNextPage, pageCount, fetchNextPage])
  useEffect(() => {
    if (selectedKey) heading.current?.focus()
  }, [selectedKey])
  const boundaries = spans
    .flatMap((span) => [span.fact.state.startedAt, span.fact.state.endedAt])
    .filter((value): value is number => value !== null)
  const from = boundaries.length ? Math.min(...boundaries) : 0,
    to = boundaries.length ? Math.max(...boundaries) : 1
  const duration = (value: number) => {
    const text = formatDurationMs(value)
    return t(`common.dur.${text.key}`, text.opts)
  }
  const date = (value: number | null) =>
    value === null ? t('runObservability.unknown') : new Date(value).toLocaleString(i18n.language)
  const title = (span: ObservationSpanDetail) =>
    `${t(`runObservability.traceKind_${span.fact.scope.kind}`)} · ${span.fact.label}`
  const pages = query.data?.pages ?? [],
    partial = pages.some((page) => page.partial)
  if (query.isPending) return <LoadingState />
  if (query.isError) return <ErrorBanner error={query.error} />
  return (
    <div className="stack--md observation-trace" ref={panel}>
      <div className="observation-trace__header">
        <h3>{t('runObservability.traceTitle')}</h3>
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          onClick={() => void query.refetch()}
          disabled={query.isFetching}
        >
          {t('runObservability.traceRefresh')}
        </button>
      </div>
      <p className="muted">{t('runObservability.traceHint')}</p>
      {partial && (
        <NoticeBanner tone="warning" size="compact">
          {t('runObservability.tracePartial')}
        </NoticeBanner>
      )}
      {pages.some((page) => page.priorRepairCount > 0) && (
        <NoticeBanner tone="info" size="compact">
          {t('runObservability.tracePriorRepair', {
            count: Math.max(...pages.map((page) => page.priorRepairCount)),
          })}
        </NoticeBanner>
      )}
      {!spans.length ? (
        <EmptyState title={t('runObservability.traceEmpty')} size="compact" />
      ) : (
        <ExecutionSwimlane
          label={t('runObservability.traceTitle')}
          rowHeading={t('runObservability.traceName')}
          timeHeading={
            from === 0 && to === 1
              ? t('runObservability.unknownInterval')
              : `${date(from)} → ${date(to)}`
          }
          unknownLabel={t('runObservability.unknownInterval')}
          from={from}
          to={to}
          onSelect={(id, button) => {
            trigger.current = button
            props.onSelectSpan(id)
          }}
          rows={spans.map((span) => ({
            id: span.fact.spanKey,
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
                : duration(span.durationMs),
          }))}
        />
      )}
      {query.hasNextPage && (
        <button
          type="button"
          className="btn btn--sm"
          disabled={query.isFetchingNextPage}
          onClick={() => void query.fetchNextPage()}
        >
          {t('runObservability.traceMore')}
        </button>
      )}
      {props.selectedSpan && !selected && !query.isFetching && (
        <NoticeBanner tone="info" size="compact">
          {t('runObservability.traceMissing')}
        </NoticeBanner>
      )}
      {selected && (
        <Card
          title={title(selected)}
          titleRef={heading}
          actions={
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={() => {
                const row = trigger.current?.isConnected
                  ? trigger.current
                  : [
                      ...(panel.current?.querySelectorAll<HTMLButtonElement>(
                        'button[data-execution-id]',
                      ) ?? []),
                    ].find((button) => button.dataset.executionId === selected.fact.spanKey)
                props.onSelectSpan(undefined)
                row?.focus()
              }}
            >
              ← {t('runObservability.traceBack')}
            </button>
          }
        >
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
                  : duration(selected.durationMs)}
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
                {selected.cost?.amountDecimal === null || !selected.cost
                  ? '—'
                  : formatObservationCny(selected.cost.amountDecimal, true)}
                {selected.cost?.completeness === 'partial' && ` · ${t('runObservability.partial')}`}
              </dd>
            </div>
          </dl>
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
      )}
    </div>
  )
}

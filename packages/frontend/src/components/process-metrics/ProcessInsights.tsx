// RFC-616 §9 — improvement points: every hint the fixed rules produced, and the
// text-theme analysis. The analysis is the only part of process metrics that
// calls a model, so it runs only when asked (or weekly, if configured), says
// what it read and for whom, and shows people's own words next to each theme.
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import type {
  ProcessInsightView,
  ProcessSubjectKind,
  ProcessSubjectSummary,
  ProcessThemeGroup,
} from '@agent-workflow/shared'
import { Card } from '@/components/Card'
import { EmptyState } from '@/components/EmptyState'
import { ErrorBanner } from '@/components/ErrorBanner'
import { LoadingState } from '@/components/LoadingState'
import { MeterBar } from '@/components/MeterBar'
import { NoticeBanner } from '@/components/NoticeBanner'
import type { ObservationWindow } from '@/components/observability/observationClient'
import { ProcessHints } from './ProcessHints'
import { PROCESS_QUERY, processApi } from './processClient'
import { labelText, percent, type ProcessLabel, type Translate } from './processFormat'
import { systemStageMessageKey } from './processNames'
import type { ProcessView } from './processSearch'

/** How often the page asks whether a queued or running analysis has finished. */
export const INSIGHT_POLL_MS = 2_000

function stageText(
  key: string,
  labels: Readonly<Record<string, ProcessLabel>>,
  t: Translate,
  language: string,
) {
  const label = labels[key]
  if (label === undefined || label === key)
    return t(`processMetrics.systemStage.${systemStageMessageKey(key)}`, { defaultValue: key })
  return labelText(label, language)
}

function ThemeGroup(props: {
  group: ProcessThemeGroup
  kind: ProcessSubjectKind
  labels: Readonly<Record<string, ProcessLabel>>
}) {
  const { t, i18n } = useTranslation()
  const { group } = props
  return (
    <section className="process-themes__group" data-source={group.source}>
      <h4 className="process-metrics__subtitle">
        {t(`processMetrics.themes.source.${group.source}`)}
      </h4>
      <p className="muted process-metrics__note">
        {t(`processMetrics.themes.items.${group.source}`, { count: group.items })}
        {group.truncated ? ` ${t('processMetrics.themes.truncated')}` : ''}
      </p>
      {group.themes.length === 0 ? (
        <p className="muted process-metrics__note">{t('processMetrics.themes.noThemes')}</p>
      ) : (
        group.themes.map((theme, index) => (
          // Two themes of one source may be given the same name by the model.
          <div key={`${index}:${theme.name}`} className="process-theme">
            <div className="process-theme__head">
              <span className="process-theme__name">{theme.name}</span>
              <span className="muted process-metrics__note">
                {t(`processMetrics.themes.items.${group.source}`, { count: theme.items })}
                {theme.stages.length > 0
                  ? ` · ${t('processMetrics.themes.stages', {
                      stages: theme.stages
                        .map((key) => stageText(key, props.labels, t, i18n.language))
                        .join(t('processMetrics.listSeparator')),
                    })}`
                  : ''}
              </span>
            </div>
            <MeterBar share={theme.share} valueText={percent(theme.share)} />
            {theme.quotes.map((quote, index) => (
              <blockquote key={index} className="process-theme__quote">
                {quote.text}{' '}
                {props.kind === 'digital-employee' ? (
                  <Link
                    className="data-table__link"
                    to="/tasks/employee-cases/$caseId"
                    params={{ caseId: quote.unitId }}
                  >
                    {t('processMetrics.themes.source.link.digital-employee')}
                  </Link>
                ) : (
                  <Link className="data-table__link" to="/tasks/$id" params={{ id: quote.unitId }}>
                    {t('processMetrics.themes.source.link.task')}
                  </Link>
                )}
              </blockquote>
            ))}
            {theme.advice ? (
              <p className="process-theme__advice">
                <strong>{t('processMetrics.themes.advice')}</strong>
                {theme.advice}
              </p>
            ) : null}
          </div>
        ))
      )}
      {group.otherItems > 0 && group.themes.length > 0 ? (
        <p className="muted process-metrics__note">
          {t('processMetrics.themes.other', { count: group.otherItems })}
        </p>
      ) : null}
    </section>
  )
}

function ThemesCard(props: {
  kind: ProcessSubjectKind
  subjectId: string | null
  window: ObservationWindow
}) {
  const { t, i18n } = useTranslation()
  const { kind, subjectId, window } = props
  const client = useQueryClient()
  // "Nothing to read" is an answer about one subject and one range: it must not outlive them.
  const asked = `${kind}\u0000${subjectId ?? ''}\u0000${window.from}\u0000${window.to}`
  const [emptyFor, setEmptyFor] = useState<string | null>(null)
  const nothingToRead = emptyFor === asked
  const key = [...PROCESS_QUERY, 'insight', kind, subjectId, window.from, window.to]
  const view = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => processApi.insight(kind, subjectId, window, signal),
    // The summary never polls; only an analysis in flight is watched.
    refetchInterval: (query) =>
      (query.state.data as ProcessInsightView | undefined)?.active ? INSIGHT_POLL_MS : false,
  })
  const request = useMutation({
    mutationFn: () => processApi.requestInsight(kind, subjectId, window),
    onSuccess: (accepted) => {
      setEmptyFor(accepted.status === 'empty' ? asked : null)
      void client.invalidateQueries({ queryKey: key })
    },
  })
  const unit = t(`processMetrics.unit.${kind}`)
  const data = view.data
  const busy = request.isPending || (data?.active ?? null) !== null
  const result = data?.result ?? null
  return (
    <Card
      title={t('processMetrics.themes.title')}
      header={
        <p className="muted process-metrics__note">
          {t('processMetrics.themes.subtitle')}{' '}
          {data ? t(`processMetrics.themes.schedule.${data.schedule}`) : ''}
        </p>
      }
    >
      {view.isLoading ? (
        <LoadingState size="compact" />
      ) : view.error ? (
        <ErrorBanner error={view.error} onRetry={() => void view.refetch()} />
      ) : data ? (
        <>
          <div className="process-metrics__row">
            <span className="muted process-metrics__note">
              {t(`processMetrics.themes.scope.${data.scope}`, { unit })}
              {result
                ? ` · ${t('processMetrics.themes.generatedAt', {
                    time: new Date(result.finishedAt).toLocaleString(i18n.language),
                    trigger: t(`processMetrics.themes.trigger.${result.trigger}`),
                  })} · ${t('processMetrics.themes.covers', {
                    // The result on screen was made for its own range, which need not be the
                    // range chosen now.
                    from: new Date(result.windowFrom).toLocaleDateString(i18n.language),
                    to: new Date(result.windowTo).toLocaleDateString(i18n.language),
                  })}`
                : ''}
            </span>
            <button
              type="button"
              className="btn btn--primary btn--sm"
              disabled={busy}
              data-testid="process-insight-run"
              onClick={() => request.mutate()}
            >
              {data.active?.status === 'pending'
                ? t('processMetrics.themes.queued')
                : busy
                  ? t('processMetrics.themes.running')
                  : t(result ? 'processMetrics.themes.rerun' : 'processMetrics.themes.run')}
            </button>
          </div>
          {request.error ? <ErrorBanner error={request.error} /> : null}
          {nothingToRead ? (
            <NoticeBanner tone="info">{t('processMetrics.themes.nothing', { unit })}</NoticeBanner>
          ) : null}
          {data.failure ? (
            <NoticeBanner tone="error" title={t('processMetrics.themes.failed')}>
              {t(`processMetrics.themes.failure.${data.failure.code}`, {
                defaultValue: data.failure.message || data.failure.code,
              })}{' '}
              {result ? t('processMetrics.themes.failedKept') : ''}
            </NoticeBanner>
          ) : null}
          {data.stale && !busy ? (
            <NoticeBanner tone="info">{t('processMetrics.themes.stale')}</NoticeBanner>
          ) : null}
          {result === null ? (
            busy ? null : (
              <EmptyState
                size="compact"
                title={t('processMetrics.themes.never')}
                description={t('processMetrics.themes.neverHint')}
              />
            )
          ) : result.groups.length === 0 ? (
            <EmptyState size="compact" title={t('processMetrics.themes.nothing', { unit })} />
          ) : (
            <div className="process-themes">
              {result.groups.map((group) => (
                <ThemeGroup
                  key={group.source}
                  group={group}
                  kind={kind}
                  labels={result.stageLabels}
                />
              ))}
            </div>
          )}
        </>
      ) : null}
    </Card>
  )
}

export function ProcessInsights(props: {
  summary: ProcessSubjectSummary
  kind: ProcessSubjectKind
  subjectId: string | null
  window: ObservationWindow
  onView: (view: ProcessView) => void
}) {
  return (
    <>
      <ProcessHints summary={props.summary} onView={props.onView} />
      <ThemesCard kind={props.kind} subjectId={props.subjectId} window={props.window} />
    </>
  )
}

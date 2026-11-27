// RFC-616 §11 — one subject's process metrics: what the numbers cover, the
// comparison controls, and the views of that subject kind. The summary is one
// (heavy) request shared by every view; only the unit listing and the text-theme
// analysis fetch on their own.
import { useMemo } from 'react'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import type {
  ProcessCompareMode,
  ProcessOrigin,
  ProcessSubjectKind,
  ProcessSubjectSummary,
} from '@agent-workflow/shared'
import { ErrorBanner } from '@/components/ErrorBanner'
import { FilterBar, FilterField } from '@/components/FilterBar'
import { LoadingState } from '@/components/LoadingState'
import { NoticeBanner } from '@/components/NoticeBanner'
import { PageHeader } from '@/components/PageHeader'
import { Segmented } from '@/components/Segmented'
import { Select } from '@/components/Select'
import { TabBar, tabDomIds } from '@/components/TabBar'
import type { ObservationSearch } from '@/components/observability/RunObservability'
import type { ObservationWindow } from '@/components/observability/observationClient'
import { ProcessDuties } from './ProcessDuties'
import { ProcessGates } from './ProcessGates'
import { ProcessInsights } from './ProcessInsights'
import { ProcessMembers } from './ProcessMembers'
import { ProcessOverview } from './ProcessOverview'
import { ProcessRounds } from './ProcessRounds'
import { ProcessStages } from './ProcessStages'
import { subjectTitle } from './ProcessSubjectList'
import { ProcessUnits } from './ProcessUnits'
import { PROCESS_QUERY, processApi, type ProcessSummaryOptions } from './processClient'
import type { Translate } from './processFormat'
import { PROCESS_VIEWS_OF, type ProcessView } from './processSearch'

const ALL_ORIGINS = 'all'

/** What the statistics do and do not cover, as short sentences. */
export function dataNotes(summary: ProcessSubjectSummary, t: Translate): string[] {
  const unit = t(`processMetrics.unit.${summary.kind}`)
  const { note } = summary
  const notes: string[] = []
  if (note.unitsWithoutUsage > 0)
    notes.push(t('processMetrics.note.withoutUsage', { count: note.unitsWithoutUsage, unit }))
  if (note.unitsWithoutRuntime > 0)
    notes.push(t('processMetrics.note.withoutRuntime', { count: note.unitsWithoutRuntime, unit }))
  if (note.runsWithoutCause > 0)
    notes.push(t('processMetrics.note.withoutCause', { count: note.runsWithoutCause }))
  if (note.usageLowerBound) notes.push(t('processMetrics.note.usageLowerBound'))
  if (note.unpriced) notes.push(t('processMetrics.note.unpriced'))
  notes.push(t('processMetrics.note.activeExcluded', { unit }))
  return notes
}

export function ProcessSubject(props: {
  kind: ProcessSubjectKind
  subjectId: string | null
  search: ObservationSearch
  window: ObservationWindow
  onChange: (next: ObservationSearch) => void
  onBack: () => void
}) {
  const { t } = useTranslation()
  const { kind, subjectId, search, window, onChange } = props
  const compare: ProcessCompareMode = search.compare ?? 'off'
  const options = useMemo<ProcessSummaryOptions>(
    () => ({
      compare,
      ...(compare === 'version' && search.split !== undefined ? { split: search.split } : {}),
      ...(search.origin === undefined ? {} : { origin: search.origin }),
    }),
    [compare, search.split, search.origin],
  )
  const summary = useQuery({
    queryKey: [
      ...PROCESS_QUERY,
      'summary',
      kind,
      subjectId,
      window.from,
      window.to,
      window.tzOffset,
      options,
    ],
    queryFn: ({ signal }) => processApi.summary(kind, subjectId, window, options, signal),
    placeholderData: keepPreviousData,
  })
  // The previous answer stays on screen while a filter changes, but never another subject's.
  const data =
    summary.data?.kind === kind && summary.data.subjectId === subjectId ? summary.data : undefined
  const views = PROCESS_VIEWS_OF[kind]
  const view: ProcessView =
    search.view !== undefined && views.includes(search.view) ? search.view : 'overview'
  const ids = tabDomIds('process-view', view)
  const setView = (next: ProcessView) => {
    const { view: _view, unit: _unit, ...rest } = search
    onChange(next === 'overview' ? rest : { ...rest, view: next })
  }
  const setCompare = (next: ProcessCompareMode) => {
    const { compare: _compare, split: _split, ...rest } = search
    if (next === 'off') onChange(rest)
    else if (next === 'period') onChange({ ...rest, compare: 'period' })
    else {
      const newest = data?.revisions[0]?.revision
      if (newest !== undefined)
        onChange({ ...rest, compare: 'version', split: search.split ?? newest })
    }
  }
  const back = (
    <button type="button" className="btn btn--ghost btn--sm" onClick={props.onBack}>
      <span aria-hidden="true">← </span>
      {t(`processMetrics.back.${kind}`)}
    </button>
  )
  if (data === undefined) {
    return (
      <div className="process-metrics stack--md">
        <div>{back}</div>
        {summary.error ? (
          <ErrorBanner error={summary.error} onRetry={() => void summary.refetch()} />
        ) : (
          <LoadingState label={t('processMetrics.computing')} />
        )}
      </div>
    )
  }
  const versionable = kind !== 'workgroup' && data.revisions.length >= 2
  const splitOptions = data.revisions.slice(0, -1).map((entry) => ({
    value: String(entry.revision),
    label: t(`processMetrics.compare.revision.${kind === 'workflow' ? 'workflow' : 'employee'}`, {
      revision: entry.revision,
      count: entry.units,
    }),
  }))
  const origins = data.kind === 'workflow' ? data.origins : []
  // The answer on screen may still be the previous one while a new one is computed; every
  // sentence about the comparison is read from the answer, never from the URL that asked.
  const shown = data.compare
  // Also on Refresh, when the same question is asked again: a summary can take a second or two.
  const computing = summary.isFetching
  return (
    <div className="process-metrics stack--md" aria-busy={summary.isFetching}>
      <PageHeader
        headingLevel={2}
        // The heading is a column: without this wrapper the button stretches across the page.
        back={<div className="page__heading-back">{back}</div>}
        title={subjectTitle(kind, subjectId, data.subjectName, t)}
        meta={
          <span className="muted">
            {t(`processMetrics.kind.${kind}`)}
            {data.kind === 'workgroup' && data.mode !== null
              ? ` · ${t(`processMetrics.mode.${data.mode}`)}`
              : ''}
            {data.kind === 'workflow' ? ` · ${t('processMetrics.acrossRevisions')}` : ''}
            {' · '}
            {t(`processMetrics.scope.${data.scope}.${kind}`)}
          </span>
        }
      />

      <FilterBar
        ariaLabel={t('processMetrics.filtersLabel')}
        density="compact"
        trailing={
          computing ? (
            <span className="muted" role="status" aria-live="polite">
              {t('processMetrics.computing')}
            </span>
          ) : undefined
        }
      >
        {origins.length > 1 || search.origin !== undefined ? (
          <FilterField label={t('processMetrics.origin.label')}>
            <Select<string>
              value={search.origin ?? ALL_ORIGINS}
              ariaLabel={t('processMetrics.origin.label')}
              data-testid="process-origin"
              options={[
                { value: ALL_ORIGINS, label: t('processMetrics.origin.all') },
                ...origins.map((entry) => ({
                  value: entry.origin,
                  label: t('processMetrics.origin.option', {
                    name: t(`processMetrics.origin.${entry.origin}`),
                    count: entry.units,
                  }),
                })),
              ]}
              onChange={(value) => {
                const { origin: _origin, ...rest } = search
                onChange(value === ALL_ORIGINS ? rest : { ...rest, origin: value as ProcessOrigin })
              }}
            />
          </FilterField>
        ) : null}
        <FilterField label={t('processMetrics.compare.label')}>
          <div className="page-filter process-metrics__picker">
            <Segmented<ProcessCompareMode>
              value={compare}
              ariaLabel={t('processMetrics.compare.label')}
              testidPrefix="process-compare"
              options={[
                { value: 'off', label: t('processMetrics.compare.off') },
                { value: 'period', label: t('processMetrics.compare.period') },
                ...(kind === 'workgroup'
                  ? []
                  : [
                      {
                        value: 'version' as const,
                        label: t(
                          `processMetrics.compare.version.${kind === 'workflow' ? 'workflow' : 'employee'}`,
                        ),
                        disabled: !versionable && compare !== 'version',
                        ...(versionable ? {} : { title: t('processMetrics.compare.oneRevision') }),
                      },
                    ]),
              ]}
              onChange={setCompare}
            />
          </div>
          {compare === 'version' && splitOptions.length > 0 ? (
            <Select<string>
              value={String(search.split ?? data.revisions[0]?.revision ?? '')}
              ariaLabel={t('processMetrics.compare.splitLabel')}
              data-testid="process-split"
              options={splitOptions}
              onChange={(value) =>
                onChange({ ...search, compare: 'version', split: Number(value) })
              }
            />
          ) : null}
        </FilterField>
      </FilterBar>

      {data.note.partial ? (
        <NoticeBanner tone="warning">
          {t(`processMetrics.partial.${kind}`, { limit: data.note.unitLimit })}
        </NoticeBanner>
      ) : null}
      {shown.mode !== 'off' ? (
        <p className="muted process-metrics__note">
          {shown.baselineUnits === 0
            ? t('processMetrics.compare.noBaseline')
            : t(`processMetrics.compare.basis.${shown.mode}`, {
                count: shown.baselineUnits,
                unit: t(`processMetrics.unit.${kind}`),
                revision: shown.split ?? '',
              })}
        </p>
      ) : null}
      <p className="muted process-metrics__note">
        {t('processMetrics.note.title')} {dataNotes(data, t).join(' ')}
      </p>

      <TabBar<ProcessView>
        tabs={views.map((key) => ({
          key,
          label: t(
            key === 'units' ? `processMetrics.view.units.${kind}` : `processMetrics.view.${key}`,
          ),
        }))}
        active={view}
        onSelect={setView}
        ariaLabel={t('processMetrics.viewsLabel')}
        idPrefix="process-view"
      />
      <div role="tabpanel" id={ids.panelId} aria-labelledby={ids.tabId} className="stack--md">
        {view === 'overview' ? <ProcessOverview summary={data} onView={setView} /> : null}
        {view === 'stages' && data.kind === 'workflow' ? <ProcessStages summary={data} /> : null}
        {view === 'rounds' && data.kind === 'workgroup' ? <ProcessRounds summary={data} /> : null}
        {view === 'members' && data.kind === 'workgroup' ? <ProcessMembers summary={data} /> : null}
        {view === 'duties' && data.kind === 'digital-employee' ? (
          <ProcessDuties summary={data} />
        ) : null}
        {view === 'gates' ? <ProcessGates summary={data} /> : null}
        {view === 'units' ? (
          <ProcessUnits
            kind={kind}
            subjectId={subjectId}
            window={window}
            origin={search.origin}
            openUnit={search.unit}
            onOpenUnit={(unitId) => {
              const { unit: _unit, ...rest } = search
              onChange(unitId === null ? rest : { ...rest, unit: unitId })
            }}
          />
        ) : null}
        {view === 'insights' ? (
          <ProcessInsights
            summary={data}
            kind={kind}
            subjectId={subjectId}
            window={window}
            onView={setView}
          />
        ) : null}
      </div>
    </div>
  )
}

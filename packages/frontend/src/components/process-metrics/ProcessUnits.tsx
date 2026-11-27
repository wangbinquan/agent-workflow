// RFC-616 §11 — the tasks (or a digital employee's assignments) of one subject,
// newest first. Every row can be expanded into its stages; units that are still
// running are listed here even though they are not in the statistics.
import { Fragment, useState, type CSSProperties } from 'react'
import { keepPreviousData, useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import {
  PROCESS_UNIT_FILTERS,
  TaskStatusSchema,
  type ProcessIdentity,
  type ProcessOrigin,
  type ProcessSubjectKind,
  type ProcessUnitFilter,
  type ProcessUnitPage,
  type ProcessUnitRow,
  type ProcessUnitStatus,
} from '@agent-workflow/shared'
import { EmptyState } from '@/components/EmptyState'
import { ErrorBanner } from '@/components/ErrorBanner'
import { FilterBar } from '@/components/FilterBar'
import { LoadingState } from '@/components/LoadingState'
import { NoticeBanner } from '@/components/NoticeBanner'
import { OwnerLabel } from '@/components/OwnerLabel'
import { Segmented } from '@/components/Segmented'
import { SegmentedBar, SegmentedBarLegend } from '@/components/SegmentedBar'
import { StatusChip, type StatusChipKind } from '@/components/StatusChip'
import { TableViewport } from '@/components/TableViewport'
import { TaskStatusChip } from '@/components/TaskStatusChip'
import type { ObservationWindow } from '@/components/observability/observationClient'
import { PROCESS_QUERY, processApi } from './processClient'
import {
  cost,
  count,
  duration,
  labelText,
  coloredWaits,
  pricedCost,
  timeLegend,
  timeParts,
  tokens,
  type Translate,
} from './processFormat'
import { stageName, stageTree } from './processNames'

const STATUS_CHIP: Readonly<Record<ProcessUnitStatus, StatusChipKind>> = {
  succeeded: 'success',
  failed: 'danger',
  canceled: 'neutral',
  active: 'info',
}

const roundsOf = (row: ProcessUnitRow, kind: string) =>
  row.gateRounds.find((entry) => entry.kind === kind)?.rounds ?? 0

type ColumnKey =
  | 'status'
  | 'origin'
  | 'owner'
  | 'started'
  | 'lead'
  | 'split'
  | 'tokens'
  | 'cost'
  | 'reviewRounds'
  | 'clarifyRounds'
  | 'retries'
  | 'rounds'
  | 'assignments'
  | 'completion'
  | 'rework'

const COLUMNS: Readonly<Record<ProcessSubjectKind, readonly ColumnKey[]>> = {
  workflow: [
    'status',
    'origin',
    'owner',
    'started',
    'lead',
    'split',
    'tokens',
    'cost',
    'reviewRounds',
    'clarifyRounds',
    'retries',
  ],
  workgroup: [
    'status',
    'owner',
    'started',
    'lead',
    'split',
    'rounds',
    'assignments',
    'tokens',
    'cost',
    'completion',
  ],
  'digital-employee': ['status', 'owner', 'started', 'lead', 'rework', 'tokens', 'cost'],
}

const NUMERIC: ReadonlySet<ColumnKey> = new Set([
  'started',
  'lead',
  'tokens',
  'cost',
  'reviewRounds',
  'clarifyRounds',
  'retries',
  'rounds',
  'assignments',
])

// Short labels stay on one line; the name column keeps a readable width (`.process-metrics__name`)
// and the table scrolls inside its viewport instead of breaking a name into single characters.
const SINGLE_LINE: ReadonlySet<ColumnKey> = new Set(['origin', 'completion'])

const cellClass = (key: ColumnKey) =>
  NUMERIC.has(key) ? 'viz-num' : SINGLE_LINE.has(key) ? 'data-table__nowrap' : undefined

/** What the completion column says about one workgroup task. */
export function completionText(row: ProcessUnitRow, t: Translate): string {
  if (row.capped) return t('processMetrics.units.capped')
  if (row.completionRejections === null) return '—'
  return row.completionRejections === 0
    ? t('processMetrics.units.confirmedDirectly')
    : t('processMetrics.units.rejections', { count: row.completionRejections })
}

function UnitStatus({ row, kind }: { row: ProcessUnitRow; kind: ProcessSubjectKind }) {
  const { t } = useTranslation()
  // A task shows its own status chip; an assignment has no task status, so it shows its outcome.
  const taskStatus = kind === 'digital-employee' ? null : TaskStatusSchema.safeParse(row.outcome)
  if (taskStatus?.success) return <TaskStatusChip status={taskStatus.data} />
  return (
    <StatusChip kind={STATUS_CHIP[row.status]}>
      {t(`processMetrics.outcomeName.${row.outcome}`, {
        defaultValue: t(`processMetrics.status.${row.status}`),
      })}
    </StatusChip>
  )
}

/** One unit's detail; the page's Refresh reads every process query again, this one included. */
function useUnitDetail(kind: ProcessSubjectKind, unitId: string | undefined) {
  return useQuery({
    queryKey: [...PROCESS_QUERY, 'unit', kind, unitId],
    queryFn: ({ signal }) => processApi.unit(kind, unitId!, signal),
    enabled: unitId !== undefined,
  })
}

function UnitStages(props: { kind: ProcessSubjectKind; unitId: string; columns: number }) {
  const { t, i18n } = useTranslation()
  const detail = useUnitDetail(props.kind, props.unitId)
  const label = t('processMetrics.units.stagesTitle')
  return (
    <td colSpan={props.columns} className="process-metrics__expanded">
      {detail.isLoading ? (
        <LoadingState size="compact" />
      ) : detail.error ? (
        <ErrorBanner error={detail.error} onRetry={() => void detail.refetch()} />
      ) : !detail.data || detail.data.stages.length === 0 ? (
        <EmptyState size="compact" title={t('processMetrics.units.noStages')} />
      ) : (
        <TableViewport label={label} minWidth="md">
          <table className="data-table data-table--compact" aria-label={label}>
            <thead>
              <tr>
                <th scope="col">{t('processMetrics.units.stage.name')}</th>
                <th scope="col" className="viz-num">
                  {t('processMetrics.units.stage.runs')}
                </th>
                <th scope="col" className="viz-num">
                  {t('processMetrics.units.stage.duration')}
                </th>
                <th scope="col" className="viz-num">
                  {t('processMetrics.units.stage.tokens')}
                </th>
                <th scope="col">{t('processMetrics.units.stage.notes')}</th>
              </tr>
            </thead>
            <tbody>
              {stageTree(detail.data.stages).map(({ stage, depth }) => {
                const notes: string[] = []
                if (stage.gateRounds > 0)
                  notes.push(
                    t('processMetrics.units.stage.gate', {
                      rounds: stage.gateRounds,
                      wait: duration(stage.gateWaitMs, t),
                    }),
                  )
                else if (stage.gateWaitMs > 0)
                  notes.push(
                    t('processMetrics.units.stage.waiting', {
                      wait: duration(stage.gateWaitMs, t),
                    }),
                  )
                if (stage.comments > 0)
                  notes.push(t('processMetrics.units.stage.comments', { count: stage.comments }))
                if (stage.questions > 0)
                  notes.push(t('processMetrics.units.stage.questions', { count: stage.questions }))
                if (stage.failedRuns > 0)
                  notes.push(t('processMetrics.units.stage.failed', { count: stage.failedRuns }))
                if (stage.autoRetries > 0)
                  notes.push(t('processMetrics.units.stage.retries', { count: stage.autoRetries }))
                return (
                  <tr key={stage.key}>
                    <th
                      scope="row"
                      {...(depth === 0
                        ? {}
                        : {
                            className: 'process-metrics__indent',
                            style: { '--depth': depth } as CSSProperties,
                          })}
                    >
                      {stageName(stage, t, i18n.language)}
                      {stage.removed ? (
                        <span className="muted"> {t('processMetrics.stages.removed')}</span>
                      ) : null}
                    </th>
                    <td className="viz-num">{stage.runs > 0 ? stage.runs : '—'}</td>
                    <td className="viz-num">
                      {stage.durationMs > 0 ? duration(stage.durationMs, t) : '—'}
                    </td>
                    <td className="viz-num">{stage.tokens > 0 ? tokens(stage.tokens) : '—'}</td>
                    <td>{notes.join(' · ')}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </TableViewport>
      )}
    </td>
  )
}

function UnitName({ row, kind }: { row: ProcessUnitRow; kind: ProcessSubjectKind }) {
  if (kind === 'digital-employee')
    return (
      <Link
        className="data-table__link"
        to="/tasks/employee-cases/$caseId"
        params={{ caseId: row.unitId }}
      >
        {row.name}
      </Link>
    )
  if (row.taskId === null) return <>{row.name}</>
  return (
    <Link className="data-table__link" to="/tasks/$id" params={{ id: row.taskId }}>
      {row.name}
    </Link>
  )
}

export function ProcessUnits(props: {
  kind: ProcessSubjectKind
  subjectId: string | null
  window: ObservationWindow
  origin?: ProcessOrigin
  /** The unit whose stages are shown; kept in the URL. */
  openUnit?: string
  onOpenUnit: (unitId: string | null) => void
}) {
  const { t, i18n } = useTranslation()
  const { kind, subjectId, window } = props
  const [status, setStatus] = useState<ProcessUnitFilter>('all')
  const pages = useInfiniteQuery({
    queryKey: [
      ...PROCESS_QUERY,
      'units',
      kind,
      subjectId,
      window.from,
      window.to,
      status,
      props.origin ?? null,
    ],
    queryFn: ({ pageParam, signal }) =>
      processApi.units(
        kind,
        subjectId,
        window,
        {
          status,
          ...(props.origin === undefined ? {} : { origin: props.origin }),
          ...(pageParam === null ? {} : { cursor: pageParam }),
        },
        signal,
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (last: ProcessUnitPage) => last.nextCursor,
    placeholderData: keepPreviousData,
  })
  const loaded = pages.data?.pages ?? []
  const listed = loaded.flatMap((page) => page.items)
  // A link can name a unit that is not on the pages loaded so far (older than the first
  // twenty-five, or outside the chosen filter). It is read on its own and shown first, opened.
  const linkedId =
    props.openUnit !== undefined &&
    !pages.isLoading &&
    !listed.some((row) => row.unitId === props.openUnit)
      ? props.openUnit
      : undefined
  const linked = useUnitDetail(kind, linkedId)
  const rows = linked.data && linkedId !== undefined ? [linked.data.unit, ...listed] : listed
  const identities = new Map<string, ProcessIdentity>(
    loaded.flatMap((page) => page.identities.map((identity) => [identity.id, identity] as const)),
  )
  const stageLabels = Object.assign({}, ...loaded.map((page) => page.stageLabels)) as Record<
    string,
    Parameters<typeof labelText>[0]
  >
  const columns = COLUMNS[kind]
  const unit = t(`processMetrics.unit.${kind}`)
  const label = t(`processMetrics.view.units.${kind}`)
  // One colour assignment and one legend for every row on screen, not for the first row.
  const scheme = coloredWaits(rows)
  const legend = timeLegend(
    rows.filter((row) => row.autoMs !== null),
    t,
    scheme,
  )

  const cell = (row: ProcessUnitRow, key: ColumnKey) => {
    switch (key) {
      case 'status':
        return <UnitStatus row={row} kind={kind} />
      case 'origin':
        return t(`processMetrics.origin.${row.origin}`)
      case 'owner':
        return (
          <OwnerLabel
            ownerUserId={row.ownerUserId}
            owner={row.ownerUserId === null ? null : (identities.get(row.ownerUserId) ?? null)}
          />
        )
      case 'started':
        return new Date(row.startedAt).toLocaleString(i18n.language, {
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
        })
      case 'lead':
        return duration(row.leadMs, t)
      case 'split':
        return row.autoMs === null ? (
          <span className="muted">{t('processMetrics.units.noRuntime')}</span>
        ) : (
          <SegmentedBar
            variant="thin"
            parts={timeParts(row, t, scheme)}
            label={t('processMetrics.units.col.split')}
          />
        )
      case 'tokens':
        return (
          <>
            {tokens(row.tokens)}
            {row.usageLowerBound ? (
              <span className="muted" title={t('processMetrics.note.usageLowerBound')}>
                {' '}
                +
              </span>
            ) : null}
          </>
        )
      case 'cost':
        return (
          <>
            {row.unpriced ? (
              <span title={t('runObservability.partialCostHint')}>
                {pricedCost(row.costNano, true, t)}
              </span>
            ) : (
              cost(row.costNano)
            )}
          </>
        )
      case 'reviewRounds':
        return count(roundsOf(row, 'review'), i18n.language)
      case 'clarifyRounds':
        return count(roundsOf(row, 'clarify'), i18n.language)
      case 'retries':
        return count(row.autoRetries + row.manualRetries, i18n.language)
      case 'rounds':
        return row.rounds === null ? '—' : count(row.rounds, i18n.language)
      case 'assignments':
        return row.assignments === null ? '—' : count(row.assignments, i18n.language)
      case 'completion':
        return completionText(row, t)
      case 'rework':
        return row.rework.length === 0
          ? '—'
          : row.rework
              .map((entry) =>
                t('processMetrics.units.reworkEntry', {
                  name: labelText(stageLabels[entry.key] ?? entry.key, i18n.language),
                  rounds: entry.rounds,
                }),
              )
              .join(' · ')
    }
  }

  return (
    <div className="stack--md">
      <FilterBar
        ariaLabel={t('processMetrics.units.filterLabel', { unit })}
        density="compact"
        trailing={
          columns.includes('split') && legend.length > 0 ? (
            <SegmentedBarLegend parts={legend} layout="row" />
          ) : undefined
        }
      >
        <div className="page-filter process-metrics__picker">
          <Segmented<ProcessUnitFilter>
            value={status}
            ariaLabel={t('processMetrics.units.filterLabel', { unit })}
            testidPrefix="process-units-filter"
            options={PROCESS_UNIT_FILTERS.map((value) => ({
              value,
              label: t(`processMetrics.units.filter.${value}`),
            }))}
            onChange={setStatus}
          />
        </div>
      </FilterBar>
      {linkedId !== undefined && linked.error ? (
        <NoticeBanner tone="warning">
          {t('processMetrics.units.linkedMissing', { unit })}
        </NoticeBanner>
      ) : null}
      {pages.isLoading ? (
        <LoadingState />
      ) : pages.error ? (
        <ErrorBanner error={pages.error} onRetry={() => void pages.refetch()} />
      ) : rows.length === 0 ? (
        <EmptyState title={t('processMetrics.units.empty', { unit })} />
      ) : (
        <>
          <TableViewport label={label} minWidth="lg">
            <table className="data-table" aria-label={label}>
              <thead>
                <tr>
                  <th scope="col" className="data-table__expand">
                    <span className="sr-only">{t('processMetrics.units.expandCol')}</span>
                  </th>
                  <th scope="col">{t(`processMetrics.units.col.name.${kind}`)}</th>
                  {columns.map((key) => (
                    <th key={key} scope="col" className={cellClass(key)}>
                      {t(`processMetrics.units.col.${key}`)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const open = props.openUnit === row.unitId
                  const detailsId = `process-unit-${row.unitId}`
                  return (
                    <Fragment key={row.unitId}>
                      <tr data-unit={row.unitId}>
                        <td className="data-table__expand">
                          <button
                            type="button"
                            className="btn btn--ghost btn--xs data-table__expand-btn"
                            aria-expanded={open}
                            aria-controls={open ? detailsId : undefined}
                            aria-label={t(
                              open
                                ? 'processMetrics.units.collapse'
                                : 'processMetrics.units.expand',
                              { name: row.name },
                            )}
                            onClick={() => props.onOpenUnit(open ? null : row.unitId)}
                          >
                            <span aria-hidden="true">{open ? '▾' : '▸'}</span>
                          </button>
                        </td>
                        <th scope="row" className="process-metrics__name">
                          <UnitName row={row} kind={kind} />
                          {row.unitId === linkedId ? (
                            <span className="muted"> {t('processMetrics.units.linked')}</span>
                          ) : null}
                        </th>
                        {columns.map((key) => (
                          <td key={key} className={cellClass(key)}>
                            {cell(row, key)}
                          </td>
                        ))}
                      </tr>
                      {open ? (
                        <tr id={detailsId} className="data-table__expanded-row">
                          <UnitStages
                            kind={kind}
                            unitId={row.unitId}
                            columns={columns.length + 2}
                          />
                        </tr>
                      ) : null}
                    </Fragment>
                  )
                })}
              </tbody>
            </table>
          </TableViewport>
          {pages.hasNextPage ? (
            <div className="observability__pager">
              <button
                type="button"
                className="btn btn--sm"
                disabled={pages.isFetchingNextPage}
                onClick={() => void pages.fetchNextPage()}
              >
                {t(
                  pages.isFetchingNextPage
                    ? 'processMetrics.units.loadingMore'
                    : 'processMetrics.units.loadMore',
                )}
              </button>
            </div>
          ) : null}
        </>
      )}
      <p className="muted process-metrics__note">{t(`processMetrics.units.foot.${kind}`)}</p>
    </div>
  )
}

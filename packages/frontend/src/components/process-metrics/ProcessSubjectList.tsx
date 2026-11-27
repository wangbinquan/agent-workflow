// RFC-616 §11 — the listing: one row per workflow, workgroup or digital
// employee that had tasks (or assignments) in the window, with the handful of
// numbers that tell where to look first.
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import {
  PROCESS_SUBJECT_KINDS,
  type ProcessSubjectKind,
  type ProcessSubjectList as SubjectList,
  type ProcessSubjectRow,
} from '@agent-workflow/shared'
import { EmptyState } from '@/components/EmptyState'
import { ErrorBanner } from '@/components/ErrorBanner'
import { FilterBar } from '@/components/FilterBar'
import { LoadingState } from '@/components/LoadingState'
import { MeterBar } from '@/components/MeterBar'
import { NoticeBanner } from '@/components/NoticeBanner'
import { Segmented } from '@/components/Segmented'
import { TableViewport } from '@/components/TableViewport'
import type { ObservationWindow } from '@/components/observability/observationClient'
import { PROCESS_QUERY, processApi } from './processClient'
import { cost, count, decimal, duration, percent, tokens, type Translate } from './processFormat'

interface Column {
  readonly key: string
  readonly numeric?: boolean
  render(row: ProcessSubjectRow, t: Translate, language: string): React.ReactNode
}

const perUnit = (value: number | null, t: Translate) =>
  value === null ? '—' : t('processMetrics.list.timesPerUnit', { value: decimal(value) })

const COLUMNS: Readonly<Record<ProcessSubjectKind, readonly Column[]>> = {
  workflow: [
    { key: 'units', numeric: true, render: (row, _t, language) => count(row.units, language) },
    { key: 'successRate', numeric: true, render: (row) => percent(row.successRate) },
    { key: 'leadP50', numeric: true, render: (row, t) => duration(row.leadP50, t) },
    { key: 'waitShare', render: (row) => <MeterBar share={row.waitShare} /> },
    { key: 'tokensPerUnit', numeric: true, render: (row) => tokens(row.tokensPerUnit) },
    { key: 'costPerUnit', numeric: true, render: (row) => cost(row.costNanoPerUnit) },
    {
      key: 'interventions',
      numeric: true,
      render: (row, t) => perUnit(row.interventionsPerUnit, t),
    },
    { key: 'firstPassRate', numeric: true, render: (row) => percent(row.firstPassRate) },
  ],
  workgroup: [
    {
      key: 'mode',
      render: (row, t) => (row.mode === null ? '—' : t(`processMetrics.mode.${row.mode}`)),
    },
    { key: 'units', numeric: true, render: (row, _t, language) => count(row.units, language) },
    { key: 'successRate', numeric: true, render: (row) => percent(row.successRate) },
    { key: 'leadP50', numeric: true, render: (row, t) => duration(row.leadP50, t) },
    {
      key: 'roundsPerUnit',
      numeric: true,
      render: (row, t) =>
        row.roundsPerUnit === null
          ? '—'
          : t('processMetrics.list.rounds', { value: decimal(row.roundsPerUnit) }),
    },
    {
      key: 'assignmentsPerUnit',
      numeric: true,
      render: (row, t) =>
        row.assignmentsPerUnit === null
          ? '—'
          : t('processMetrics.list.assignments', { value: decimal(row.assignmentsPerUnit) }),
    },
    { key: 'coordinationShare', render: (row) => <MeterBar share={row.coordinationShare} /> },
    {
      key: 'interventions',
      numeric: true,
      render: (row, t) => perUnit(row.interventionsPerUnit, t),
    },
  ],
  'digital-employee': [
    { key: 'units', numeric: true, render: (row, _t, language) => count(row.units, language) },
    { key: 'mergeRate', numeric: true, render: (row) => percent(row.mergeRate) },
    { key: 'leadP50', numeric: true, render: (row, t) => duration(row.leadP50, t) },
    { key: 'tokensPerUnit', numeric: true, render: (row) => tokens(row.tokensPerUnit) },
    { key: 'costPerUnit', numeric: true, render: (row) => cost(row.costNanoPerUnit) },
    { key: 'firstPassRate', numeric: true, render: (row) => percent(row.firstPassRate) },
    { key: 'blockedRate', render: (row) => <MeterBar share={row.blockedRate} /> },
  ],
}

/** The name of a subject row; a subject without a name still has to be openable. */
export function subjectTitle(
  kind: ProcessSubjectKind,
  subjectId: string | null,
  name: string | null,
  t: Translate,
): string {
  if (name !== null && name !== '') return name
  if (subjectId === null) return t(`processMetrics.noSubject.${kind}`)
  return t(`processMetrics.deleted.${kind}`)
}

function SubjectTable(props: {
  kind: ProcessSubjectKind
  list: SubjectList
  onOpen: (subjectId: string | null) => void
}) {
  const { t, i18n } = useTranslation()
  const columns = COLUMNS[props.kind]
  const label = t(`processMetrics.list.caption.${props.kind}`)
  return (
    <TableViewport label={label} minWidth="lg">
      <table className="data-table" aria-label={label}>
        <thead>
          <tr>
            <th scope="col">{t(`processMetrics.kind.${props.kind}`)}</th>
            {columns.map((column) => (
              <th key={column.key} scope="col" className={column.numeric ? 'viz-num' : undefined}>
                {t(`processMetrics.list.col.${props.kind}.${column.key}`)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {props.list.items.map((row) => {
            const title = subjectTitle(props.kind, row.subjectId, row.name, t)
            return (
              <tr key={row.subjectId ?? '-'}>
                <th scope="row">
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm"
                    aria-label={t('processMetrics.list.open', { name: title })}
                    onClick={() => props.onOpen(row.subjectId)}
                  >
                    {title}
                  </button>
                </th>
                {columns.map((column) => (
                  <td key={column.key} className={column.numeric ? 'viz-num' : undefined}>
                    {column.render(row, t, i18n.language)}
                  </td>
                ))}
              </tr>
            )
          })}
        </tbody>
      </table>
    </TableViewport>
  )
}

export function ProcessSubjectList(props: {
  kind: ProcessSubjectKind
  window: ObservationWindow
  onKind: (kind: ProcessSubjectKind) => void
  onOpen: (subjectId: string | null) => void
}) {
  const { t } = useTranslation()
  const { kind, window } = props
  const list = useQuery({
    queryKey: [...PROCESS_QUERY, 'subjects', kind, window.from, window.to],
    queryFn: ({ signal }) => processApi.subjects(kind, window, signal),
    placeholderData: keepPreviousData,
  })
  // While the kind changes, the previous kind's rows must not be shown under the new kind's headers.
  const data = list.data?.kind === kind ? list.data : undefined
  return (
    <div className="process-metrics stack--md">
      <FilterBar
        ariaLabel={t('processMetrics.kindLabel')}
        density="compact"
        trailing={
          data ? (
            <span className="muted process-metrics__note">
              {t(`processMetrics.scope.${data.scope}.${kind}`)}
            </span>
          ) : undefined
        }
      >
        <div className="page-filter process-metrics__picker">
          <Segmented<ProcessSubjectKind>
            value={kind}
            ariaLabel={t('processMetrics.kindLabel')}
            testidPrefix="process-kind"
            options={PROCESS_SUBJECT_KINDS.map((value) => ({
              value,
              label: t(`processMetrics.kind.${value}`),
            }))}
            onChange={props.onKind}
          />
        </div>
      </FilterBar>
      {data === undefined ? (
        list.error ? (
          <ErrorBanner error={list.error} onRetry={() => void list.refetch()} />
        ) : (
          <LoadingState />
        )
      ) : (
        <>
          {data.partial ? (
            <NoticeBanner tone="warning">
              {t(`processMetrics.partial.${kind}`, { limit: data.unitLimit })}
            </NoticeBanner>
          ) : null}
          {data.items.length === 0 ? (
            <EmptyState
              title={t(`processMetrics.list.empty.${kind}`)}
              description={t('processMetrics.list.emptyHint')}
            />
          ) : (
            <SubjectTable kind={kind} list={data} onOpen={props.onOpen} />
          )}
          <p className="muted process-metrics__note">
            {t(`processMetrics.list.foot.${kind}`)} {t('processMetrics.list.basis')}
          </p>
        </>
      )}
    </div>
  )
}

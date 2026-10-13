import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import type {
  ObservationExecutionComparison,
  ObservationPhase,
  CompleteObservationTask,
} from '@agent-workflow/shared'
import { api } from '@/api/client'
import { Card } from '@/components/Card'
import { Select } from '@/components/Select'
import { Dialog } from '@/components/Dialog'
import { ExecutionSwimlane } from '@/components/ExecutionSwimlane'
import { ErrorBanner } from '@/components/ErrorBanner'
import { LoadingState } from '@/components/LoadingState'
import { CompleteObservationPage } from './CompleteObservationPager'
import { useCompleteObservationPage, type ReadableObservationReport } from './completeReportClient'
import { CompleteMetrics } from './CompleteObservationMetrics'
export function ObservationExecutionAnalysis({ report }: { report: ReadableObservationReport }) {
  const { t } = useTranslation(),
    tasks = useCompleteObservationPage<CompleteObservationTask>(report, 'tasks'),
    phases = useCompleteObservationPage<ObservationPhase>(
      report,
      'phases',
      report.header.taskId ?? undefined,
    ),
    [left, setLeft] = useState(''),
    [right, setRight] = useState(''),
    [selectedNames, setSelectedNames] = useState<Record<string, string>>({}),
    [selected, setSelected] = useState<ObservationPhase>(),
    trigger = useRef<HTMLButtonElement | null>(null)
  const comparison = useQuery({
    queryKey: ['observation-comparison', report.header.reportId, left, right],
    enabled: !!left && !!right,
    queryFn: () =>
      api.get<ObservationExecutionComparison>(
        '/api/observability/reports/' +
          report.header.reportId +
          '/comparison?' +
          new URLSearchParams({ left, right }),
      ),
  })
  return (
    <>
      <Card title={t('runObservability.executionComparison')}>
        <p className="muted">{t('runObservability.comparisonBasis')}</p>
        <CompleteObservationPage query={tasks}>
          {(rows) => {
            const options = [
              ...new Map([
                ...[left, right].flatMap((id) =>
                  id && selectedNames[id]
                    ? [[id, { value: id, label: selectedNames[id]! }] as const]
                    : [],
                ),
                ...rows.map(
                  (row) => [row.task.id, { value: row.task.id, label: row.task.name }] as const,
                ),
              ]).values(),
            ]
            const choose = (id: string, update: (id: string) => void) => {
              const label = options.find((option) => option.value === id)?.label
              if (label) setSelectedNames((old) => ({ ...old, [id]: label }))
              update(id)
            }
            return (
              <div className="page__actions">
                <Select
                  value={left}
                  onChange={(id) => choose(id, setLeft)}
                  ariaLabel={t('runObservability.comparisonLeft')}
                  options={options}
                />
                <Select
                  value={right}
                  onChange={(id) => choose(id, setRight)}
                  ariaLabel={t('runObservability.comparisonRight')}
                  options={options}
                />
              </div>
            )
          }}
        </CompleteObservationPage>
        {comparison.isFetching ? <LoadingState /> : null}
        {comparison.error ? <ErrorBanner error={comparison.error} /> : null}
        {comparison.data && !comparison.error ? (
          <div className="observation-columns">
            <div>
              <strong>{comparison.data.left.task.name}</strong>
              <CompleteMetrics value={comparison.data.left.metrics} />
              <p>
                {t('runObservability.wall')}: {comparison.data.left.timing.wallMs ?? '—'} ms
              </p>
            </div>
            <div>
              <strong>{comparison.data.right.task.name}</strong>
              <CompleteMetrics value={comparison.data.right.metrics} />
              <p>
                {t('runObservability.wall')}: {comparison.data.right.timing.wallMs ?? '—'} ms
              </p>
            </div>
          </div>
        ) : null}
        <p className="muted">{t('runObservability.criticalPathUnknown')}</p>
      </Card>
      <Card title={t('runObservability.originalPhases')}>
        <p className="muted">{t('runObservability.originalPhasesHint')}</p>
        <CompleteObservationPage query={phases}>
          {(rows) => {
            const known = rows.flatMap((row) => (row.startedAt === null ? [] : [row.startedAt])),
              from = known.length ? Math.min(...known) : report.header.asOf,
              to = Math.max(
                from + 1,
                ...rows.flatMap((row) =>
                  row.endedAt !== null
                    ? [row.endedAt]
                    : row.status === 'active'
                      ? [report.header.asOf]
                      : [],
                ),
              )
            return (
              <ExecutionSwimlane
                label={t('runObservability.originalPhases')}
                rowHeading={t('runObservability.task')}
                timeHeading={t('runObservability.pageExecutionRange')}
                unknownLabel={t('runObservability.unknownInterval')}
                from={from}
                to={to}
                rows={rows.map((row) => ({
                  id: row.id,
                  label:
                    row.basis === 'original-span'
                      ? row.label
                      : t('runObservability.phaseLabel_' + row.label),
                  start: row.startedAt,
                  end: row.endedAt ?? (row.status === 'active' ? report.header.asOf : null),
                  open: row.status === 'active',
                  description: t('runObservability.detail'),
                  detail: row.basis,
                }))}
                onSelect={(id, button) => {
                  trigger.current = button
                  setSelected(rows.find((row) => row.id === id))
                }}
              />
            )
          }}
        </CompleteObservationPage>
      </Card>
      {selected ? (
        <Dialog
          panelClassName="observation-typography"
          open
          title={t('runObservability.originalPhases')}
          onClose={() => setSelected(undefined)}
          triggerRef={trigger}
        >
          <dl className="detail-grid">
            <dt>{t('runObservability.start')}</dt>
            <dd>
              {selected.startedAt === null ? '—' : new Date(selected.startedAt).toLocaleString()}
            </dd>
            <dt>{t('runObservability.end')}</dt>
            <dd>{selected.endedAt === null ? '—' : new Date(selected.endedAt).toLocaleString()}</dd>
            <dt>{t('runObservability.anomalyEvidence')}</dt>
            <dd>
              {selected.basis} · {selected.evidenceId}
            </dd>
          </dl>
        </Dialog>
      ) : null}
    </>
  )
}

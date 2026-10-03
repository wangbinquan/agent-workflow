import { useTranslation } from 'react-i18next'
import type { RefObject } from 'react'
import type {
  CompleteObservationDimension,
  CompleteObservationDimensionTask,
  CompleteObservationInvocation,
  CompleteObservationTask,
  CompleteObservationAllocation,
} from '@agent-workflow/shared'
import { TableViewport } from '@/components/TableViewport'
import { EmptyState } from '@/components/EmptyState'
import { CompleteCost, CompleteTokens } from './CompleteObservationMetrics'
import { formatObservationCny, OBSERVATION_TOKEN_BUCKETS } from './formatObservations'

export function CompleteTaskRows({
  rows,
  onTask,
}: {
  rows: readonly (CompleteObservationTask | CompleteObservationDimensionTask)[]
  onTask: (id: string, trigger: HTMLElement) => void
}) {
  const { t } = useTranslation()
  if (!rows.length) return <EmptyState title={t('runObservability.empty')} size="compact" />
  return (
    <TableViewport label={t('runObservability.tasks')}>
      <table className="data-table data-table--compact">
        <thead>
          <tr>
            {['task', 'state', 'totalTokens', 'cost'].map((key) => (
              <th scope="col" key={key}>
                {t('runObservability.' + key)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.task.id}>
              <th scope="row">
                <button
                  type="button"
                  className="link link--button data-table__link task-operations__name"
                  data-observation-task={row.task.id}
                  title={row.task.name}
                  onClick={(event) => onTask(row.task.id, event.currentTarget)}
                >
                  {row.task.name}
                </button>
              </th>
              <td>{t('tasks.status.' + row.task.status, { defaultValue: row.task.status })}</td>
              <td>
                <CompleteTokens value={row.metrics} />
              </td>
              <td>
                <CompleteCost value={row.metrics} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </TableViewport>
  )
}
export function CompleteDimensionRows({
  rows,
  onSelect,
  selectedKey,
  triggerRef,
}: {
  rows: readonly CompleteObservationDimension[]
  onSelect: (value: CompleteObservationDimension, trigger: HTMLElement) => void
  selectedKey?: string
  triggerRef?: RefObject<HTMLElement | null>
}) {
  const { t, i18n } = useTranslation()
  return (
    <TableViewport label={t('runObservability.contributions')}>
      <table className="data-table data-table--compact">
        <thead>
          <tr>
            {['group', 'relatedTaskCount', 'totalTokens', 'cost'].map((key) => (
              <th scope="col" key={key}>
                {t('runObservability.' + key)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key}>
              <th scope="row">
                <button
                  type="button"
                  className="link link--button data-table__link"
                  data-observation-dimension={row.key}
                  ref={(node) => {
                    if (node && row.key === selectedKey && triggerRef) triggerRef.current = node
                  }}
                  onClick={(event) => onSelect(row, event.currentTarget)}
                >
                  {row.kind === 'purpose'
                    ? t('runObservability.purpose_' + row.label)
                    : row.kind === 'source'
                      ? t('runObservability.' + row.label)
                      : (row.label ?? t('runObservability.unknown'))}
                </button>
                {row.selection.agent?.revision != null && (
                  <div className="muted">
                    {t('runObservability.revision', { revision: row.selection.agent.revision })}
                  </div>
                )}
              </th>
              <td>{BigInt(row.taskCount).toLocaleString(i18n.language)}</td>
              <td>
                <CompleteTokens value={row.metrics} />
              </td>
              <td>
                <CompleteCost value={row.metrics} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </TableViewport>
  )
}
export function CompleteInvocationRows({
  rows,
  onCall,
}: {
  rows: readonly CompleteObservationInvocation[]
  onCall: (row: CompleteObservationInvocation, trigger: HTMLButtonElement) => void
}) {
  const { t, i18n } = useTranslation()
  return (
    <TableViewport label={t('runObservability.calls')}>
      <table className="data-table data-table--compact">
        <thead>
          <tr>
            {['agent', 'task', 'runtime', 'purpose', 'started', 'totalTokens', 'cost'].map(
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
            <tr key={row.invocationId}>
              <th scope="row">
                <button
                  type="button"
                  className="link link--button data-table__link"
                  onClick={(event) => onCall(row, event.currentTarget)}
                >
                  {row.agentName ?? t('runObservability.noAgent')}
                </button>
              </th>
              <td>{row.taskName}</td>
              <td>
                {row.authority.kind === 'local'
                  ? (row.authority.runtime?.acceptedName ??
                    t('runObservability.registrationUnknown'))
                  : 'CrewStation'}
              </td>
              <td>{t('runObservability.purpose_' + row.purpose)}</td>
              <td>{new Date(row.acceptedAt).toLocaleString(i18n.language)}</td>
              <td>
                <CompleteTokens value={row.metrics} />
              </td>
              <td>
                <CompleteCost value={row.metrics} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </TableViewport>
  )
}
export function CompleteAllocationRows({
  rows,
}: {
  rows: readonly CompleteObservationAllocation[]
}) {
  const { t, i18n } = useTranslation()
  return (
    <TableViewport label={t('runObservability.usageRecords')}>
      <table className="data-table data-table--compact">
        <thead>
          <tr>
            {['actualModel', 'observedTime', ...OBSERVATION_TOKEN_BUCKETS, 'cost'].map((key) => (
              <th scope="col" key={key}>
                {t('runObservability.' + key)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={JSON.stringify([row.invocation.invocationId, row.sourceId, row.recordId])}>
              <th scope="row">
                {row.model?.id ?? t('runObservability.modelUnknown')}
                <div className="muted">{row.model?.provider}</div>
              </th>
              <td>{new Date(row.observedAt).toLocaleString(i18n.language)}</td>
              {OBSERVATION_TOKEN_BUCKETS.map((key) => (
                <td key={key}>
                  {row.contribution[key] === null
                    ? '—'
                    : BigInt(row.contribution[key]!).toLocaleString(i18n.language)}
                </td>
              ))}
              <td>{formatObservationCny(row.cost.amount, true)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </TableViewport>
  )
}

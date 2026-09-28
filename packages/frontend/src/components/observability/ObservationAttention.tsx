import { useId } from 'react'
import { Link } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import { canonicalTaskStatuses, type ObservationTaskSummary } from '@agent-workflow/shared'
import { Card } from '@/components/Card'
import { EmptyState } from '@/components/EmptyState'
import { TaskStatusChip } from '@/components/TaskStatusChip'
import { describeTaskFailure } from '@/lib/task-failure'

const statuses = ['awaiting_human', 'awaiting_review', 'failed', 'interrupted'] as const
type AttentionStatus = (typeof statuses)[number]
const isAttentionStatus = (status: string): status is AttentionStatus =>
  statuses.some((value) => value === status)

/** A bounded action queue from the same overview snapshot, not another task query. */
export function ObservationAttention({ tasks }: { tasks: readonly ObservationTaskSummary[] }) {
  const { t } = useTranslation()
  const titleId = useId()
  const rows = tasks
    .flatMap(({ task }) => (isAttentionStatus(task.status) ? [{ task, status: task.status }] : []))
    .sort(
      (a, b) =>
        statuses.indexOf(a.status) - statuses.indexOf(b.status) ||
        b.task.startedAt - a.task.startedAt ||
        a.task.id.localeCompare(b.task.id),
    )
  return (
    <Card
      as="section"
      title={t('runObservability.attention')}
      titleId={titleId}
      aria-labelledby={titleId}
      actions={
        <Link
          to="/tasks"
          search={{ statuses: canonicalTaskStatuses([...statuses]).join(','), scope: 'all' }}
          className="btn btn--sm"
        >
          {t('runObservability.attentionAll')}
        </Link>
      }
      footer={t('runObservability.attentionScope')}
    >
      {rows.length === 0 ? (
        <EmptyState title={t('runObservability.attentionEmpty')} size="compact" />
      ) : (
        <div className="stack--md">
          <div
            className="page__actions"
            role="group"
            aria-label={t('runObservability.attentionCounts')}
          >
            {statuses.map((status) => (
              <span key={status}>
                {t(`tasks.status.${status}`)} {rows.filter((row) => row.status === status).length}
              </span>
            ))}
          </div>
          <span className="muted">
            {t('runObservability.attentionShowing', {
              count: rows.length,
              shown: Math.min(rows.length, 5),
            })}
          </span>
          <ul
            className="task-list observation-attention"
            aria-label={t('runObservability.attention')}
          >
            {rows.slice(0, 5).map(({ task, status }) => {
              const failure = describeTaskFailure(task)
              const reason =
                status === 'failed' || status === 'interrupted'
                  ? failure.matched === 'generic'
                    ? failure.raw?.trim() || t(`runObservability.attentionReason_${status}`)
                    : failure.title
                  : t(`runObservability.attentionReason_${status}`)
              return (
                <li key={task.id}>
                  <Link
                    to="/tasks/$id"
                    params={{ id: task.id }}
                    search={{}}
                    className="task-row observation-attention__row"
                  >
                    <span className="observation-attention__content">
                      <strong className="observation-attention__text" title={task.name}>
                        {task.name}
                      </strong>
                      <span className="muted observation-attention__text" title={reason}>
                        {reason}
                      </span>
                      <span className="muted" title={task.id}>
                        #{task.id.slice(0, 8)}
                      </span>
                    </span>
                    <TaskStatusChip status={status} />
                    <span className="btn btn--sm btn--ghost">
                      {t(`runObservability.attentionAction_${status}`)}
                    </span>
                  </Link>
                </li>
              )
            })}
          </ul>
        </div>
      )}
    </Card>
  )
}

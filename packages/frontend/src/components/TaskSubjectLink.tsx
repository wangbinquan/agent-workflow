// Task "execution subject" link — the single place that decides what a task row
// points at. Every task is FK-anchored to a `workflows` row even when it is
// really a workgroup or single-agent launch: the builtin `__workgroup_host__` /
// `__agent_host__` anchors (services/workgroupLaunch.ts + agentLaunch.ts). So
// naive `workflowName` / `/workflows/$id` rendering leaks those internal anchor
// names and links to a dead workflow page. This component resolves the REAL
// subject via `taskExecutionKind` and links to the owning resource instead:
//   - workgroup → /workgroups/$name  (+ 「工作组」badge)
//   - agent     → /agents/$name      (+ 「代理」badge)
//   - workflow  → /workflows/$id      (plain link, no badge — unchanged)
// Used by the /tasks list cell and the /tasks/:id detail header + meta row so
// all three surfaces stay consistent. Do NOT re-scatter workgroupId /
// sourceAgentName checks at callsites — that is exactly what taskExecutionKind's
// contract (schemas/task.ts) exists to prevent.

import { Link } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import { taskExecutionKind } from '@agent-workflow/shared'
import { StatusChip } from '@/components/StatusChip'

/** Structural subset shared by TaskSummary (list) and Task (detail). */
export interface TaskSubjectFields {
  workflowId: string
  workflowName: string | null
  workgroupId?: string | null
  workgroupName?: string | null
  sourceAgentName?: string | null
}

export interface TaskSubjectLinkProps {
  task: TaskSubjectFields
  /** Task id — used to build the per-instance badge testid. */
  taskId: string
  /**
   * Render the kind badge (workgroup/agent) beside the name, wrapped in the
   * single-line `.task-workflow-cell` flex. The /tasks list cell and the detail
   * header pass this; the detail meta row omits it (its subject-aware <dt>
   * already labels the kind). Workflow tasks never carry a badge.
   */
  badge?: boolean
}

export function TaskSubjectLink({ task, taskId, badge = false }: TaskSubjectLinkProps) {
  const { t } = useTranslation()
  const kind = taskExecutionKind(task)

  // Workflow task: the plain anchor link, unchanged from the historical cell.
  if (kind === 'workflow') {
    return (
      <Link to="/workflows/$id" params={{ id: task.workflowId }} className="data-table__link">
        {task.workflowName ?? task.workflowId}
      </Link>
    )
  }

  const isWorkgroup = kind === 'workgroup'
  // workgroupName may be null (group row deleted → frozen name unavailable);
  // sourceAgentName is stored on the task row so it is present whenever
  // kind === 'agent' (the agent RESOURCE may since be gone, so the link can
  // 404 — acceptable, same contract as a renamed group's frozen link).
  const name = isWorkgroup ? (task.workgroupName ?? null) : (task.sourceAgentName ?? null)
  const linkClass = badge ? 'data-table__link task-workflow-cell__name' : 'data-table__link'

  const subject =
    name === null ? (
      // Deleted resource: keep the badge (the kind is still known) but drop the
      // dead link, mirroring the list cell's group-deleted fallback.
      <span className="data-table__muted">{t('common.emDash')}</span>
    ) : isWorkgroup ? (
      <Link to="/workgroups/$name" params={{ name }} className={linkClass} title={name}>
        {name}
      </Link>
    ) : (
      <Link to="/agents/$name" params={{ name }} className={linkClass} title={name}>
        {name}
      </Link>
    )

  if (!badge) return subject

  return (
    <span className="task-workflow-cell">
      {subject}
      <StatusChip
        kind="info"
        size="sm"
        className="task-workflow-cell__badge"
        data-testid={`task-${kind}-badge-${taskId}`}
      >
        {isWorkgroup ? t('tasks.workgroupBadge') : t('tasks.agentBadge')}
      </StatusChip>
    </span>
  )
}

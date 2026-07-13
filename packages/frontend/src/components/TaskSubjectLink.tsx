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
  // kind === 'agent'.
  //
  // These names are FROZEN at launch (task-scoped, ACL-safe per RFC-099 — never a
  // live resource lookup; see services/task.ts `frozenWorkgroupName`). Accepted
  // trade-off of that freeze: after the owning resource is renamed/deleted the
  // link 404s, and in the rare case its OLD name is later reused by a DIFFERENT
  // resource the link opens that replacement — a wrong-but-same-named subject, not
  // the original (Codex review 2026-07-13, P2). We keep it anyway because (a) it is
  // the SAME frozen name the task's room already shows and the list cell already
  // links, (b) a live identity check would regress the RFC-099 ACL isolation the
  // freeze exists to protect, (c) agents have no stable id (name IS identity), and
  // (d) it still strictly beats the prior behavior of leaking the internal
  // __workgroup_host__ / __agent_host__ anchor + a dead /workflows link.
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

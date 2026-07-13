// Task "execution subject" link — the single place that decides what a task row
// points at. Every task is FK-anchored to a `workflows` row even when it is
// really a workgroup or single-agent launch: the builtin `__workgroup_host__` /
// `__agent_host__` anchors (services/workgroupLaunch.ts + agentLaunch.ts). So
// naive `workflowName` / `/workflows/$id` rendering leaks those internal anchor
// names and links to a dead workflow page. This component resolves the REAL
// subject via `taskExecutionKind` and links to the owning resource — by its
// FROZEN STABLE ID (RFC-177), so a rename (or rare name-reuse) never opens a
// same-named replacement:
//   - workgroup → /workgroups/by-id/$id  → current group page  (+ 「工作组」badge)
//   - agent     → /agents/by-id/$id      → current agent page  (+ 「代理」badge)
//                 (historical agent w/o frozen id → /agents/$name, RFC-177 D3a)
//   - workflow  → /workflows/$id          (plain link, no badge — unchanged)
// The link TEXT stays the frozen name (ACL-safe, same as the task's room); the
// current name is disclosed only server-side, ACL-gated, by the by-id route after
// the click. Used by the /tasks list cell and the /tasks/:id detail header + meta
// row so all three surfaces stay consistent. Do NOT re-scatter workgroupId /
// sourceAgentName checks at callsites — that is exactly what taskExecutionKind's
// contract (schemas/task.ts) exists to prevent.

import type { ReactElement } from 'react'
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
  /** RFC-177: frozen stable agent id for id-resolved links (NULL → by-name D3a). */
  sourceAgentId?: string | null
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
  // Link by the FROZEN STABLE ID, resolved on click by the /…/by-id/$id route to
  // the resource's CURRENT canonical page (RFC-177 — fixes the Codex 2026-07-13
  // P2 where a renamed+reused name misidentified the subject). Rendering does no
  // lookup: the id is already frozen on the task, so the ACL-frozen-name invariant
  // (RFC-099) is untouched — the current name is disclosed only server-side,
  // ACL-gated, by the by-id route.
  //   - workgroupId is ALWAYS frozen for a workgroup task (taskExecutionKind).
  //   - sourceAgentId is frozen for agent tasks launched since RFC-175; NULL for
  //     older rows → D3(a) by-name fallback (no regression vs the prior by-name link).
  //   - workgroupName may be null (group row deleted → frozen name gone) → em-dash.
  const name = isWorkgroup ? (task.workgroupName ?? null) : (task.sourceAgentName ?? null)
  const linkClass = badge ? 'data-table__link task-workflow-cell__name' : 'data-table__link'

  let subject: ReactElement
  if (name === null) {
    // Deleted group (frozen name unavailable): keep the badge, drop the dead link.
    subject = <span className="data-table__muted">{t('common.emDash')}</span>
  } else if (isWorkgroup && task.workgroupId != null) {
    subject = (
      <Link
        to="/workgroups/by-id/$id"
        params={{ id: task.workgroupId }}
        className={linkClass}
        title={name}
      >
        {name}
      </Link>
    )
  } else if (!isWorkgroup && task.sourceAgentId != null) {
    subject = (
      <Link
        to="/agents/by-id/$id"
        params={{ id: task.sourceAgentId }}
        className={linkClass}
        title={name}
      >
        {name}
      </Link>
    )
  } else if (!isWorkgroup) {
    // RFC-177 D3(a): historical agent task (no frozen id) → by-name link. Only
    // legacy rows keep the rare reuse caveat; new tasks are id-resolved above.
    subject = (
      <Link to="/agents/$name" params={{ name }} className={linkClass} title={name}>
        {name}
      </Link>
    )
  } else {
    // Unreachable: a workgroup task always freezes workgroupId. Degrade to a
    // by-name link rather than crash if that invariant is ever violated.
    subject = (
      <Link to="/workgroups/$name" params={{ name }} className={linkClass} title={name}>
        {name}
      </Link>
    )
  }

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

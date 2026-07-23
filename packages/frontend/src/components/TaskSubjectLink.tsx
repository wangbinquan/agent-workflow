// Task "execution subject" link — the single place that decides what a task row
// points at. Every task is FK-anchored to a `workflows` row even when it is
// really a workgroup or single-agent launch: the builtin `__workgroup_host__` /
// `__agent_host__` anchors (services/workgroupLaunch.ts + agentLaunch.ts). So
// naive `workflowName` / `/workflows/$id` rendering leaks those internal anchor
// names and links to a dead workflow page. This component resolves the REAL
// subject via `taskExecutionKind` and links to the owning resource — by its
// FROZEN STABLE ID (RFC-177), so a rename (or rare name-reuse) never opens a
// same-named replacement:
//   - workgroup → /workgroups/$id  → current group page  (+ 「工作组」badge)
//   - agent     → /agents/$id      → current agent page  (+ 「代理」badge)
//                 (historical agent w/o frozen id → plain text, fail closed)
//   - workflow  → /workflows/$id          → workflow editor     (+ 「工作流」badge)
// All three kinds are badged: the badge previously doubled as the "this row is
// NOT a plain workflow" signal, which made the /tasks 工作流 column read
// asymmetrically — group/agent rows labeled, workflow rows bare (i.e. the kind
// was encoded in the ABSENCE of a chip). Labeling every kind makes the subject
// self-describing. Callers that already label the kind pass `badge={false}`.
// The link TEXT stays the frozen name (ACL-safe, same as the task's room); the
// current name is never needed to build the destination. Used by the /tasks list
// cell and the /tasks/:id detail header + meta
// row so all three surfaces stay consistent. Do NOT re-scatter workgroupId /
// sourceAgentName checks at callsites — that is exactly what taskExecutionKind's
// contract (schemas/task.ts) exists to prevent.

import type { ReactElement } from 'react'
import { Link } from '@tanstack/react-router'
import { isWorkgroupTask } from '@agent-workflow/shared'
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
   * Render the kind badge (workgroup/agent/workflow) beside the name, wrapped in
   * the single-line `.task-workflow-cell` flex. The /tasks list cell and the
   * detail header pass this; the detail meta row omits it (its subject-aware <dt>
   * already labels the kind).
   */
  badge?: boolean
}

const BADGE_KEY = {
  workgroup: 'tasks.workgroupBadge',
  agent: 'tasks.agentBadge',
  workflow: 'tasks.workflowBadge',
} as const

export function TaskSubjectLink({ task, taskId, badge = false }: TaskSubjectLinkProps) {
  const { t } = useTranslation()
  const kind = taskExecutionKind(task)
  const isWorkgroup = kind === 'workgroup'
  const linkClass = badge ? 'data-table__link task-workflow-cell__name' : 'data-table__link'

  let subject: ReactElement
  if (kind === 'workflow') {
    // Plain workflow task: the FK anchor IS the real subject, so the historical
    // /workflows/$id link stands. No frozen-id indirection to do — workflowId is
    // the resource's own id. Deleted workflow row → fall back to the raw ULID.
    const workflowName = task.workflowName ?? task.workflowId
    subject = (
      <Link
        to="/workflows/$id"
        params={{ id: task.workflowId }}
        className={linkClass}
        title={workflowName}
      >
        {workflowName}
      </Link>
    )
  } else {
    // Link by the FROZEN STABLE ID directly to the canonical page (RFC-223).
    // P2 where a renamed+reused name misidentified the subject). Rendering does no
    // lookup: the id is already frozen on the task, so the ACL-frozen-name invariant
    // (RFC-099) is untouched.
    //   - workgroupId is ALWAYS frozen for a workgroup task (taskExecutionKind).
    //   - sourceAgentId is frozen for agent tasks launched since RFC-175; NULL for
    //     older rows → plain text because mutable names cannot identify a resource.
    //   - workgroupName may be null (group row deleted → frozen name gone) → em-dash.
    const name = isWorkgroup ? (task.workgroupName ?? null) : (task.sourceAgentName ?? null)
    if (name === null) {
      // Deleted group (frozen name unavailable): keep the badge, drop the dead link.
      subject = <span className="data-table__muted">{t('common.emDash')}</span>
    } else if (isWorkgroup && typeof task.workgroupId === 'string' && isWorkgroupTask(task)) {
      subject = (
        <Link
          to="/workgroups/$id"
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
          to="/agents/$id"
          params={{ id: task.sourceAgentId }}
          className={linkClass}
          title={name}
        >
          {name}
        </Link>
      )
    } else if (!isWorkgroup) {
      subject = <span title={name}>{name}</span>
    } else {
      // Unreachable: a workgroup task always freezes workgroupId. Degrade to a
      // plain text rather than guessing a mutable-name identity.
      subject = <span title={name}>{name}</span>
    }
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
        {t(BADGE_KEY[kind])}
      </StatusChip>
    </span>
  )
}

// RFC-243 PR-5 — child-task link for call node_runs on the task detail page.
//
// A call-workflow / call-workgroup node_run carries `childTaskId` (the child
// execution it launched). This renders the「子任务」jump link plus the child's
// live status chip, resolved through the shared useTaskChildren query (one
// fetch per parent task, regardless of how many call rows the table shows).
//
// Degrade path (design §8): the children list is ACL-filtered server-side, so
// a child the viewer cannot see — or one that was deleted — is simply absent
// from the response. Once the list has loaded, an absent child renders as a
// neutral non-link placeholder instead of a dead link. While the list is
// still loading the link is shown optimistically (child membership is a
// superset of parent membership, so the normal case is "visible").

import { Link } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import { TaskStatusChip } from '@/components/TaskStatusChip'
import { useTaskChildren } from '@/hooks/useTaskChildren'

export function ChildTaskLink({ taskId, childTaskId }: { taskId: string; childTaskId: string }) {
  const { t } = useTranslation()
  const children = useTaskChildren(taskId)
  const child = children.data?.find((candidate) => candidate.id === childTaskId)

  if (children.data !== undefined && child === undefined) {
    return (
      <span className="muted" data-testid={`child-task-unavailable-${childTaskId}`}>
        {t('tasks.childTaskUnavailable')}
      </span>
    )
  }
  return (
    <span className="child-task-link" data-testid={`child-task-link-${childTaskId}`}>
      <Link to="/tasks/$id" params={{ id: childTaskId }} className="btn btn--sm">
        {t('tasks.childTaskLink')}
      </Link>
      {child !== undefined && (
        <>
          {' '}
          <TaskStatusChip status={child.status} pulse={child.status === 'running'} />
        </>
      )}
    </span>
  )
}

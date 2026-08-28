import type { TaskMembers } from '@agent-workflow/shared'
import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import { api } from '@/api/client'
import { useActor, useAuthSessionRevision } from '@/hooks/useActor'
import { TASK_QUERY_KEYS } from '@/lib/query-keys'

export function TaskReviewersLinkButton({ taskId }: { taskId: string }) {
  const { t } = useTranslation()
  const actor = useActor()
  const authRevision = useAuthSessionRevision()
  const human = actor.status === 'success' && actor.data !== null && actor.data?.source !== 'daemon'
  const members = useQuery<TaskMembers>({
    queryKey: TASK_QUERY_KEYS.members(taskId, authRevision),
    queryFn: ({ signal }) =>
      api.get(`/api/tasks/${encodeURIComponent(taskId)}/members`, undefined, signal),
    enabled: human,
  })
  if (!human || members.data?.canManage !== true) return null
  return (
    <Link
      to="/tasks/$taskId/reviewers"
      params={{ taskId }}
      className="btn"
      data-testid="task-reviewers-link"
    >
      {t('reviewers.entry')}
    </Link>
  )
}

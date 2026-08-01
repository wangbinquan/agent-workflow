// RFC-245 — the /tasks/:id detail header's parent-task entry, so a user who
// followed a call node down into a child task can walk back up (until now the
// detail page echoed nothing at all for `parentTaskId` — browser Back was the
// only way home).
//
// Why a client probe here, when the LIST does not use one: RFC-244 rebuilt
// `/tasks` around a server-computed `listContext.parentAvailability`, because
// probing per row is an N+1 across a paginated tree. The detail page has no such
// signal on the task wire and only ever needs ONE lookup, which additionally
// pre-warms the `['tasks', parentId]` cache entry the navigation itself will
// use. If the task detail wire ever grows an authorized-parent projection,
// collapse this onto it.
//
// Degrade contract (RFC-243 design §8): a workgroup human member can be a member
// of the CHILD task only, so the parent may be invisible. An existing but
// unauthorized task is a 403 (routes/tasks.ts assertTaskVisible) and a missing
// one is a 404, so ANY probe error collapses to the same neutral, non-link
// label — never a dead link, and never a leak of which of the two it was. The
// parent's NAME is rendered only from a successful probe for the same reason.

import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import type { Task } from '@agent-workflow/shared'
import { api } from '@/api/client'

export interface ParentTaskLinkProps {
  /** The CHILD task's id — used to build the per-instance testid. */
  taskId: string
  parentTaskId: string
  /**
   * Also render the parent's name once the probe resolved. Name is only ever
   * shown from a SUCCESSFUL probe, so it cannot leak the name of a task the
   * viewer may not read.
   */
  showName?: boolean
}

export function ParentTaskLink({ taskId, parentTaskId, showName = false }: ParentTaskLinkProps) {
  const { t } = useTranslation()
  const probe = useQuery<Task>({
    queryKey: ['tasks', parentTaskId],
    queryFn: ({ signal }) =>
      api.get(`/api/tasks/${encodeURIComponent(parentTaskId)}`, undefined, signal),
    retry: false,
    staleTime: 30_000,
  })
  const className = 'chip chip--tight'
  const testId = `task-parent-chip-${taskId}`
  // Error is checked BEFORE data on purpose. react-query keeps the last
  // successful `data` alongside a later error, so a data-first check would keep
  // rendering the parent's name and a live link after access was revoked
  // mid-session (verified: after a 200 then a 403, the observer reports
  // `status:'error'` WITH the stale `data`). Demoting on any error makes the
  // degrade contract above literally true. The cost is tiny here: the app sets
  // `refetchOnWindowFocus: false` (lib/query-client.ts), so refetches only
  // happen on remount past staleTime or on reconnect — a transient blip cannot
  // flap this label.
  if (probe.isError) {
    return (
      <span className={className} data-testid={testId}>
        {t('tasks.parentTaskUnavailable')}
      </span>
    )
  }
  if (probe.data !== undefined) {
    const name = showName ? (probe.data.name ?? null) : null
    return (
      <Link
        to="/tasks/$id"
        params={{ id: parentTaskId }}
        className={className}
        data-testid={testId}
      >
        {name === null || name === ''
          ? t('tasks.parentTaskChip')
          : `${t('tasks.parentTaskChip')} · ${name}`}
      </Link>
    )
  }
  // Still in flight: a neutral, non-link label — never an optimistic link that
  // might turn out to point at a task the viewer cannot open.
  return (
    <span className={className} data-testid={testId}>
      {t('tasks.parentTaskChip')}
    </span>
  )
}

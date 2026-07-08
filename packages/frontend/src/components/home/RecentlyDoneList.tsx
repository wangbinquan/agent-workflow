// RFC-032 PR3: homepage's "Recently finished" section.
//
// Reuses the same `useQuery(['tasks','homepage','recent50'])` cache that
// RunningTaskList feeds — react-query dedupes the in-flight request so we
// don't double-fetch. We then filter to terminal statuses and re-sort by
// finishedAt desc so this section reads as "most-recently completed"
// rather than "most-recently launched".

import { useQuery } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { isTerminalTaskStatus } from '@agent-workflow/shared'
import type { TaskSummary } from '@agent-workflow/shared'
import { api } from '@/api/client'
import { LoadingState } from '@/components/LoadingState'
import { TASKS_HOMEPAGE_QUERY_KEY } from './RunningTaskList'
import { TaskRow } from './task-row'

// flag-audit W0: single source — shared/lifecycle.ts TERMINAL_TASK_STATUSES
// (was a hand-copied 4-value list that could drift from the state machine).

export const RECENT_LIMIT = 8

interface RecentlyDoneListProps {
  onCount?: (n: number) => void
}

export function RecentlyDoneList({ onCount }: RecentlyDoneListProps) {
  const { t } = useTranslation()
  const tasks = useQuery<TaskSummary[]>({
    queryKey: TASKS_HOMEPAGE_QUERY_KEY,
    queryFn: ({ signal }) => api.get('/api/tasks?limit=50', undefined, signal),
    refetchInterval: 10_000,
  })
  const [nowMs, setNowMs] = useState(() => Date.now())
  useEffect(() => {
    const id = window.setInterval(() => setNowMs(Date.now()), 60_000)
    return () => window.clearInterval(id)
  }, [])

  const recent = (tasks.data ?? [])
    .filter((task) => isTerminalTaskStatus(task.status))
    .sort((a, b) => (b.finishedAt ?? b.startedAt) - (a.finishedAt ?? a.startedAt))
    .slice(0, RECENT_LIMIT)

  useEffect(() => {
    onCount?.(recent.length)
  }, [recent.length, onCount])

  if (tasks.isLoading) {
    return <LoadingState size="compact" />
  }
  if (tasks.error !== null && tasks.error !== undefined) {
    return (
      <div className="error-box" role="alert">
        <span>{t('home.section.error.generic')}</span>
        <button
          type="button"
          className="btn btn--xs"
          onClick={() => void tasks.refetch()}
          style={{ marginLeft: 8 }}
        >
          {t('home.section.error.retry')}
        </button>
      </div>
    )
  }
  if (recent.length === 0) {
    return <div className="muted">{t('home.section.empty.recent')}</div>
  }
  return (
    <div className="task-list">
      {recent.map((task) => (
        <TaskRow key={task.id} task={task} nowMs={nowMs} />
      ))}
    </div>
  )
}

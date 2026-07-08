// RFC-032 PR3: Running + awaiting-* tasks for the homepage's first section.
//
// We pull the most-recent 50 tasks via a single `/api/tasks` call (the
// backend orders by startedAt desc) and split client-side. This keeps
// us off the backend's single-status-only query contract — see
// design.md §4.4 — and matches the homepage's "show me what's in flight"
// framing better than 3 separate fan-out queries.

import { useQuery } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TaskStatus, TaskSummary } from '@agent-workflow/shared'
import { api } from '@/api/client'
import { LoadingState } from '@/components/LoadingState'
import { TaskRow } from './task-row'

export const TASKS_HOMEPAGE_QUERY_KEY = ['tasks', 'homepage', 'recent50'] as const

const RUNNING_STATUSES: TaskStatus[] = ['running', 'awaiting_human', 'awaiting_review']

export const RUNNING_LIMIT = 8

interface RunningTaskListProps {
  /** Total count is computed by the caller (parent <HomepageSection>) so the
   *  badge and the visible row count agree even before render. */
  onCount?: (n: number) => void
}

export function RunningTaskList({ onCount }: RunningTaskListProps) {
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

  const running = (tasks.data ?? [])
    .filter((t) => RUNNING_STATUSES.includes(t.status))
    .slice(0, RUNNING_LIMIT)

  useEffect(() => {
    onCount?.(running.length)
  }, [running.length, onCount])

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
  if (running.length === 0) {
    return <div className="muted">{t('home.section.empty.running')}</div>
  }
  return (
    <div className="task-list">
      {running.map((task) => (
        <TaskRow key={task.id} task={task} nowMs={nowMs} />
      ))}
    </div>
  )
}

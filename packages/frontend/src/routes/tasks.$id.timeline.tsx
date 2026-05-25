// RFC-061 G9 — events timeline view.
//
// Pages over GET /api/tasks/:id/timeline, renders the projection event
// log in chronological order. Live updates land via the new
// task.event.appended WS frame the writeEvents broadcaster emits; the
// route subscribes to /ws/tasks/:id and prepends new frames as they
// arrive.
//
// Filters: `kind` query param narrows to one EventKind via the backend
// endpoint's kind filter; tests + power users can deep-link to e.g.
// "?kind=suspension-created" to focus on suspension lifecycle.

import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, createRoute } from '@tanstack/react-router'
import { useEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { api } from '@/api/client'
import { ErrorBanner } from '@/components/ErrorBanner'
import { LoadingState } from '@/components/LoadingState'
import { Route as RootRoute } from './__root'

interface TimelineEvent {
  id: string
  taskId: string
  ts: number
  kind: string
  nodeId: string | null
  loopIter: number | null
  shardKey: string | null
  iter: number | null
  attemptId: string | null
  parentEventId: string | null
  actor: string
  resolutionId: string | null
  payload: unknown
}

interface TimelineResponse {
  events: TimelineEvent[]
  cursor: string | null
}

export const Route = createRoute({
  getParentRoute: () => RootRoute,
  path: '/tasks/$id/timeline',
  component: TaskTimelinePage,
})

function TaskTimelinePage() {
  const { t } = useTranslation()
  const { id } = Route.useParams()
  const qc = useQueryClient()

  const query = useQuery<TimelineResponse>({
    queryKey: ['tasks', id, 'timeline'],
    queryFn: ({ signal }) =>
      api.get(`/api/tasks/${encodeURIComponent(id)}/timeline?limit=500`, undefined, signal),
    refetchInterval: 30_000,
  })

  // Subscribe to /ws/tasks/:id so the timeline reflects events the
  // moment writeEvents fans them out (no polling delay). Invalidates
  // the query — keeps the page simple at the cost of one extra REST
  // round-trip per frame batch. A future optimisation can splice the
  // incoming frame directly into the cached event list.
  useEffect(() => {
    if (typeof window === 'undefined') return
    const url = `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/ws/tasks/${encodeURIComponent(id)}`
    let ws: WebSocket
    try {
      ws = new WebSocket(url)
    } catch {
      return
    }
    ws.addEventListener('message', (ev) => {
      try {
        const msg = JSON.parse(String(ev.data)) as { type?: string }
        if (msg.type === 'task.event.appended') {
          void qc.invalidateQueries({ queryKey: ['tasks', id, 'timeline'] })
        }
      } catch {
        // ignore malformed frames
      }
    })
    return () => {
      try {
        ws.close()
      } catch {
        // ignore
      }
    }
  }, [id, qc])

  const events = useMemo(() => query.data?.events ?? [], [query.data])

  if (query.isLoading) return <LoadingState />
  if (query.error !== null && query.error !== undefined) return <ErrorBanner error={query.error} />

  return (
    <main className="page">
      <header className="page__header page__header--row">
        <div>
          <h1>{t('timeline.title')}</h1>
          <p className="muted">
            <Link to="/tasks/$id" params={{ id }}>
              {t('timeline.backToTask')}
            </Link>{' '}
            · {t('timeline.eventCount', { n: events.length })}
          </p>
        </div>
      </header>

      {events.length === 0 ? (
        <div className="muted">{t('timeline.empty')}</div>
      ) : (
        <ol className="timeline" data-testid="timeline-list">
          {events.map((e) => (
            <li key={e.id} className="timeline__row" data-event-kind={e.kind}>
              <span className="timeline__ts muted">{new Date(e.ts).toISOString()}</span>
              <span className={`timeline__kind timeline__kind--${kindClass(e.kind)}`}>
                {e.kind}
              </span>
              <span className="timeline__actor muted">{e.actor}</span>
              {e.nodeId !== null && (
                <span className="timeline__scope muted">
                  {`node=${e.nodeId} iter=${e.iter ?? '?'}${e.shardKey ? ` shard=${e.shardKey}` : ''}`}
                </span>
              )}
              <details className="timeline__payload">
                <summary className="muted">{t('timeline.payload')}</summary>
                <pre>{formatPayload(e.payload)}</pre>
              </details>
            </li>
          ))}
        </ol>
      )}
    </main>
  )
}

function kindClass(kind: string): string {
  if (kind.startsWith('task-')) return 'task'
  if (kind.startsWith('logical-run-')) return 'lr'
  if (kind.startsWith('attempt-')) return 'attempt'
  if (kind.startsWith('suspension-')) return 'suspension'
  if (kind.startsWith('invariant-')) return 'invariant'
  return 'other'
}

function formatPayload(payload: unknown): string {
  try {
    return typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2)
  } catch {
    return String(payload)
  }
}

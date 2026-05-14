// Task detail page — header (cancel + metadata) + node-runs table + worktree
// diff viewer. Polls each section independently so a slow `diff` request
// doesn't stall the node-run progress feed.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createRoute } from '@tanstack/react-router'
import type {
  Agent,
  NodeRun,
  Task,
  TaskDiff,
  TaskNodeRuns,
  WorkflowDefinition,
} from '@agent-workflow/shared'
import { api, ApiError } from '@/api/client'
import { WorkflowCanvas } from '@/components/canvas/WorkflowCanvas'
import type { CanvasNodeData } from '@/components/canvas/nodes/types'
import { ConfirmButton } from '@/components/ConfirmButton'
import { DiffViewer } from '@/components/DiffViewer'
import { TaskOutputPanel } from '@/components/TaskOutputPanel'
import { TaskStatusChip } from '@/components/TaskStatusChip'
import { useTaskSync } from '@/hooks/useTaskSync'
import { useMemo } from 'react'
import { Route as RootRoute } from './__root'

export const Route = createRoute({
  getParentRoute: () => RootRoute,
  path: '/tasks/$id',
  component: TaskDetailPage,
})

function TaskDetailPage() {
  const { id } = Route.useParams()
  const qc = useQueryClient()
  useTaskSync(id)

  const task = useQuery<Task>({
    queryKey: ['tasks', id],
    queryFn: ({ signal }) => api.get(`/api/tasks/${encodeURIComponent(id)}`, undefined, signal),
    refetchInterval: (q) => (isTerminal(q.state.data?.status) ? false : 3000),
  })

  const nodeRuns = useQuery<TaskNodeRuns>({
    queryKey: ['tasks', id, 'node-runs'],
    queryFn: ({ signal }) =>
      api.get(`/api/tasks/${encodeURIComponent(id)}/node-runs`, undefined, signal),
    refetchInterval: (q) =>
      isTerminal(task.data?.status) && (q.state.data?.runs.length ?? 0) > 0 ? false : 3000,
  })

  const diff = useQuery<TaskDiff>({
    queryKey: ['tasks', id, 'diff'],
    queryFn: ({ signal }) =>
      api.get(`/api/tasks/${encodeURIComponent(id)}/diff`, undefined, signal),
    enabled: task.data !== undefined && task.data.baseCommit !== null,
    refetchInterval: (q) =>
      isTerminal(task.data?.status) && q.state.data !== undefined ? false : 6000,
    retry: false,
  })

  const cancel = useMutation({
    mutationFn: () => api.post<Task>(`/api/tasks/${encodeURIComponent(id)}/cancel`),
    onSuccess: (t) => {
      qc.setQueryData(['tasks', id], t)
      void qc.invalidateQueries({ queryKey: ['tasks'] })
    },
  })

  if (task.isLoading) return <div className="page muted">Loading task…</div>
  if (task.error !== null && task.error !== undefined)
    return <div className="page error-box">{describeError(task.error)}</div>
  if (task.data === undefined) return null

  const t = task.data
  const cancelable = t.status === 'pending' || t.status === 'running'

  return (
    <div className="page page--wide">
      <header className="page__header page__header--row">
        <div>
          <h1>
            <code>{t.id}</code> <TaskStatusChip status={t.status} />
          </h1>
          <dl className="task-meta">
            <dt>Workflow</dt>
            <dd>
              <code>{t.workflowId}</code>
            </dd>
            <dt>Repo</dt>
            <dd>
              <code>{t.repoPath}</code>
            </dd>
            <dt>Worktree</dt>
            <dd>
              <code>{t.worktreePath || '—'}</code>
            </dd>
            <dt>Branch</dt>
            <dd>
              <code>{t.branch}</code> @ <code>{(t.baseCommit ?? '').slice(0, 12) || '—'}</code>
            </dd>
            <dt>Started</dt>
            <dd>{new Date(t.startedAt).toLocaleString()}</dd>
            <dt>Finished</dt>
            <dd>{t.finishedAt === null ? '—' : new Date(t.finishedAt).toLocaleString()}</dd>
            {t.errorSummary !== null && (
              <>
                <dt>Error</dt>
                <dd className="task-meta__error">{t.errorSummary}</dd>
              </>
            )}
          </dl>
        </div>
        <div className="page__actions">
          {cancelable && (
            <ConfirmButton
              label="Cancel task"
              onConfirm={() => cancel.mutateAsync()}
              danger
              disabled={cancel.isPending}
            />
          )}
        </div>
      </header>
      {cancel.error !== null && cancel.error !== undefined && (
        <div className="error-box">{describeError(cancel.error)}</div>
      )}

      {nodeRuns.data !== undefined && (
        <TaskOutputPanel task={t} runs={nodeRuns.data.runs} outputs={nodeRuns.data.outputs} />
      )}

      <section className="page__section">
        <h2>Workflow status</h2>
        <TaskStatusCanvas task={t} runs={nodeRuns.data?.runs ?? []} />
      </section>

      <section className="page__section">
        <h2>Node runs</h2>
        {nodeRuns.isLoading && <div className="muted">Loading…</div>}
        {nodeRuns.error !== null && nodeRuns.error !== undefined && (
          <div className="error-box">{describeError(nodeRuns.error)}</div>
        )}
        {nodeRuns.data !== undefined && <NodeRunsTable runs={nodeRuns.data.runs} />}
      </section>

      <section className="page__section">
        <h2>Worktree diff</h2>
        {t.baseCommit === null ? (
          <div className="muted">No base commit recorded; diff is unavailable.</div>
        ) : diff.isLoading ? (
          <div className="muted">Loading diff…</div>
        ) : diff.error !== null && diff.error !== undefined ? (
          <div className="error-box">{describeError(diff.error)}</div>
        ) : diff.data !== undefined ? (
          <DiffViewer diff={diff.data.diff} truncated={diff.data.truncated} />
        ) : null}
      </section>
    </div>
  )
}

function TaskStatusCanvas({ task, runs }: { task: Task; runs: NodeRun[] }) {
  const definition = useMemo<WorkflowDefinition | null>(() => {
    const snap = task.workflowSnapshot
    if (typeof snap !== 'object' || snap === null) return null
    // Trust the snapshot's shape — it came out of the same code path that
    // validated it at task-start time.
    return snap as WorkflowDefinition
  }, [task.workflowSnapshot])

  const agents = useQuery<Agent[]>({
    queryKey: ['agents'],
    queryFn: ({ signal }) => api.get('/api/agents', undefined, signal),
  })

  const statuses = useMemo<Record<string, CanvasNodeData['status']>>(() => {
    const latest = new Map<string, NodeRun>()
    for (const r of runs) {
      const prev = latest.get(r.nodeId)
      if (prev === undefined || (r.startedAt ?? 0) >= (prev.startedAt ?? 0)) {
        latest.set(r.nodeId, r)
      }
    }
    const out: Record<string, CanvasNodeData['status']> = {}
    for (const [nodeId, run] of latest) {
      out[nodeId] = canvasStatus(run.status)
    }
    return out
  }, [runs])

  if (definition === null) {
    return <div className="muted">No workflow snapshot available.</div>
  }

  return (
    <div className="canvas-frame canvas-frame--task">
      <WorkflowCanvas
        definition={definition}
        agents={agents.data ?? []}
        nodeStatuses={statuses}
        readOnly
      />
    </div>
  )
}

function canvasStatus(s: NodeRun['status']): CanvasNodeData['status'] {
  switch (s) {
    case 'running':
      return 'running'
    case 'done':
      return 'done'
    case 'failed':
    case 'exhausted':
      return 'failed'
    case 'canceled':
    case 'interrupted':
      return 'canceled'
    case 'pending':
      return 'pending'
    case 'skipped':
      return 'skipped'
  }
}

function NodeRunsTable({ runs }: { runs: NodeRun[] }) {
  if (runs.length === 0)
    return <div className="muted">No node runs yet; scheduler hasn't reached any nodes.</div>
  return (
    <table className="data-table">
      <thead>
        <tr>
          <th>Node</th>
          <th>Status</th>
          <th>Iteration</th>
          <th>Retry</th>
          <th>Started</th>
          <th>Duration</th>
          <th>Error</th>
        </tr>
      </thead>
      <tbody>
        {runs.map((r) => (
          <tr key={r.id}>
            <td>
              <code>{r.nodeId}</code>
              {r.shardKey !== null && <span className="muted"> · {r.shardKey}</span>}
            </td>
            <td>
              <span className={`status-chip status-chip--${noderunTone(r.status)}`}>
                {r.status}
              </span>
            </td>
            <td className="data-table__muted">{r.iteration}</td>
            <td className="data-table__muted">{r.retryIndex}</td>
            <td className="data-table__muted">
              {r.startedAt === null ? '—' : new Date(r.startedAt).toLocaleTimeString()}
            </td>
            <td className="data-table__muted">
              {r.startedAt === null || r.finishedAt === null
                ? '—'
                : `${Math.round((r.finishedAt - r.startedAt) / 100) / 10}s`}
            </td>
            <td className="data-table__muted">{r.errorMessage ?? '—'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function noderunTone(status: NodeRun['status']): string {
  switch (status) {
    case 'pending':
    case 'skipped':
      return 'gray'
    case 'running':
      return 'blue'
    case 'done':
      return 'green'
    case 'failed':
    case 'exhausted':
      return 'red'
    case 'interrupted':
      return 'amber'
    case 'canceled':
      return 'gray'
  }
}

function isTerminal(status: Task['status'] | undefined): boolean {
  return (
    status === 'done' || status === 'failed' || status === 'canceled' || status === 'interrupted'
  )
}

function describeError(e: unknown): string {
  if (e instanceof ApiError) return `${e.code}: ${e.message}`
  if (e instanceof Error) return e.message
  return String(e)
}

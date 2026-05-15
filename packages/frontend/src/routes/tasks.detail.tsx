// Task detail page — header (cancel + metadata) + node-runs table + worktree
// diff viewer. Polls each section independently so a slow `diff` request
// doesn't stall the node-run progress feed.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createRoute, Link } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import type {
  Agent,
  NodeRun,
  Task,
  TaskDiff,
  TaskNodeRuns,
  WorkflowDefinition,
} from '@agent-workflow/shared'
import { api, ApiError } from '@/api/client'
import { WorkflowCanvas, type WorkflowCanvasHandle } from '@/components/canvas/WorkflowCanvas'
import type { CanvasNodeData } from '@/components/canvas/nodes/types'
import { ConfirmButton } from '@/components/ConfirmButton'
import { DiffViewer } from '@/components/DiffViewer'
import { NodeDetailDrawer } from '@/components/NodeDetailDrawer'
import { TaskOutputPanel } from '@/components/TaskOutputPanel'
import { TaskStatusChip } from '@/components/TaskStatusChip'
import { useTaskSync } from '@/hooks/useTaskSync'
import { useMemo, useRef, useState } from 'react'
import { Route as RootRoute } from './__root'

export const Route = createRoute({
  getParentRoute: () => RootRoute,
  path: '/tasks/$id',
  component: TaskDetailPage,
})

function TaskDetailPage() {
  const { t } = useTranslation()
  const { id } = Route.useParams()
  const qc = useQueryClient()
  useTaskSync(id)
  const [selectedNodeRunId, setSelectedNodeRunId] = useState<string | null>(null)
  // Same shape as the editor route: the drawer ✕ must drive xyflow's
  // selection clear, otherwise the underlying node stays highlighted and
  // a re-click on it is swallowed by xyflow's `handleNodeClick`. See
  // `WorkflowCanvas.clearSelection` for the canonical
  // `unselectNodesAndEdges` path this delegates to.
  const canvasRef = useRef<WorkflowCanvasHandle | null>(null)
  const closeNodeDrawer = () => {
    canvasRef.current?.clearSelection()
    setSelectedNodeRunId(null)
  }

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
    onSuccess: (tk) => {
      qc.setQueryData(['tasks', id], tk)
      void qc.invalidateQueries({ queryKey: ['tasks'] })
    },
  })

  const resume = useMutation({
    mutationFn: () => api.post<Task>(`/api/tasks/${encodeURIComponent(id)}/resume`),
    onSuccess: (tk) => {
      qc.setQueryData(['tasks', id], tk)
      void qc.invalidateQueries({ queryKey: ['tasks', id, 'node-runs'] })
      void qc.invalidateQueries({ queryKey: ['tasks'] })
    },
  })

  if (task.isLoading) return <div className="page muted">{t('tasks.loadingTask')}</div>
  if (task.error !== null && task.error !== undefined)
    return <div className="page error-box">{describeError(task.error)}</div>
  if (task.data === undefined) return null

  const tk = task.data
  const cancelable = tk.status === 'pending' || tk.status === 'running'
  const resumability = resumeStatus(tk.status, tk.worktreePath)

  return (
    <div className="page page--wide">
      <header className="page__header page__header--row">
        <div>
          <h1>
            <code>{tk.id}</code> <TaskStatusChip status={tk.status} />
          </h1>
          <dl className="task-meta">
            <dt>{t('tasks.metaWorkflow')}</dt>
            <dd>
              <Link to="/workflows/$id" params={{ id: tk.workflowId }} className="data-table__link">
                {tk.workflowName ?? tk.workflowId}
              </Link>
              {tk.workflowName !== null && (
                <>
                  {' '}
                  <span className="data-table__muted">
                    (<code>{tk.workflowId}</code>)
                  </span>
                </>
              )}
            </dd>
            <dt>{t('tasks.metaRepo')}</dt>
            <dd>
              <code>{tk.repoPath}</code>
            </dd>
            <dt>{t('tasks.metaWorktree')}</dt>
            <dd>
              <code>{tk.worktreePath || t('common.emDash')}</code>
            </dd>
            <dt>{t('tasks.metaBranch')}</dt>
            <dd>
              <code>{tk.branch}</code> @{' '}
              <code>{(tk.baseCommit ?? '').slice(0, 12) || t('common.emDash')}</code>
            </dd>
            <dt>{t('tasks.metaStarted')}</dt>
            <dd>{new Date(tk.startedAt).toLocaleString()}</dd>
            <dt>{t('tasks.metaFinished')}</dt>
            <dd>
              {tk.finishedAt === null
                ? t('common.emDash')
                : new Date(tk.finishedAt).toLocaleString()}
            </dd>
            {tk.errorSummary !== null && (
              <>
                <dt>{t('tasks.metaError')}</dt>
                <dd className="task-meta__error">{tk.errorSummary}</dd>
              </>
            )}
          </dl>
        </div>
        <div className="page__actions">
          {resumability === 'ready' && (
            <button
              type="button"
              className="btn btn--primary"
              onClick={() => resume.mutate()}
              disabled={resume.isPending}
            >
              {resume.isPending ? t('tasks.resuming') : t('tasks.resumeButton')}
            </button>
          )}
          {cancelable && (
            <ConfirmButton
              label={t('tasks.cancelButton')}
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
      {resume.error !== null && resume.error !== undefined && (
        <div className="error-box">{describeError(resume.error)}</div>
      )}
      {resumability === 'worktree-missing' && (
        <div className="info-box info-box--muted">
          <span>{t('tasks.resumeUnavailableNoWorktree')}</span>{' '}
          <Link to="/workflows/$id/launch" params={{ id: tk.workflowId }} className="btn btn--sm">
            {t('tasks.resumeLaunchLink')}
          </Link>
        </div>
      )}

      {tk.status === 'failed' && tk.errorSummary !== null && (
        <div className="task-error-banner">
          <div>
            <strong>{t('tasks.failedBanner')}</strong> <span>{tk.errorSummary}</span>
            {tk.errorMessage !== null && tk.errorMessage !== tk.errorSummary && (
              <details className="task-error-banner__details">
                <summary>{t('common.details')}</summary>
                <pre>{tk.errorMessage}</pre>
              </details>
            )}
          </div>
          {tk.failedNodeId !== null && nodeRuns.data !== undefined && (
            <button
              type="button"
              className="btn btn--sm btn--danger"
              onClick={() => {
                // Walk node-runs for the failedNodeId and pick the latest.
                const candidates = nodeRuns.data!.runs.filter((r) => r.nodeId === tk.failedNodeId)
                const target = candidates.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))[0]
                if (target !== undefined) setSelectedNodeRunId(target.id)
              }}
            >
              {t('tasks.jumpToFailed', { nodeId: tk.failedNodeId })}
            </button>
          )}
        </div>
      )}

      {(tk.status === 'canceled' || tk.status === 'interrupted') && tk.worktreePath !== '' && (
        <div className="info-box info-box--muted">
          <span>{t('tasks.worktreePreserved', { path: tk.worktreePath })}</span>
        </div>
      )}

      {nodeRuns.data !== undefined && (
        <TaskOutputPanel task={tk} runs={nodeRuns.data.runs} outputs={nodeRuns.data.outputs} />
      )}

      <section className="page__section">
        <h2>{t('tasks.sectionWorkflowStatus')}</h2>
        <div className={taskCanvasLayoutClass(selectedNodeRunId)}>
          <TaskStatusCanvas
            canvasRef={canvasRef}
            task={tk}
            runs={nodeRuns.data?.runs ?? []}
            onSelectNodeRun={setSelectedNodeRunId}
          />
          {selectedNodeRunId !== null && nodeRuns.data !== undefined && (
            <NodeDetailDrawer
              taskId={id}
              taskStatus={tk.status}
              nodeRunId={selectedNodeRunId}
              nodeId={resolveNodeIdFromRuns(nodeRuns.data.runs, selectedNodeRunId)}
              workflowNodeKind={resolveNodeKindFromSnapshot(
                tk.workflowSnapshot,
                resolveNodeIdFromRuns(nodeRuns.data.runs, selectedNodeRunId),
              )}
              runs={nodeRuns.data.runs}
              outputs={nodeRuns.data.outputs}
              onClose={closeNodeDrawer}
              onSelectRun={setSelectedNodeRunId}
            />
          )}
        </div>
      </section>

      <section className="page__section">
        <h2>{t('tasks.sectionNodeRuns')}</h2>
        {nodeRuns.isLoading && <div className="muted">{t('common.loading')}</div>}
        {nodeRuns.error !== null && nodeRuns.error !== undefined && (
          <div className="error-box">{describeError(nodeRuns.error)}</div>
        )}
        {nodeRuns.data !== undefined && <NodeRunsTable runs={nodeRuns.data.runs} />}
      </section>

      <section className="page__section">
        <h2>{t('tasks.sectionWorktreeDiff')}</h2>
        {tk.baseCommit === null ? (
          <div className="muted">{t('tasks.noBaseCommit')}</div>
        ) : diff.isLoading ? (
          <div className="muted">{t('tasks.loadingDiff')}</div>
        ) : diff.error !== null && diff.error !== undefined ? (
          <div className="error-box">{describeError(diff.error)}</div>
        ) : diff.data !== undefined ? (
          <DiffViewer diff={diff.data.diff} truncated={diff.data.truncated} />
        ) : null}
      </section>
    </div>
  )
}

function TaskStatusCanvas({
  canvasRef,
  task,
  runs,
  onSelectNodeRun,
}: {
  canvasRef?: React.Ref<WorkflowCanvasHandle>
  task: Task
  runs: NodeRun[]
  onSelectNodeRun: (id: string | null) => void
}) {
  const { t } = useTranslation()
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

  const latestRunByNode = useMemo(() => {
    const m = new Map<string, NodeRun>()
    for (const r of runs) {
      const prev = m.get(r.nodeId)
      if (prev === undefined || (r.startedAt ?? 0) >= (prev.startedAt ?? 0)) {
        m.set(r.nodeId, r)
      }
    }
    const idMap = new Map<string, string>()
    for (const [nodeId, r] of m) idMap.set(nodeId, r.id)
    return idMap
  }, [runs])

  if (definition === null) {
    return <div className="muted">{t('tasks.noWorkflowSnapshot')}</div>
  }

  return (
    <div className="canvas-frame canvas-frame--task">
      <WorkflowCanvas
        ref={canvasRef}
        definition={definition}
        agents={agents.data ?? []}
        nodeStatuses={statuses}
        onSelect={(sel) => {
          if (sel === null || sel.kind !== 'node') {
            onSelectNodeRun(null)
            return
          }
          const runId = latestRunByNode.get(sel.id)
          onSelectNodeRun(runId ?? null)
        }}
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
    // RFC-005: review nodes get their own canvas visual in PR-D. For now,
    // map to pending so the existing color palette doesn't crash.
    case 'awaiting_review':
      return 'pending'
  }
}

function NodeRunsTable({ runs }: { runs: NodeRun[] }) {
  const { t } = useTranslation()
  if (runs.length === 0) return <div className="muted">{t('tasks.noNodeRuns')}</div>
  return (
    <table className="data-table">
      <thead>
        <tr>
          <th>{t('tasks.colNode')}</th>
          <th>{t('tasks.colStatus')}</th>
          <th>{t('tasks.colIteration')}</th>
          <th>{t('tasks.colRetry')}</th>
          <th>{t('tasks.colStarted')}</th>
          <th>{t('tasks.colDuration')}</th>
          <th>{t('tasks.colError')}</th>
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
              {r.startedAt === null
                ? t('common.emDash')
                : new Date(r.startedAt).toLocaleTimeString()}
            </td>
            <td className="data-table__muted">
              {r.startedAt === null || r.finishedAt === null
                ? t('common.emDash')
                : `${Math.round((r.finishedAt - r.startedAt) / 100) / 10}s`}
            </td>
            <td className="data-table__muted">{r.errorMessage ?? t('common.emDash')}</td>
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
    case 'awaiting_review':
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

/**
 * Class list for the task-detail canvas grid. The `--with-drawer`
 * modifier reserves a 480px (shrinkable to 320) inspector track — we
 * only apply it when a node run is actually selected. Without the
 * gate, the empty drawer column permanently donates ~480px to a
 * non-existent inspector and crushes the canvas to ~82px on narrow
 * viewports.
 *
 * Exported for unit testing — mirrors `editorLayoutClass`.
 */
export function taskCanvasLayoutClass(selectedNodeRunId: string | null): string {
  return selectedNodeRunId !== null
    ? 'task-canvas-layout task-canvas-layout--with-drawer'
    : 'task-canvas-layout'
}

/**
 * Three-state predicate for the Resume button. Two failure shapes deserve
 * different UI:
 *   - `ready` — task failed AFTER the worktree was created. Resume can
 *     roll back the failed node and re-run; show a Resume button.
 *   - `worktree-missing` — task failed at worktree creation itself, so
 *     `worktreePath === ''`. The backend's resumeTask explicitly
 *     "kicks the scheduler without re-creating the worktree" (see
 *     task.ts:287-288), so resume would just re-fail the same way.
 *     Surface a hint pointing the user at /workflows/$id/launch instead.
 *   - `not-resumable` — task is still running / pending / done, no
 *     resume action applicable.
 *
 * Exported for unit tests.
 */
export function resumeStatus(
  status: Task['status'],
  worktreePath: string,
): 'ready' | 'worktree-missing' | 'not-resumable' {
  if (status !== 'failed' && status !== 'interrupted') return 'not-resumable'
  if (worktreePath === '') return 'worktree-missing'
  return 'ready'
}

function describeError(e: unknown): string {
  if (e instanceof ApiError) return `${e.code}: ${e.message}`
  if (e instanceof Error) return e.message
  return String(e)
}

/**
 * RFC-011: map a selected `node_run.id` back to the workflow `node.id` so
 * the drawer's Prompt-tab attempts switcher can list every node_run that
 * shares the same workflow node id.
 *
 * Exported for unit tests.
 */
export function resolveNodeIdFromRuns(runs: NodeRun[], nodeRunId: string | null): string | null {
  if (nodeRunId === null) return null
  return runs.find((r) => r.id === nodeRunId)?.nodeId ?? null
}

/**
 * RFC-011: pluck the workflow node kind from the task's frozen snapshot
 * (kind tells the Prompt tab whether to render the attempts switcher or an
 * "N/A — no opencode prompt" hint).
 *
 * Exported for unit tests.
 */
export function resolveNodeKindFromSnapshot(
  snapshot: unknown,
  nodeId: string | null,
): string | null {
  if (nodeId === null) return null
  if (typeof snapshot !== 'object' || snapshot === null) return null
  const nodes = (snapshot as { nodes?: unknown }).nodes
  if (!Array.isArray(nodes)) return null
  for (const n of nodes) {
    if (typeof n !== 'object' || n === null) continue
    const node = n as { id?: unknown; kind?: unknown }
    if (node.id === nodeId && typeof node.kind === 'string') return node.kind
  }
  return null
}

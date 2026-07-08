// Task detail page — header (cancel + metadata) + node-runs table + worktree
// diff viewer. Polls each section independently so a slow `diff` request
// doesn't stall the node-run progress feed.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createRoute, Link } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import type {
  Agent,
  ClarifyDirective,
  NodeRun,
  StructuralDiff,
  Task,
  TaskDiff,
  TaskNodeRuns,
  WorkflowDefinition,
} from '@agent-workflow/shared'
import { COMMIT_PUSH_NODE_PREFIX, redactGitUrl } from '@agent-workflow/shared'
import { api, ApiError } from '@/api/client'
import { LoadingState } from '@/components/LoadingState'
import { WorkflowCanvas, type WorkflowCanvasHandle } from '@/components/canvas/WorkflowCanvas'
import type { CanvasNodeData } from '@/components/canvas/nodes/types'
import { ConfirmButton } from '@/components/ConfirmButton'
import { RecoverySection } from '@/components/tasks/RecoverySection'
import { StuckTaskBanner } from '@/components/tasks/StuckTaskBanner'
import { WorkflowSyncBanner } from '@/components/tasks/WorkflowSyncBanner'
import { TaskFeedbackList } from '@/components/tasks/TaskFeedbackList'
import { TaskQuestionList, type TaskQuestionEntry } from '@/components/tasks/TaskQuestionList'
import { TaskMembersDialogButton } from '@/components/tasks/TaskMembersPanel'
import { NodeDetailDrawer } from '@/components/NodeDetailDrawer'
import { Dialog } from '@/components/Dialog'
import { SessionTab } from '@/components/node-session/SessionTab'
import { collectPorts, TaskOutputPanel } from '@/components/TaskOutputPanel'
import { Segmented } from '@/components/Segmented'
import { StatusChip } from '@/components/StatusChip'
import { TabBar } from '@/components/TabBar'
import { TaskStatusChip } from '@/components/TaskStatusChip'
import { WorktreeDiffPanel } from '@/components/WorktreeDiffPanel'
import { StructuralDiffView } from '@/components/structure/StructuralDiffView'
import { Select } from '@/components/Select'
import { WorktreeFilesPanel } from '@/components/WorktreeFilesPanel'
import {
  classifyCanceled,
  displayNoderunStatusKey,
  nodeRunStatusToKind,
} from '@/lib/noderun-status'
import { agentNodeOptionsFromSnapshot, resolveNodeNameFromSnapshot } from '@/lib/node-names'
import { reviewRunDisplay } from '@/lib/reviewRunDisplay'
import {
  availableTabs,
  isTerminal,
  nextTabForFailedJump,
  type TaskDetailTab,
} from '@/lib/task-detail-tabs'
import { useTaskSync } from '@/hooks/useTaskSync'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
  // RFC-021: page-level tab state. Default is the workflow-status canvas
  // since that's the most actionable view for a running task.
  const [tab, setTab] = useState<TaskDetailTab>('workflow-status')
  // RFC-120 D13: a canvas question-badge click jumps here. The incrementing
  // `key` makes each click a fresh signal so clicking the SAME node twice still
  // re-applies the board filter (TaskQuestionList keys its effect off `.key`).
  // 2026-07-02 badge-dimension fix: the focused node is the HANDLER (effective
  // target), matching what the badge counts.
  const [focusTargetNode, setFocusTargetNode] = useState<{ nodeId: string; key: number } | null>(
    null,
  )
  const focusKeyRef = useRef(0)
  const jumpToQuestions = useCallback((nodeId: string) => {
    focusKeyRef.current += 1
    setFocusTargetNode({ nodeId, key: focusKeyRef.current })
    setTab('task-questions')
  }, [])
  // RFC-083: structural-diff scope — 'task' or `node:${nodeRunId}`.
  const [structScope, setStructScope] = useState<string>('task')
  // RFC-083: engine — 'baseline' (always available) or 'deep' (external SCIP
  // indexer; auto-falls back to baseline when unavailable).
  const [engineMode, setEngineMode] = useState<'baseline' | 'deep'>('baseline')
  // RFC-083: text↔structure cross-nav — file to focus when jumping to the diff.
  const [diffFocusFile, setDiffFocusFile] = useState<string | null>(null)
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

  // RFC-128: task-question count for the 「问题」tab badge. Same query key as the
  // canvas badges (TaskStatusCanvas) so they share one cache entry + useTaskSync
  // invalidation. Non-member / no-questions → [] → 0 → no badge.
  const taskQuestionsForBadge = useQuery<TaskQuestionEntry[], ApiError>({
    queryKey: ['task-questions', id],
    queryFn: ({ signal }) =>
      api.get(`/api/tasks/${encodeURIComponent(id)}/questions`, undefined, signal),
    retry: false,
  })
  const pendingQuestionCount = useMemo(
    // RFC-128 (用户 2026-06-29): 「待处理」= 待指派(pending) + 待下发(staged) 两态——
    // 需人答/分配/下发的那些；不含处理中(在跑) / 已处理待确认(待确认) / 完成。
    () =>
      (taskQuestionsForBadge.data ?? []).filter(
        (e) => e.phase === 'pending' || e.phase === 'staged',
      ).length,
    [taskQuestionsForBadge.data],
  )

  // RFC-083 — structural (semantic) diff for the task scope. Same gating as the
  // textual diff (needs a base commit); refetches while the task is live.
  const structuralDiff = useQuery<StructuralDiff>({
    queryKey: ['tasks', id, 'structural-diff', structScope, engineMode],
    queryFn: ({ signal }) => {
      const params = new URLSearchParams()
      if (structScope.startsWith('node:')) {
        params.set('scope', 'node')
        params.set('nodeRunId', structScope.slice('node:'.length))
      } else {
        params.set('scope', 'task')
      }
      if (engineMode === 'deep') params.set('mode', 'deep')
      return api.get(
        `/api/tasks/${encodeURIComponent(id)}/structural-diff?${params.toString()}`,
        undefined,
        signal,
      )
    },
    // Only when the Structure tab is open: the analysis is expensive (git grep +
    // tree-sitter parse), and the scope <Select> must not mount into the DOM on
    // other tabs (else a page-wide `[role=combobox]` locator grabs it).
    enabled:
      tab === 'worktree-structure' && task.data !== undefined && task.data.baseCommit !== null,
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

  // Compute `hasOutputs` from the optional snapshot so the useEffect can
  // run on every render — including the initial loading render. React's
  // rules-of-hooks forbids calling hooks after a conditional return, so
  // this must sit above the `if (task.isLoading) return ...` guards.
  const hasOutputs =
    task.data === undefined ? false : collectPorts(task.data.workflowSnapshot).length > 0
  const tabs = availableTabs({ hasOutputs })
  // RFC-120: agent nodes of the frozen snapshot — reassign candidates for the
  // task question board (only agent nodes are valid handlers). Labels resolve to
  // the node's display name (title → agentName → id fallback, same oracle as the
  // node-runs table) — the board must show 节点名，不是节点 ID (用户 2026-07-02).
  const agentNodeOptions = useMemo(
    () => agentNodeOptionsFromSnapshot(task.data?.workflowSnapshot),
    [task.data?.workflowSnapshot],
  )
  // If the user was on the outputs tab and hasOutputs flips false (mostly
  // defensive — the snapshot is frozen at task start), fall back to the
  // canvas. Always-mount strategy keeps panes in the DOM, but the tab
  // bar must reflect what's actually selectable.
  useEffect(() => {
    if (!tabs.includes(tab)) setTab('workflow-status')
  }, [tabs, tab])

  if (task.isLoading) return <div className="page muted">{t('tasks.loadingTask')}</div>
  if (task.error !== null && task.error !== undefined)
    return <div className="page error-box">{describeError(task.error)}</div>
  if (task.data === undefined) return null

  const tk = task.data
  const cancelable = tk.status === 'pending' || tk.status === 'running'
  const resumability = resumeStatus(tk.status, tk.worktreePath)

  return (
    <div className="page page--task-detail">
      <header className="page__header page__header--row">
        <div>
          {/* RFC-037: user-supplied display name is the primary heading;
              the ULID drops to a muted subtitle so it stays copyable but
              doesn't dominate the page. */}
          <h1 className="task-detail__title">
            <span className="task-detail__name">{tk.name}</span>{' '}
            <TaskStatusChip status={tk.status} />
          </h1>
          <div className="task-detail__id">
            <span className="task-detail__id-label">{t('tasks.detailTitleIdLabel')}</span>{' '}
            <code>{tk.id}</code>
          </div>
          {/* Jump link to the owning workflow, surfaced in the always-visible
              page header. The full meta row (with parenthesised ULID) still
              lives in the "details" tab, but that tab isn't the default — so
              without this a user landing on a task can't reach its workflow
              without first switching tabs. Reuses the same data-table__link
              style the details-tab + tasks-list workflow links use. */}
          <div className="task-detail__workflow">
            <span className="task-detail__id-label">{t('tasks.metaWorkflow')}</span>{' '}
            <Link
              to="/workflows/$id"
              params={{ id: tk.workflowId }}
              className="data-table__link"
              data-testid="task-detail-header-workflow-link"
            >
              {tk.workflowName ?? tk.workflowId}
            </Link>
          </div>
        </div>
        <div className="page__actions">
          <TaskMembersDialogButton taskId={id} />
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
              variant="danger"
              disabled={cancel.isPending}
            />
          )}
        </div>
      </header>
      <StuckTaskBanner taskId={id} />
      <WorkflowSyncBanner taskId={id} />
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
          <div className="task-error-banner__body">
            <div className="task-error-banner__summary" title={tk.errorSummary}>
              <strong>{t('tasks.failedBanner')}</strong> <span>{tk.errorSummary}</span>
            </div>
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
                const { runId, tab: next } = nextTabForFailedJump(
                  nodeRuns.data!.runs,
                  tk.failedNodeId,
                )
                if (runId !== null) setSelectedNodeRunId(runId)
                setTab(next)
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

      {/* RFC-108 T21/T23: system-recovery audit + auto-recovery quarantine clear,
          live-polled while the task is active (same idiom as the task/node-runs queries). */}
      <RecoverySection taskId={id} status={tk.status} />

      <TabBar<TaskDetailTab>
        className="task-detail__tab-bar"
        tabs={tabs.map((k) => ({
          key: k,
          label: tabLabel(t, k),
          // RFC-128: 「问题」tab carries a non-terminal pending-question count badge.
          badge:
            k === 'task-questions' && pendingQuestionCount > 0 ? pendingQuestionCount : undefined,
          badgeTestid: k === 'task-questions' ? 'tq-tab-badge' : undefined,
        }))}
        active={tab}
        onSelect={setTab}
      />

      <div className="task-detail__panes">
        {/* workflow-status: always mounted so xyflow viewport survives tab switches. */}
        <div className="task-detail__pane" hidden={tab !== 'workflow-status'}>
          <div className={taskCanvasLayoutClass(selectedNodeRunId)}>
            <TaskStatusCanvas
              canvasRef={canvasRef}
              task={tk}
              runs={nodeRuns.data?.runs ?? []}
              onSelectNodeRun={setSelectedNodeRunId}
              onJumpToQuestions={jumpToQuestions}
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
                agentName={resolveAgentNameFromSnapshot(
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
        </div>

        <div className="task-detail__pane" hidden={tab !== 'node-runs'}>
          {nodeRuns.isLoading && <LoadingState size="compact" />}
          {nodeRuns.error !== null && nodeRuns.error !== undefined && (
            <div className="error-box">{describeError(nodeRuns.error)}</div>
          )}
          {nodeRuns.data !== undefined && (
            <NodeRunsTable runs={nodeRuns.data.runs} workflowSnapshot={tk.workflowSnapshot} />
          )}
        </div>

        <div className="task-detail__pane" hidden={tab !== 'details'}>
          {/* RFC-066: multi-repo summary. Single-repo tasks (repoCount === 1)
              render nothing here — byte-baseline visual against pre-RFC-066.
              Multi-repo shows a collapsible block listing every repo's
              sub-dir name, baseBranch, and (when present) redacted URL. */}
          {tk.repoCount > 1 && (
            <details className="task-detail__multi-repo" data-testid="task-detail-multi-repo">
              <summary>{t('tasks.multiRepoSummary', { count: tk.repoCount })}</summary>
              <ul className="task-detail__multi-repo-list">
                {tk.repos.map((r) => (
                  <li key={r.repoIndex} data-testid={`task-detail-multi-repo-row-${r.repoIndex}`}>
                    <code>{r.worktreeDirName || r.repoPath}</code>
                    {' @ '}
                    <code>{r.baseBranch || t('common.emDash')}</code>
                    {r.repoUrl !== null && r.repoUrl !== '' && (
                      <span className="data-table__muted"> · {redactGitUrl(r.repoUrl)}</span>
                    )}
                  </li>
                ))}
              </ul>
            </details>
          )}
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
            {tk.repoUrl !== null && (
              <>
                <dt>{t('tasks.metaRepoUrl')}</dt>
                <dd>
                  <code data-testid="task-detail-repo-url">{redactGitUrl(tk.repoUrl)}</code>
                </dd>
              </>
            )}
            <dt>{tk.repoUrl !== null ? t('tasks.metaRepoCachePath') : t('tasks.metaRepo')}</dt>
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
            {/* RFC-075: surface the base branch + (user-specified) working
                branch. Working branch null → the framework isolation branch. */}
            <dt>{t('tasks.metaBaseBranch')}</dt>
            <dd>
              <code data-testid="task-detail-base-branch">
                {tk.baseBranch || t('common.emDash')}
              </code>
            </dd>
            <dt>{t('tasks.metaWorkingBranch')}</dt>
            <dd>
              {tk.workingBranch !== null ? (
                <code data-testid="task-detail-working-branch">{tk.workingBranch}</code>
              ) : (
                <span className="data-table__muted" data-testid="task-detail-working-branch">
                  {t('tasks.metaWorkingBranchNone')}
                </span>
              )}
              {tk.autoCommitPush && (
                <span className="data-table__muted"> · {t('tasks.metaAutoCommitPushOn')}</span>
              )}
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

        {hasOutputs && (
          <div className="task-detail__pane" hidden={tab !== 'outputs'}>
            {nodeRuns.data !== undefined && (
              <TaskOutputPanel
                task={tk}
                runs={nodeRuns.data.runs}
                outputs={nodeRuns.data.outputs}
              />
            )}
          </div>
        )}

        {/* RFC-065 — worktree files browser, between outputs and worktree-diff. */}
        <div className="task-detail__pane" hidden={tab !== 'worktree-files'}>
          {tk.worktreePath === '' ? (
            <div className="muted">{t('tasks.worktreeFilesNoWorktree')}</div>
          ) : (
            <WorktreeFilesPanel taskId={tk.id} />
          )}
        </div>

        <div className="task-detail__pane" hidden={tab !== 'worktree-diff'}>
          {tk.baseCommit === null ? (
            <div className="muted">{t('tasks.noBaseCommit')}</div>
          ) : diff.isLoading ? (
            <div className="muted">{t('tasks.loadingDiff')}</div>
          ) : diff.error !== null && diff.error !== undefined ? (
            <div className="error-box">{describeError(diff.error)}</div>
          ) : diff.data !== undefined ? (
            <WorktreeDiffPanel
              diff={diff.data.diff}
              truncated={diff.data.truncated}
              focusFilePath={diffFocusFile}
              storageKey={tk.id}
            />
          ) : null}
        </div>

        {/* RFC-083 — structural (semantic) diff overlay for the textual diff.
            Content (incl. the scope <Select>) renders only when this tab is
            active: keeps the expensive analysis lazy and keeps a page-wide
            `[role=combobox]` locator from grabbing the hidden scope picker. */}
        <div className="task-detail__pane" hidden={tab !== 'worktree-structure'}>
          {tab !== 'worktree-structure' ? null : tk.baseCommit === null ? (
            <div className="muted">{t('tasks.noBaseCommit')}</div>
          ) : (
            <div className="structure-pane">
              <div className="structure-pane__scope">
                <span className="structure-pane__scope-label">{t('tasks.structScopeLabel')}</span>
                <Select
                  ariaLabel={t('tasks.structScopeLabel')}
                  value={structScope}
                  onChange={setStructScope}
                  options={[
                    { value: 'task', label: t('tasks.structScopeTask') },
                    ...(nodeRuns.data?.runs ?? []).map((r) => ({
                      value: `node:${r.id}`,
                      label: `${r.nodeId} · ${r.status}`,
                    })),
                  ]}
                />
                <span className="structure-pane__scope-label">{t('tasks.structEngineLabel')}</span>
                <Segmented<'baseline' | 'deep'>
                  value={engineMode}
                  onChange={setEngineMode}
                  options={(['baseline', 'deep'] as const).map((m) => ({
                    value: m,
                    label:
                      m === 'baseline'
                        ? t('tasks.structEngineBaseline')
                        : t('tasks.structEngineDeep'),
                  }))}
                  ariaLabel={t('tasks.structEngineLabel')}
                />
              </div>
              {structuralDiff.isLoading ? (
                <div className="muted">{t('tasks.loadingDiff')}</div>
              ) : structuralDiff.error !== null && structuralDiff.error !== undefined ? (
                <div className="error-box">{describeError(structuralDiff.error)}</div>
              ) : structuralDiff.data !== undefined ? (
                <StructuralDiffView
                  data={structuralDiff.data}
                  onJumpToHunk={(anchor) => {
                    setDiffFocusFile(anchor.filePath)
                    setTab('worktree-diff')
                  }}
                />
              ) : null}
            </div>
          )}
        </div>

        {/* RFC-041 PR4: per-task feedback. Originally lived in a fixed
            footer panel below the panes, but a long feedback thread
            squeezed `.task-detail__panes` (flex:1; min-height:0) down to
            zero and hid the task area. Promoting it to its own tab keeps
            the run-monitoring panes their full height. */}
        <div className="task-detail__pane" hidden={tab !== 'feedback'}>
          <TaskFeedbackList taskId={id} />
        </div>
        {/* RFC-120: task question list / 任务中心 board. */}
        <div className="task-detail__pane" hidden={tab !== 'task-questions'}>
          <TaskQuestionList
            taskId={id}
            nodeOptions={agentNodeOptions}
            focusTargetNode={focusTargetNode}
          />
        </div>
      </div>
    </div>
  )
}

function tabLabel(t: (key: string) => string, k: TaskDetailTab): string {
  switch (k) {
    case 'workflow-status':
      return t('tasks.tabWorkflowStatus')
    case 'node-runs':
      return t('tasks.tabNodeRuns')
    case 'details':
      return t('tasks.tabDetails')
    case 'outputs':
      return t('tasks.tabOutputs')
    case 'worktree-files':
      return t('tasks.tabWorktreeFiles')
    case 'worktree-diff':
      return t('tasks.tabWorktreeDiff')
    case 'worktree-structure':
      return t('tasks.tabWorktreeStructure')
    case 'feedback':
      return t('tasks.tabFeedback')
    case 'task-questions':
      return t('tasks.tabQuestions')
  }
}

function TaskStatusCanvas({
  canvasRef,
  task,
  runs,
  onSelectNodeRun,
  onJumpToQuestions,
}: {
  canvasRef?: React.Ref<WorkflowCanvasHandle>
  task: Task
  runs: NodeRun[]
  onSelectNodeRun: (id: string | null) => void
  // RFC-120 D13: invoked with a node id when a canvas question badge is clicked.
  onJumpToQuestions: (nodeId: string) => void
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

  // RFC-120 D13: per source-node pending-question counts for the canvas badges.
  // Same query key as TaskQuestionList so the two share one cache entry (and one
  // useTaskSync invalidation). Non-member / no-questions tasks resolve to {} and
  // paint no badges (golden-lock — canvas unchanged).
  const questions = useQuery<TaskQuestionEntry[], ApiError>({
    queryKey: ['task-questions', task.id],
    queryFn: ({ signal }) =>
      api.get(`/api/tasks/${encodeURIComponent(task.id)}/questions`, undefined, signal),
    retry: false,
  })

  const questionCounts = useMemo<Record<string, number>>(() => {
    const out: Record<string, number> = {}
    for (const e of questions.data ?? []) {
      // RFC-128 (用户 2026-06-30): the canvas node badge counts ONLY 'processing' — the
      // questions this node is actively running. Pre-dispatch (待指派/待下发) live in the
      // question POOL, not on a node; 已处理待确认/完成 no longer belong to the node.
      // 2026-07-02 badge-dimension fix (用户拍板): group by the HANDLER node
      // (effectiveTargetNodeId = override ?? default), NOT the asking source node —
      // "actively running" is the handler's dimension. A question reassigned to a
      // downstream node counts on THAT node's badge (task …QMGP5: 19/1, not 20/0); a
      // manual question (no source node) now badges its target node too.
      if (e.effectiveTargetNodeId !== null && e.phase === 'processing') {
        out[e.effectiveTargetNodeId] = (out[e.effectiveTargetNodeId] ?? 0) + 1
      }
    }
    return out
  }, [questions.data])

  // RFC-122: per-(task, asking-node) clarify directive map for the canvas toggle.
  // Same query key everywhere so useTaskSync's invalidation refreshes it; resolves
  // to {} for a fresh / non-member task ⇒ asking nodes default to 'continue'.
  const qc = useQueryClient()
  const directives = useQuery<Record<string, ClarifyDirective>, ApiError>({
    queryKey: ['task-clarify-directives', task.id],
    queryFn: ({ signal }) =>
      api.get(`/api/tasks/${encodeURIComponent(task.id)}/clarify-directives`, undefined, signal),
    retry: false,
  })
  const setDirective = useMutation<
    unknown,
    ApiError,
    { nodeId: string; directive: ClarifyDirective }
  >({
    mutationFn: ({ nodeId, directive }) =>
      api.post(
        `/api/tasks/${encodeURIComponent(task.id)}/nodes/${encodeURIComponent(nodeId)}/clarify-directive`,
        { directive },
      ),
    // Optimistic flip so the toggle responds instantly; reconciled on settle.
    onMutate: ({ nodeId, directive }) => {
      const key = ['task-clarify-directives', task.id]
      const prev = qc.getQueryData<Record<string, ClarifyDirective>>(key)
      qc.setQueryData<Record<string, ClarifyDirective>>(key, {
        ...(prev ?? {}),
        [nodeId]: directive,
      })
      return { prev }
    },
    onError: (_e, _v, ctx) => {
      const c = ctx as { prev?: Record<string, ClarifyDirective> } | undefined
      if (c?.prev !== undefined) qc.setQueryData(['task-clarify-directives', task.id], c.prev)
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ['task-clarify-directives', task.id] })
    },
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
        questionCounts={questionCounts}
        onNodeQuestionBadgeClick={onJumpToQuestions}
        clarifyDirectives={directives.data ?? {}}
        onNodeClarifyDirectiveToggle={(nodeId, next) =>
          setDirective.mutate({ nodeId, directive: next })
        }
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

// Map a node_run status to the canvas color hint. Exported for unit tests.
export function canvasStatus(s: NodeRun['status']): CanvasNodeData['status'] {
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
    // The task is parked at a human-in-the-loop node: a review awaiting a
    // decision (awaiting_review) or a clarify / cross-clarify awaiting answers
    // (awaiting_human). Both collapse to the unified 'awaiting' canvas state so
    // the node gets the amber pulse highlight. Clarify/CrossClarifyNode translate
    // 'awaiting' back to their own 'awaiting_human' palette value.
    case 'awaiting_review':
    case 'awaiting_human':
      return 'awaiting'
  }
}

// RFC-075: synthetic commit&push node id prefix. Container rows carry
// `commitPush` metadata; the message/repair session children share the nodeId
// but have `commitPush == null` (hidden from the table — reachable via the
// container row's "view session" dialog). flag-audit W0：改用 shared 常量
// （原为与 backend 各写一份的裸字面量）。
const COMMIT_PUSH_PREFIX = COMMIT_PUSH_NODE_PREFIX

function NodeRunsTable({ runs, workflowSnapshot }: { runs: NodeRun[]; workflowSnapshot: unknown }) {
  const { t } = useTranslation()
  if (runs.length === 0) return <div className="muted">{t('tasks.noNodeRuns')}</div>
  // Hide commit-session CHILD rows (kept reachable via the container's dialog).
  const visible = runs.filter(
    (r) => !(r.nodeId.startsWith(COMMIT_PUSH_PREFIX) && r.commitPush == null),
  )
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
        {visible.map((r) => {
          // RFC-075: framework commit&push row — distinct rendering + session dialog.
          if (r.commitPush != null) {
            return <CommitRunRow key={r.id} run={r} allRuns={runs} />
          }
          const name = resolveNodeNameFromSnapshot(workflowSnapshot, r.nodeId) ?? r.nodeId
          // RFC-078: review rows show the CURRENT round's content-anchored start,
          // not the pinned slot-first-open started_at. The duration column renders
          // reviewRunDisplay's unified durationMs — a review's human-review wait and
          // a compute span format identically, with no 人工/非人工 marker. See
          // lib/reviewRunDisplay.
          const { displayStartedAt, durationMs } = reviewRunDisplay(r)
          return (
            <tr key={r.id}>
              <td>
                <span>{name}</span>
                {name !== r.nodeId && (
                  <>
                    {' '}
                    <code className="data-table__muted">{r.nodeId}</code>
                  </>
                )}
                {r.shardKey !== null && <span className="muted"> · {r.shardKey}</span>}
              </td>
              <td>
                <StatusChip kind={nodeRunStatusToKind(r.status)}>
                  {t(displayNoderunStatusKey(r))}
                </StatusChip>
                {shouldShowReviewJump(r.status) && (
                  <>
                    {' '}
                    <Link
                      to="/reviews/$nodeRunId"
                      params={{ nodeRunId: r.id }}
                      search={{}}
                      className="btn btn--sm node-runs__review-link"
                    >
                      {t('tasks.reviewButton')}
                    </Link>
                  </>
                )}
                {shouldShowClarifyJump(r.status) && (
                  <>
                    {' '}
                    <Link
                      to="/clarify/$nodeRunId"
                      params={{ nodeRunId: r.id }}
                      className="btn btn--sm node-runs__clarify-link"
                    >
                      {t('tasks.clarifyButton')}
                    </Link>
                  </>
                )}
              </td>
              <td className="data-table__muted">{r.iteration}</td>
              <td className="data-table__muted">{r.retryIndex}</td>
              <td className="data-table__muted">
                {displayStartedAt === null
                  ? t('common.emDash')
                  : new Date(displayStartedAt).toLocaleTimeString()}
              </td>
              <td className="data-table__muted">
                {durationMs === null ? t('common.emDash') : `${Math.round(durationMs / 100) / 10}s`}
              </td>
              <td className="data-table__muted">
                {classifyCanceled(r) === 'manual'
                  ? (r.errorMessage ?? t('common.emDash'))
                  : t('common.emDash')}
              </td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}

/** RFC-075: i18n key for a commit&push outcome label. */
function commitOutcomeKey(outcome: string): string {
  switch (outcome) {
    case 'pushed':
      return 'tasks.commitOutcomePushed'
    case 'commit-local-auth':
      return 'tasks.commitOutcomeLocalAuth'
    case 'commit-local-failed':
      return 'tasks.commitOutcomeLocalFailed'
    default:
      return 'tasks.commitOutcomeSkippedEmpty'
  }
}

/**
 * RFC-075: a framework commit&push row. Renders the outcome chip + change
 * stats and a "view session" button that opens the message/repair conversation
 * (captured on the child node_runs) in a Dialog, reusing SessionTab.
 */
function CommitRunRow({ run, allRuns }: { run: NodeRun; allRuns: NodeRun[] }) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const cp = run.commitPush!
  // Session children: same nodeId, parent = this container row.
  const sessionRuns = allRuns.filter((r) => r.parentNodeRunId === run.id)
  const latestChild = sessionRuns[sessionRuns.length - 1]
  return (
    <tr data-testid="commit-push-row">
      <td>
        <span>{t('tasks.commitPushNode')}</span>{' '}
        <code className="data-table__muted">{cp.repoBranch}</code>
      </td>
      <td>
        <StatusChip kind={nodeRunStatusToKind(run.status)} data-testid="commit-push-outcome">
          {t(commitOutcomeKey(cp.pushOutcome))}
        </StatusChip>{' '}
        {sessionRuns.length > 0 && latestChild !== undefined && (
          <button
            type="button"
            className="btn btn--sm"
            onClick={() => setOpen(true)}
            data-testid="commit-push-session-btn"
          >
            {t('tasks.commitViewSession')}
          </button>
        )}
        {latestChild !== undefined && (
          <Dialog
            open={open}
            onClose={() => setOpen(false)}
            title={t('tasks.commitSessionTitle')}
            size="lg"
          >
            <SessionTab
              taskId={run.taskId}
              runs={sessionRuns}
              nodeId={run.nodeId}
              selectedRunId={latestChild.id}
              workflowNodeKind="agent-single"
            />
          </Dialog>
        )}
      </td>
      <td className="data-table__muted">{t('common.emDash')}</td>
      <td className="data-table__muted">{cp.repairAttempts}</td>
      <td className="data-table__muted">
        {run.startedAt === null ? t('common.emDash') : new Date(run.startedAt).toLocaleTimeString()}
      </td>
      <td className="data-table__muted">
        {cp.filesChanged > 0
          ? t('tasks.commitFiles', {
              files: cp.filesChanged,
              ins: cp.insertions,
              del: cp.deletions,
            })
          : t('common.emDash')}
      </td>
      <td className="data-table__muted">{cp.pushError ?? t('common.emDash')}</td>
    </tr>
  )
}

/**
 * True when a node_run row should render a "Review" jump button next to
 * its status chip. Only the awaiting-review state hides a pending human
 * action behind the table row; every other status either runs on its own
 * or is terminal. Exported for unit tests.
 */
export function shouldShowReviewJump(status: NodeRun['status']): boolean {
  return status === 'awaiting_review'
}

/**
 * True when a node_run row should render a "Clarify" jump button. The
 * `awaiting_human` status only lives on clarify-node node_runs (see
 * services/clarify.ts createClarifySession), so `r.id` is directly the
 * clarifyNodeRunId expected by /clarify/$nodeRunId.
 */
export function shouldShowClarifyJump(status: NodeRun['status']): boolean {
  return status === 'awaiting_human'
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

/**
 * RFC-022: resolve the primary agent name a workflow node references, so the
 * node-detail drawer can fetch its closure for the Stats tab tree. Only
 * agent-single / agent-multi nodes have an agentName — other kinds (input /
 * output / wrappers / review / clarify) return null and the drawer hides the
 * tree section.
 *
 * Exported for unit tests.
 */
export function resolveAgentNameFromSnapshot(
  snapshot: unknown,
  nodeId: string | null,
): string | null {
  if (nodeId === null) return null
  if (typeof snapshot !== 'object' || snapshot === null) return null
  const nodes = (snapshot as { nodes?: unknown }).nodes
  if (!Array.isArray(nodes)) return null
  for (const n of nodes) {
    if (typeof n !== 'object' || n === null) continue
    const node = n as { id?: unknown; kind?: unknown; agentName?: unknown }
    if (node.id !== nodeId) continue
    // RFC-060 PR-E: agent-multi removed; agent-single is the only agent kind.
    if (node.kind !== 'agent-single') return null
    return typeof node.agentName === 'string' ? node.agentName : null
  }
  return null
}

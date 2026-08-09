// Task detail page — header (cancel + metadata) + node-runs table + worktree
// diff viewer. Polls each section independently so a slow `diff` request
// doesn't stall the node-run progress feed.

import { isWorkgroupTask } from '@agent-workflow/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createRoute, Link, useNavigate } from '@tanstack/react-router'
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
import { COMMIT_PUSH_NODE_PREFIX, redactGitUrl, taskExecutionKind } from '@agent-workflow/shared'
import { api } from '@/api/client'
import type { ApiError } from '@/api/client'
import { EmptyState } from '@/components/EmptyState'
import { ErrorBanner } from '@/components/ErrorBanner'
import { LoadingState } from '@/components/LoadingState'
import { BannerDismissButton, NoticeBanner } from '@/components/NoticeBanner'
import { PageHeader } from '@/components/PageHeader'
import { PageSectionLink, PageSectionNav, type PageSectionGroup } from '@/components/PageSectionNav'
import { TableViewport } from '@/components/TableViewport'
import { TaskSubjectLink } from '@/components/TaskSubjectLink'
import { WorkflowCanvas, type WorkflowCanvasHandle } from '@/components/canvas/WorkflowCanvas'
import type { CanvasNodeData } from '@/components/canvas/nodes/types'
import { ConfirmButton } from '@/components/ConfirmButton'
import { ChildTaskLink } from '@/components/tasks/ChildTaskLink'
import { ParentTaskLink } from '@/components/tasks/ParentTaskLink'
import { RecoverySection } from '@/components/tasks/RecoverySection'
import { StuckTaskBanner } from '@/components/tasks/StuckTaskBanner'
import { WorkflowSyncBanner } from '@/components/tasks/WorkflowSyncBanner'
import { TaskFeedbackList } from '@/components/tasks/TaskFeedbackList'
import { TaskQuestionList, type TaskQuestionEntry } from '@/components/tasks/TaskQuestionList'
import { TaskMembersDialogButton } from '@/components/tasks/TaskMembersPanel'
import { WorkgroupRoom } from '@/components/workgroup/room/WorkgroupRoom'
import { DynamicWorkflowPanel } from '@/components/workgroup/DynamicWorkflowPanel'
import { NodeDetailDrawer } from '@/components/NodeDetailDrawer'
import { Dialog } from '@/components/Dialog'
import { SessionTab } from '@/components/node-session/SessionTab'
import { collectPorts, TaskOutputPanel } from '@/components/TaskOutputPanel'
import { RepoLayoutTree } from '@/components/repos/RepoLayoutTree'
import { StatusChip } from '@/components/StatusChip'
import { ShaRange } from '@/components/ShaRange'
import { TaskStatusChip } from '@/components/TaskStatusChip'
import { ChangeReviewPanel } from '@/components/changes/ChangeReviewPanel'
import { WorktreeFilesPanel } from '@/components/WorktreeFilesPanel'
import {
  classifyCanceled,
  displayNoderunStatusKey,
  nodeRunStatusToKind,
} from '@/lib/noderun-status'
import { agentNodeOptionsFromSnapshot, resolveNodeNameFromSnapshot } from '@/lib/node-names'
import { deriveReviewNodeNav, type ReviewNodeNavKind } from '@/lib/review-node-nav'
import { deriveClarifyNodeNav, type ClarifyNodeNavKind } from '@/lib/clarify-node-nav'
import {
  callNavIsReachable,
  deriveCallNodeNav,
  deriveCurrentCallNodeRun,
  type CallNodeNavKind,
} from '@/lib/call-node-nav'
import { reviewRunDisplay } from '@/lib/reviewRunDisplay'
import { describeTaskFailure } from '@/lib/task-failure'
import {
  canOfferFailedJump,
  deriveTaskDetailCapabilities,
  deriveTaskDetailNavigation,
  isTerminal,
  nextTabForFailedJump,
  type TaskDetailGroup,
  type TaskDetailTab,
} from '@/lib/task-detail-tabs'
import {
  resolveTaskDetailTabs,
  type TaskDetailRoomClassification,
  validateTaskDetailSearch,
  withTaskDetailTab,
} from '@/lib/task-detail-route-tabs'
import { workgroupRoomKey, type WorkgroupRoomResponse } from '@/lib/workgroup-room'
import { hasPermissionAtRequest, useActor, usePermission } from '@/hooks/useActor'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { useTaskSync } from '@/hooks/useTaskSync'
import { useTaskChildren } from '@/hooks/useTaskChildren'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Route as RootRoute } from './__root'

export const Route = createRoute({
  getParentRoute: () => RootRoute,
  path: '/tasks/$id',
  component: TaskDetailPage,
  validateSearch: validateTaskDetailSearch,
  // RFC-245: detail → detail navigation is now a primary interaction (a call
  // node jumps DOWN into its child task, the header's parent link walks back
  // UP), and TanStack Router does not remount a component when only its params
  // change. Without this, every task-scoped `useState` below survives the jump:
  // `selectedNodeRunId` would still hold the PREVIOUS task's run id, which
  // `taskCanvasLayoutClass` reads as "drawer open" and reserves an empty drawer
  // column for (the drawer itself bails out via `run === undefined`), and
  // `dismissedBanners` / `focusTargetNode` / `structScope` would all point at
  // the task we just left. Keying the remount on params — the same idiom as
  // routes/workgroups.detail.tsx and routes/skills.detail.tsx — resets ALL of
  // them at once, so a future state slot cannot be forgotten. `search` is
  // deliberately not a remount dep: switching tabs must not remount.
  remountDeps: ({ params }) => params,
})

function bannerErrorSignature(error: unknown): string {
  if (error instanceof Error) {
    const transport = error as Error & { status?: unknown; code?: unknown }
    return `${error.name}:${String(transport.status ?? '')}:${String(transport.code ?? '')}:${error.message}`
  }
  if (typeof error === 'string') return error
  try {
    return JSON.stringify(error) ?? String(error)
  } catch {
    return String(error)
  }
}

function TaskDetailPage() {
  const { t } = useTranslation()
  const { id } = Route.useParams()
  const search = Route.useSearch()
  const navigateTaskRoute = Route.useNavigate()
  const qc = useQueryClient()
  const actor = useActor()
  useTaskSync(id)
  const [selectedNodeRunId, setSelectedNodeRunId] = useState<string | null>(null)
  const [dismissedBanners, setDismissedBanners] = useState<ReadonlySet<string>>(() => new Set())
  const dismissBanner = useCallback((key: string) => {
    setDismissedBanners((previous) => {
      if (previous.has(key)) return previous
      const next = new Set(previous)
      next.add(key)
      return next
    })
  }, [])
  // RFC-198: every tab write uses this one functional-search navigation path.
  // Canonical fallbacks pass replace=true; user/programmatic jumps use push so
  // Back/Forward traverses panels. Unrelated search payload is preserved.
  const navigateTaskTab = useCallback(
    (next: TaskDetailTab, replace = false) => {
      if (!replace && search.tab === next) return
      void navigateTaskRoute({
        search: (previous) => withTaskDetailTab(previous, next),
        replace,
      })
    },
    [navigateTaskRoute, search.tab],
  )
  // RFC-120 D13: a canvas question-badge click jumps here. The incrementing
  // `key` makes each click a fresh signal so clicking the SAME node twice still
  // re-applies the board filter (TaskQuestionList keys its effect off `.key`).
  // 2026-07-02 badge-dimension fix: the focused node is the HANDLER (effective
  // target), matching what the badge counts.
  const [focusTargetNode, setFocusTargetNode] = useState<{ nodeId: string; key: number } | null>(
    null,
  )
  const focusKeyRef = useRef(0)
  const jumpToQuestions = useCallback(
    (nodeId: string) => {
      focusKeyRef.current += 1
      setFocusTargetNode({ nodeId, key: focusKeyRef.current })
      navigateTaskTab('task-questions')
    },
    [navigateTaskTab],
  )
  // RFC-083: structural-diff scope — 'task' or `node:${nodeRunId}`.
  const [structScope, setStructScope] = useState<string>('task')
  // RFC-083: engine — 'baseline' (always available) or 'deep' (external SCIP
  // indexer; auto-falls back to baseline when unavailable).
  const [engineMode, setEngineMode] = useState<'baseline' | 'deep'>('baseline')
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
  // RFC-245: the node-runs table's per-row entry into the drawer, for CALL rows.
  // A canvas click on a call node now routes to its child task and never opens
  // the drawer (design D1) — but the drawer is where a node's Retry (with the
  // cascade toggle) and its attempt history live, and the failed-task banner
  // only reaches the ONE node the task recorded as `failedNodeId`. So that entry
  // point moves to the table rather than disappearing. Same mechanism the banner
  // uses: select the run, then switch to the pane that hosts the drawer.
  const openRunDetail = useCallback(
    (nodeRunId: string) => {
      setSelectedNodeRunId(nodeRunId)
      navigateTaskTab('workflow-status')
    },
    [navigateTaskTab],
  )

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

  // RFC-222 — admin-only hard delete (type-to-confirm). Gated in the UI by the
  // tasks:delete permission; the server re-checks name + terminality.
  const canDeleteTask = usePermission('tasks:delete')
  const [deleteOpen, setDeleteOpen] = useState(false)
  useEffect(() => {
    if (!canDeleteTask) setDeleteOpen(false)
  }, [canDeleteTask])
  const del = useMutation({
    mutationFn: (confirm: string) => {
      if (!hasPermissionAtRequest(qc, 'tasks:delete')) {
        throw new Error('Task deletion permission is not currently available')
      }
      return api.deleteJson<{ taskId: string }>(`/api/tasks/${encodeURIComponent(id)}`, {
        confirm,
      })
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['tasks'] })
      void navigateTaskRoute({ to: '/tasks' })
    },
  })

  // Compute `hasOutputs` from the optional snapshot so the useEffect can
  // run on every render — including the initial loading render. React's
  // rules-of-hooks forbids calling hooks after a conditional return, so
  // this must sit above the `if (task.isLoading) return ...` guards.
  const hasOutputs =
    task.data === undefined ? false : collectPorts(task.data.workflowSnapshot).length > 0
  // RFC-164 PR-4: workgroup tasks swap the tab set (chat room first, canvas +
  // outputs hidden — the builtin host graph is not an observation surface).
  const isWorkgroup = task.data !== undefined && isWorkgroupTask(task.data)
  // RFC-167 PR-3: dynamic_workflow groups are the exception — no chatroom;
  // the orchestration panel + (post-confirm) the REAL DAG canvas. RFC-198
  // treats this async room aggregate as the classification authority: a
  // workgroup stays pending rather than flashing/canonicalizing turn-engine.
  // RFC-217 T10 (G9): THE single workgroupRoomKey useQuery — WorkgroupRoom and
  // DynamicWorkflowPanel consume it via props. The poll policy is the union of
  // the two former per-component declarations: WS frames carry live updates,
  // the 15s interval is the no-WS fallback, and it only stops once the ROOM
  // AGGREGATE ITSELF has observed the terminal status (the page's faster task
  // query may see `done` first; cutting the poll on that alone would freeze a
  // stale awaiting_confirm gate forever when the WS frame was missed).
  const room = useQuery<WorkgroupRoomResponse>({
    queryKey: workgroupRoomKey(id),
    queryFn: ({ signal }) =>
      api.get(`/api/workgroup-tasks/${encodeURIComponent(id)}/room`, undefined, signal),
    enabled: isWorkgroup,
    refetchInterval: (q) => {
      const status = task.data?.status
      const terminal = status === 'done' || status === 'failed' || status === 'canceled'
      if (terminal && q.state.data?.taskStatus === status) return false
      return 15_000
    },
  })
  const taskQueryBannerKey = `${id}:task-query:${task.dataUpdatedAt}:${bannerErrorSignature(task.error)}`
  const roomErrorBannerKey = `${id}:room-query:${room.dataUpdatedAt}:${bannerErrorSignature(room.error)}`
  const nodeRunsErrorBannerKey = `${id}:node-runs-query:${nodeRuns.dataUpdatedAt}:${bannerErrorSignature(nodeRuns.error)}`
  const isDynamicWorkgroup = isWorkgroup && room.data?.config.mode === 'dynamic_workflow'
  const dwPhase = room.data?.dw?.phase ?? null
  const roomClassification: TaskDetailRoomClassification =
    !isWorkgroup || room.data !== undefined
      ? {
          status: 'ready',
          mode: isDynamicWorkgroup ? 'dynamic-workflow' : 'turn-engine',
          dwPhase,
        }
      : room.error !== null
        ? { status: 'error' }
        : { status: 'pending' }
  // Permission lookup is part of the tab-capability authority.  Treating a
  // failed lookup as an empty permission set would replace a valid `feedback`
  // deep-link with the default tab and make a transient outage look like a
  // durable access decision.  Keep resolution pending until we have data; the
  // rendered error state below preserves the raw URL and offers a retry.
  const permissionsReady =
    actor.status === 'success' && actor.fetchStatus === 'idle' && actor.data !== undefined
  const taskCapabilities =
    task.data === undefined
      ? {
          outputs: false,
          worktreeFiles: false,
          changes: false,
          orchestration: false,
          chatroom: false,
          questions: false,
          feedback: false,
        }
      : deriveTaskDetailCapabilities(task.data, {
          hasOutputs,
          room: roomClassification,
          // The questions GET endpoint inherits the task-view gate and has no
          // additional global permission. Writes remain member-gated server-side.
          canReadQuestions: true,
          canReadFeedback:
            permissionsReady && Array.isArray(actor.data?.permissions)
              ? actor.data.permissions.includes('memory:read')
              : false,
        })
  const tabResolution = resolveTaskDetailTabs({
    taskLoaded: task.data !== undefined,
    capabilitiesReady: permissionsReady,
    hasOutputs,
    capabilities: taskCapabilities,
    isWorkgroup,
    room: roomClassification,
    searchTab: search.tab,
  })
  const tabs = tabResolution.status === 'ready' ? tabResolution.tabs : []
  // During a room error only the universally safe explicit details deep-link
  // is renderable. Other raw searches remain untouched until retry succeeds.
  const tab =
    tabResolution.status === 'ready'
      ? tabResolution.tab
      : tabResolution.status === 'error' && tabResolution.requestedTab === 'details'
        ? 'details'
        : undefined
  const displayedTabs: TaskDetailTab[] =
    tabResolution.status === 'ready' ? tabs : tab === 'details' ? ['details'] : []
  const taskNavigation = deriveTaskDetailNavigation(displayedTabs)
  const canonicalTab =
    tabResolution.status === 'ready' && tabResolution.canonicalize ? tabResolution.tab : null
  useEffect(() => {
    if (canonicalTab !== null) navigateTaskTab(canonicalTab, true)
  }, [canonicalTab, navigateTaskTab])

  // RFC-120: agent nodes of the frozen snapshot — reassign candidates for the
  // task question board (only agent nodes are valid handlers). Labels resolve to
  // the node's display name (title → agentName → id fallback, same oracle as the
  // node-runs table) — the board must show 节点名，不是节点 ID (用户 2026-07-02).
  const agentNodeOptions = useMemo(
    () => agentNodeOptionsFromSnapshot(task.data?.workflowSnapshot),
    [task.data?.workflowSnapshot],
  )

  const diff = useQuery<TaskDiff>({
    queryKey: ['tasks', id, 'diff'],
    queryFn: ({ signal }) =>
      api.get(`/api/tasks/${encodeURIComponent(id)}/diff`, undefined, signal),
    // One oracle owns both navigation and fetching. Multi-repo tasks often
    // have top-level baseCommit=null while repos[] still contain usable shards.
    enabled: tab === 'changes' && taskCapabilities.changes,
    refetchInterval: (q) =>
      isTerminal(task.data?.status) && q.state.data !== undefined ? false : 6000,
    retry: false,
  })
  // RFC-239 (AC-9): node scope is offered for multi-repo tasks too — the
  // backend has supported multi-repo node pairing since RFC-089 P3.
  const effectiveStructScope = structScope

  // RFC-083 — structural (semantic) diff for the task scope. It shares the
  // exact multi-repo capability gate with its navigation leaf and panel.
  const structuralDiff = useQuery<StructuralDiff>({
    queryKey: ['tasks', id, 'structural-diff', effectiveStructScope, engineMode],
    queryFn: ({ signal }) => {
      const params = new URLSearchParams()
      if (effectiveStructScope.startsWith('node:')) {
        params.set('scope', 'node')
        params.set('nodeRunId', effectiveStructScope.slice('node:'.length))
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
    // Only when the changes tab is open: the analysis is expensive (git grep +
    // tree-sitter parse), and the scope <Select> must not mount into the DOM on
    // other tabs (else a page-wide `[role=combobox]` locator grabs it).
    enabled: tab === 'changes' && taskCapabilities.changes,
    refetchInterval: (q) =>
      isTerminal(task.data?.status) && q.state.data !== undefined ? false : 6000,
    retry: false,
  })

  if (task.data === undefined && task.isLoading) {
    return (
      <div className="page page--task-detail">
        <PageHeader title={id} />
        <LoadingState label={t('tasks.loadingTask')} />
      </div>
    )
  }
  if (task.data === undefined && task.error !== null && task.error !== undefined) {
    return (
      <div className="page page--task-detail">
        <PageHeader title={id} />
        <ErrorBanner error={task.error} onRetry={() => void task.refetch()} />
      </div>
    )
  }
  if (task.data === undefined) return null
  if (actor.error !== null && actor.error !== undefined) {
    return (
      <div className="page page--task-detail">
        <PageHeader title={task.data.name} />
        <ErrorBanner error={actor.error} onRetry={() => void actor.refetch()} />
      </div>
    )
  }
  if (tabResolution.status === 'pending') {
    return (
      <div className="page page--task-detail">
        <PageHeader title={task.data.name} />
        {task.error !== null &&
          task.error !== undefined &&
          !dismissedBanners.has(taskQueryBannerKey) && (
            <ErrorBanner
              error={task.error}
              onRetry={() => void task.refetch()}
              onDismiss={() => dismissBanner(taskQueryBannerKey)}
            />
          )}
        <LoadingState label={t('tasks.loadingTask')} />
      </div>
    )
  }

  const tk = task.data
  const questionBadge =
    pendingQuestionCount > 0 ? (
      <span data-testid="tq-section-badge">{pendingQuestionCount}</span>
    ) : undefined
  const taskSectionGroups: PageSectionGroup<TaskDetailTab>[] = taskNavigation.groups.map(
    (group) => ({
      key: group.key,
      label: taskDetailGroupLabel(t, group.key),
      badge:
        group.key === 'collaboration' && pendingQuestionCount > 0 ? (
          <span data-testid="tq-group-badge">{pendingQuestionCount}</span>
        ) : undefined,
      badgeTone:
        group.key === 'collaboration' && pendingQuestionCount > 0 ? 'attention' : undefined,
      items: group.items.map((key) => ({
        key,
        label: tabLabel(t, key),
        badge: key === 'task-questions' ? questionBadge : undefined,
        badgeTone: key === 'task-questions' && pendingQuestionCount > 0 ? 'attention' : undefined,
      })),
    }),
  )
  const nodeRunsConsumerActive =
    tab === 'workflow-status' || tab === 'node-runs' || tab === 'outputs'
  // RFC-202 T3: awaiting_review / awaiting_human are cancelable too (shared
  // lifecycle `cancel` event) — a user who does not want to answer the
  // agent's questions needs an exit besides answering everything.
  const cancelable =
    tk.status === 'pending' ||
    tk.status === 'running' ||
    tk.status === 'awaiting_review' ||
    tk.status === 'awaiting_human'
  const resumability = resumeStatus(tk.status, tk.worktreePath)
  // RFC-164/165: the task's execution subject (workgroup / agent / workflow) —
  // one derivation reused by the header subject link, the meta row and the
  // relaunch/resume deep-links (taskExecutionKind's single-source contract).
  const subjectKind = taskExecutionKind(tk)
  // RFC-164/167: gate the Resume button on the workgroup dispatch mode too — a
  // turn-engine group (lw / fc) 403s `/resume` (builtin __workgroup_host__ anchor),
  // so its recovery is relaunch, not resume. See canOfferResume.
  const showResume = canOfferResume({
    status: tk.status,
    worktreePath: tk.worktreePath,
    isWorkgroup,
    isDynamicWorkgroup,
  })
  // Once the room config confirms turn-engine (mode loaded, not dynamic), surface
  // a relaunch hint in place of the hidden Resume button — gated on room.data so a
  // dynamic group mid-load never flashes the wrong message.
  const showWorkgroupResumeHint =
    resumability === 'ready' && isWorkgroup && room.data !== undefined && !isDynamicWorkgroup
  const resumeUnavailableBannerKey = `${id}:resume-unavailable:${resumability}`
  const workgroupResumeBannerKey = `${id}:workgroup-resume:${room.data?.config.mode ?? 'unknown'}`
  const failedBannerKey = `${id}:failed:${tk.finishedAt ?? 'active'}:${tk.failedNodeId ?? ''}:${tk.errorSummary ?? ''}:${tk.errorMessage ?? ''}`
  const worktreePreservedBannerKey = `${id}:worktree-preserved:${tk.finishedAt ?? 'active'}:${tk.status}:${tk.worktreePath}`

  return (
    <div className="page page--task-detail">
      <PageHeader
        title={
          /* RFC-037: user-supplied display name is the primary heading; the
             ULID drops to muted metadata so it stays copyable without
             dominating the page. */
          <span className="task-detail__title" data-tour="task-status">
            <span className="task-detail__name">{tk.name}</span>{' '}
            <TaskStatusChip status={tk.status} />
          </span>
        }
        meta={
          <>
            <div className="task-detail__id">
              <span className="task-detail__id-label">{t('tasks.detailTitleIdLabel')}</span>{' '}
              <code>{tk.id}</code>
            </div>
            {/* The execution subject stays visible even when the non-default
                details panel is closed. TaskSubjectLink resolves workgroup,
                agent and workflow without exposing builtin host anchors. */}
            <div className="task-detail__workflow">
              <TaskSubjectLink task={tk} taskId={tk.id} badge />
            </div>
            {/* RFC-245: child executions (launched by a parent's call node) get
                a walk-back-up entry. Absent for root tasks — no extra request. */}
            {tk.parentTaskId != null && tk.parentTaskId !== '' && (
              <div className="task-detail__parent">
                <ParentTaskLink taskId={tk.id} parentTaskId={tk.parentTaskId} showName />
              </div>
            )}
          </>
        }
        actions={
          <>
            <TaskMembersDialogButton taskId={id} />
            {/* RFC-175: full-parameter relaunch — terminal tasks deep-link into the
              /tasks/new wizard with ALL launch params pre-filled from THIS task
              (?relaunchFrom=). Suppressed for internal/fusion tasks: their subject
              is a builtin workflow (assertNotBuiltin would 403) — not user
              relaunchable (§5, R4-F1). */}
            {isTerminal(tk.status) && tk.spaceKind !== 'internal' && (
              <Link
                to="/tasks/new"
                search={{ relaunchFrom: tk.id }}
                className="btn"
                data-testid="task-detail-relaunch"
              >
                {t('tasks.relaunchButton')}
              </Link>
            )}
            {showResume && (
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
            {/* RFC-222 — delete only shows for admins on a terminal, non-internal
                task (server enforces the same). */}
            {canDeleteTask && isTerminal(tk.status) && tk.spaceKind !== 'internal' && (
              <button
                type="button"
                className="btn btn--danger"
                onClick={() => setDeleteOpen(true)}
                disabled={del.isPending}
                data-testid="task-detail-delete"
              >
                {t('common.delete')}
              </button>
            )}
          </>
        }
      />
      <ConfirmDialog
        open={canDeleteTask && deleteOpen}
        title={t('common.deleteConfirm.title', { name: tk.name })}
        description={t('common.deleteConfirm.body')}
        confirmLabel={t('common.delete')}
        tone="danger"
        confirmInput={{
          expected: tk.name,
          label: t('common.deleteConfirm.inputLabel', { name: tk.name }),
          placeholder: tk.name,
        }}
        onConfirm={async (ctx) => {
          await del.mutateAsync(ctx?.typedConfirm ?? '')
        }}
        onClose={() => setDeleteOpen(false)}
      />
      <div className="task-detail__banner-stack">
        {task.error !== null &&
          task.error !== undefined &&
          !dismissedBanners.has(taskQueryBannerKey) && (
            <ErrorBanner
              error={task.error}
              onRetry={() => void task.refetch()}
              onDismiss={() => dismissBanner(taskQueryBannerKey)}
            />
          )}
        <StuckTaskBanner key={`stuck:${id}`} taskId={id} />
        <WorkflowSyncBanner key={`workflow-sync:${id}`} taskId={id} />
        {cancel.error !== null && cancel.error !== undefined && (
          <ErrorBanner error={cancel.error} onDismiss={() => cancel.reset()} />
        )}
        {resume.error !== null && resume.error !== undefined && (
          <ErrorBanner error={resume.error} onDismiss={() => resume.reset()} />
        )}
        {resumability === 'worktree-missing' &&
          !dismissedBanners.has(resumeUnavailableBannerKey) && (
            <NoticeBanner
              tone="info"
              size="compact"
              className="info-box--muted"
              action={
                <Link to="/tasks/new" search={{ relaunchFrom: tk.id }} className="btn btn--sm">
                  {t('tasks.resumeLaunchLink')}
                </Link>
              }
              dismiss={{
                label: t('common.close'),
                onDismiss: () => dismissBanner(resumeUnavailableBannerKey),
              }}
            >
              {t('tasks.resumeUnavailableNoWorktree')}
            </NoticeBanner>
          )}
        {showWorkgroupResumeHint && !dismissedBanners.has(workgroupResumeBannerKey) && (
          <NoticeBanner
            tone="info"
            size="compact"
            className="info-box--muted"
            action={
              <Link to="/tasks/new" search={{ relaunchFrom: tk.id }} className="btn btn--sm">
                {t('tasks.resumeLaunchLink')}
              </Link>
            }
            dismiss={{
              label: t('common.close'),
              onDismiss: () => dismissBanner(workgroupResumeBannerKey),
            }}
          >
            {t('tasks.resumeUnavailableWorkgroup')}
          </NoticeBanner>
        )}

        {tk.status === 'failed' &&
          tk.errorSummary !== null &&
          !dismissedBanners.has(failedBannerKey) &&
          (() => {
            // RFC-203 T4: the banner leads with LOCALIZED failure copy
            // (failureCode → summary-token → generic); the raw machine
            // summary/message move into the collapsible details block
            // (audit P1 F-2 — users used to face 'snapshot-lost' verbatim).
            const failure = describeTaskFailure({
              failureCode: tk.failureCode ?? null,
              errorSummary: tk.errorSummary,
              errorMessage: tk.errorMessage,
            })
            return (
              <div className="task-error-banner" role="alert">
                <div className="task-error-banner__body">
                  <div className="task-error-banner__summary" title={tk.errorSummary ?? ''}>
                    <strong>{t('tasks.failedBanner')}</strong> <span>{failure.title}</span>
                  </div>
                  {failure.hint !== undefined && (
                    <div className="task-error-banner__summary muted">{failure.hint}</div>
                  )}
                  <details className="task-error-banner__details">
                    <summary>{t('common.details')}</summary>
                    <pre>
                      {[tk.errorSummary, tk.errorMessage]
                        .filter((x): x is string => x !== null && x !== '')
                        .filter((x, i, arr) => arr.indexOf(x) === i)
                        .join('\n')}
                    </pre>
                  </details>
                </div>
                <div className="task-error-banner__actions">
                  {/* The jump targets the workflow-status canvas; a turn-engine
                    workgroup task has no such tab, so hide it there. */}
                  {tk.failedNodeId !== null &&
                    nodeRuns.data !== undefined &&
                    canOfferFailedJump(tabs) && (
                      <button
                        type="button"
                        className="btn btn--sm btn--danger task-error-banner__jump"
                        title={t('tasks.jumpToFailed', { nodeId: tk.failedNodeId })}
                        onClick={() => {
                          const { runId, tab: next } = nextTabForFailedJump(
                            nodeRuns.data!.runs,
                            tk.failedNodeId,
                          )
                          if (runId !== null) setSelectedNodeRunId(runId)
                          navigateTaskTab(next)
                        }}
                      >
                        {t('tasks.jumpToFailed', { nodeId: tk.failedNodeId })}
                      </button>
                    )}
                  <BannerDismissButton
                    label={t('common.close')}
                    onDismiss={() => dismissBanner(failedBannerKey)}
                    testId="task-failed-banner-dismiss"
                  />
                </div>
              </div>
            )
          })()}

        {(tk.status === 'canceled' || tk.status === 'interrupted') &&
          tk.worktreePath !== '' &&
          !dismissedBanners.has(worktreePreservedBannerKey) && (
            <NoticeBanner
              tone="info"
              size="compact"
              className="info-box--muted"
              dismiss={{
                label: t('common.close'),
                onDismiss: () => dismissBanner(worktreePreservedBannerKey),
              }}
            >
              {t('tasks.worktreePreserved', { path: tk.worktreePath })}
            </NoticeBanner>
          )}

        {/* RFC-108 T21/T23: system-recovery audit + auto-recovery quarantine clear,
            live-polled while the task is active (same idiom as the task/node-runs queries). */}
        <RecoverySection key={`recovery:${id}`} taskId={id} status={tk.status} />

        {tabResolution.status === 'error' && !dismissedBanners.has(roomErrorBannerKey) && (
          <ErrorBanner
            error={room.error}
            action={
              <div className="page__actions">
                {tab !== 'details' && (
                  <button
                    type="button"
                    className="btn btn--sm"
                    onClick={() => navigateTaskTab('details')}
                  >
                    {t('tasks.tabDetails')}
                  </button>
                )}
                <button type="button" className="btn btn--sm" onClick={() => void room.refetch()}>
                  {t('common.retry')}
                </button>
              </div>
            }
            onDismiss={() => dismissBanner(roomErrorBannerKey)}
          />
        )}
      </div>

      <div className="task-detail__workspace">
        {displayedTabs.length > 0 && tab !== undefined && (
          <PageSectionNav<TaskDetailTab>
            groups={taskSectionGroups}
            active={tab}
            presentation="inline"
            inlineLayout="single-row"
            ariaLabel={t('tasks.sectionNavLabel')}
            idPrefix="task-detail"
            renderDestination={(key, destination) => (
              <PageSectionLink
                to="/tasks/$id"
                params={{ id }}
                search={(previous) => withTaskDetailTab(previous, key)}
                className={destination.className}
                pageSectionCurrent={destination.ariaCurrent}
                data-task-detail-section-link={key}
              >
                {destination.children}
              </PageSectionLink>
            )}
            onSelectCompact={(next) => navigateTaskTab(next)}
          />
        )}

        {/* The node-runs aggregate powers three panels. Keep its feedback next
          to the active navigation surface so workflow status and outputs do
          not look like an empty success while the aggregate is loading or
          failed. Cached data remains mounted underneath a stale error. */}
        {nodeRunsConsumerActive && nodeRuns.data === undefined && nodeRuns.isLoading && (
          <LoadingState size="compact" />
        )}
        {nodeRunsConsumerActive &&
          nodeRuns.error !== null &&
          nodeRuns.error !== undefined &&
          !dismissedBanners.has(nodeRunsErrorBannerKey) && (
            <ErrorBanner
              error={nodeRuns.error}
              onRetry={() => void nodeRuns.refetch()}
              onDismiss={() => dismissBanner(nodeRunsErrorBannerKey)}
            />
          )}

        <div className="task-detail__panes">
          {/* RFC-164 PR-4: workgroup chat room — the group task's primary view.
            Content mounts only for TURN-ENGINE workgroup tasks (RFC-167:
            dynamic_workflow groups have no turns/chatroom — they get the
            orchestration section below instead). Capability-inapplicable
            sections do not enter the DOM. */}
          {taskCapabilities.chatroom && (
            <section
              {...taskSectionProps(t, 'chatroom')}
              className="task-detail__pane"
              hidden={tab !== 'chatroom'}
            >
              <WorkgroupRoom taskId={id} taskStatus={tk.status} room={room} />
            </section>
          )}

          {/* RFC-167 PR-3: dynamic-workflow orchestration panel — generation
            progress, the confirm gate (read-only DAG preview) and save-as. */}
          {taskCapabilities.orchestration && (
            <section
              {...taskSectionProps(t, 'dw-orchestration')}
              className="task-detail__pane"
              hidden={tab !== 'dw-orchestration'}
            >
              <DynamicWorkflowPanel
                taskId={id}
                taskStatus={tk.status}
                errorSummary={tk.errorSummary ?? null}
                room={room}
              />
            </section>
          )}

          {/* workflow-status: always mounted while available so xyflow viewport survives section switches.
            RFC-164 PR-4: except for turn-engine workgroup tasks — their tab set
            never reaches this pane and the builtin host graph must not render.
            RFC-167 PR-3: a dynamic task's canvas is REAL once the confirmed DAG
            is swapped in (phase executing); before that the snapshot is still
            the generation host graph — show a waiting hint instead. */}
          {displayedTabs.includes('workflow-status') && (
            <section
              {...taskSectionProps(t, 'workflow-status')}
              className="task-detail__pane"
              hidden={tab !== 'workflow-status'}
            >
              {isDynamicWorkgroup && dwPhase !== 'executing' && (
                <EmptyState size="comfortable" title={t('workgroups.dw.canvasPending')} />
              )}
              {(!isWorkgroup || (isDynamicWorkgroup && dwPhase === 'executing')) && (
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
                      agentId={resolveAgentIdFromSnapshot(
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
              )}
            </section>
          )}

          {displayedTabs.includes('node-runs') && (
            <section
              {...taskSectionProps(t, 'node-runs')}
              className="task-detail__pane"
              hidden={tab !== 'node-runs'}
            >
              {nodeRuns.data !== undefined && (
                <NodeRunsTable
                  taskId={id}
                  runs={nodeRuns.data.runs}
                  workflowSnapshot={tk.workflowSnapshot}
                  // The drawer lives inside the workflow-status pane, so the
                  // entry only exists where that pane does — same guard the
                  // failed-task banner's jump uses.
                  onOpenRunDetail={canOfferFailedJump(displayedTabs) ? openRunDetail : undefined}
                />
              )}
            </section>
          )}

          <section
            {...taskSectionProps(t, 'details')}
            className="task-detail__pane"
            hidden={tab !== 'details'}
          >
            {/* RFC-066: multi-repo summary. Single-repo tasks (repoCount === 1)
              render nothing here — byte-baseline visual against pre-RFC-066.
              Multi-repo shows a collapsible block listing every repo's
              sub-dir name, baseBranch, and (when present) redacted URL. */}
            {/* RFC-248（实现门 P2）：溯源按 `repoGroupName` 判定，**不看仓数**
                ——一个合法的仓库组完全可以只有一个成员，用 `repoCount > 1` 会把
                它的组标记、只读提示、布局整块吞掉。多仓布局块仍按仓数渲染。 */}
            {(tk.repoGroupName ?? '') !== '' && (
              <div className="info-box" data-testid="task-detail-repo-group">
                <StatusChip kind="info" size="sm">
                  {t('tasks.repoGroupChip', { name: tk.repoGroupName })}
                </StatusChip>
              </div>
            )}
            {tk.repos.some((r) => r.readonly && (r.readonlyDirtyCount ?? 0) > 0) && (
              // 只读成员被改动过 ⇒ 那些改动**没有**被提交推送。这条要显眼，
              // 否则用户会以为 agent 的改动丢了是平台的 bug（AC-19）。
              <div
                className="info-box info-box--warn"
                role="alert"
                data-testid="task-detail-readonly-dirty-banner"
              >
                {t('tasks.repoReadonlyDirtyBanner', {
                  mounts: tk.repos
                    .filter((r) => r.readonly && (r.readonlyDirtyCount ?? 0) > 0)
                    .map((r) => (r.mountPath === '' ? '.' : r.mountPath))
                    .join(', '),
                })}
              </div>
            )}
            {(tk.repoCount > 1 || (tk.spaceNodes?.length ?? 0) > 1) && (
              <details className="task-detail__multi-repo" data-testid="task-detail-multi-repo">
                <summary>{t('tasks.multiRepoSummary', { count: tk.repoCount })}</summary>
                {/* RFC-248（实现门 P2）：用**共享**的 `RepoLayoutTree` 渲染，
                    而不是另画一个扁平 <ul>——否则嵌套层级、sparse 子目录、只读
                    标记在这里全看不出来，而组编辑器与组列表里都看得到。
                    冻结的 task_repos 行适配成 PlannedRepo 形状即可。 */}
                <RepoLayoutTree
                  nodes={tk.spaceNodes ?? []}
                  repos={tk.repos.map((r) => ({
                    cachedRepoId: r.cachedRepoId ?? '',
                    repoUrlRedacted: r.repoUrl ?? '',
                    ref: r.baseBranch,
                    subdir: r.subdir,
                    mountPath: r.mountPath,
                    readonly: r.readonly,
                    viaGroups: [],
                  }))}
                  testidPrefix="task-detail-repo-layout"
                />
              </details>
            )}
            <dl className="task-meta">
              {/* The task's execution subject. Subject-aware <dt> label (工作流 /
                工作组 / 代理) + TaskSubjectLink, so a group / single-agent task
                links to its owning resource instead of the internal
                `__workgroup_host__` / `__agent_host__` anchor. The parenthesised
                workflow ULID is kept for plain workflow tasks only. */}
              <dt>
                {subjectKind === 'workgroup'
                  ? t('tasks.workgroupBadge')
                  : subjectKind === 'agent'
                    ? t('tasks.agentBadge')
                    : t('tasks.metaWorkflow')}
              </dt>
              <dd>
                <TaskSubjectLink task={tk} taskId={tk.id} />
                {subjectKind === 'workflow' && tk.workflowName !== null && (
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
                  {/* RFC-203 T4: localized; raw token preserved in title. */}
                  <dd className="task-meta__error" title={tk.errorSummary}>
                    {
                      describeTaskFailure({
                        failureCode: tk.failureCode ?? null,
                        errorSummary: tk.errorSummary,
                        errorMessage: tk.errorMessage,
                      }).title
                    }
                  </dd>
                </>
              )}
            </dl>
          </section>

          {taskCapabilities.outputs && (
            <section
              {...taskSectionProps(t, 'outputs')}
              className="task-detail__pane"
              hidden={tab !== 'outputs'}
            >
              {nodeRuns.data !== undefined && (
                <TaskOutputPanel
                  task={tk}
                  runs={nodeRuns.data.runs}
                  outputs={nodeRuns.data.outputs}
                />
              )}
            </section>
          )}

          {/* RFC-065 — worktree files browser, between outputs and worktree-diff. */}
          {taskCapabilities.worktreeFiles && (
            <section
              {...taskSectionProps(t, 'worktree-files')}
              className="task-detail__pane"
              hidden={tab !== 'worktree-files'}
            >
              <WorktreeFilesPanel taskId={tk.id} />
            </section>
          )}

          {/* RFC-239 — the unified structural-change view (replaces the former
            worktree-diff + worktree-structure panes). Content renders only when
            the tab is active: keeps the analysis lazy and keeps a page-wide
            `[role=combobox]` locator from grabbing the hidden scope picker. */}
          {taskCapabilities.changes && (
            <section
              {...taskSectionProps(t, 'changes')}
              className="task-detail__pane task-detail__pane--changes"
              hidden={tab !== 'changes'}
            >
              {tab !== 'changes' ? null : diff.data !== undefined ? (
                <>
                  {diff.error !== null && diff.error !== undefined && (
                    <ErrorBanner error={diff.error} onRetry={() => void diff.refetch()} />
                  )}
                  <ChangeReviewPanel
                    taskId={tk.id}
                    storageKey={tk.id}
                    diff={diff.data}
                    diffTruncated={diff.data.truncated === true}
                    structural={{
                      data: structuralDiff.data,
                      error: structuralDiff.error,
                      isLoading: structuralDiff.isLoading,
                    }}
                    scopeValue={effectiveStructScope}
                    scopeOptions={[
                      { value: 'task', label: t('tasks.structScopeTask') },
                      ...(nodeRuns.data?.runs ?? []).map((r) => ({
                        value: `node:${r.id}`,
                        label: `${r.nodeId} · ${r.status}`,
                      })),
                    ]}
                    onScopeChange={setStructScope}
                    engineMode={engineMode}
                    onEngineChange={setEngineMode}
                  />
                </>
              ) : diff.isLoading ? (
                <LoadingState size="compact" label={t('tasks.loadingDiff')} />
              ) : diff.error !== null && diff.error !== undefined ? (
                // A GC'd worktree 410s the text diff while the persisted
                // structural artifact may still exist — render from it so the
                // survives-GC guarantee carries into the merged pane.
                <>
                  <ErrorBanner error={diff.error} onRetry={() => void diff.refetch()} />
                  {structuralDiff.data !== undefined && (
                    <ChangeReviewPanel
                      taskId={tk.id}
                      storageKey={tk.id}
                      diff={undefined}
                      diffTruncated={false}
                      structural={{
                        data: structuralDiff.data,
                        error: structuralDiff.error,
                        isLoading: structuralDiff.isLoading,
                      }}
                      scopeValue={effectiveStructScope}
                      scopeOptions={[{ value: 'task', label: t('tasks.structScopeTask') }]}
                      onScopeChange={setStructScope}
                      engineMode={engineMode}
                      onEngineChange={setEngineMode}
                    />
                  )}
                </>
              ) : null}
            </section>
          )}

          {/* RFC-041 PR4: per-task feedback. Originally lived in a fixed
            footer panel below the panes, but a long feedback thread
            squeezed `.task-detail__panes` (flex:1; min-height:0) down to
            zero and hid the task area. Promoting it to its own section keeps
            the run-monitoring panes their full height. */}
          {taskCapabilities.feedback && (
            <section
              {...taskSectionProps(t, 'feedback')}
              className="task-detail__pane"
              hidden={tab !== 'feedback'}
            >
              <TaskFeedbackList taskId={id} />
            </section>
          )}
          {/* RFC-120: task question list / 任务中心 board. */}
          {taskCapabilities.questions && (
            <section
              {...taskSectionProps(t, 'task-questions')}
              className="task-detail__pane"
              hidden={tab !== 'task-questions'}
            >
              <TaskQuestionList
                taskId={id}
                nodeOptions={agentNodeOptions}
                focusTargetNode={focusTargetNode}
              />
            </section>
          )}
        </div>
      </div>
    </div>
  )
}

function taskSectionProps(t: (key: string) => string, tab: TaskDetailTab) {
  return {
    id: `task-detail-section-${tab}`,
    'aria-label': tabLabel(t, tab),
    'data-task-detail-section': tab,
  }
}

function taskDetailGroupLabel(t: (key: string) => string, group: TaskDetailGroup): string {
  switch (group) {
    case 'overview':
      return t('tasks.sectionGroupOverview')
    case 'execution':
      return t('tasks.sectionGroupExecution')
    case 'artifacts':
      return t('tasks.sectionGroupArtifacts')
    case 'collaboration':
      return t('tasks.sectionGroupCollaboration')
  }
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
    case 'changes':
      return t('tasks.tabChanges')
    case 'feedback':
      return t('tasks.tabFeedback')
    case 'task-questions':
      return t('tasks.tabQuestions')
    // RFC-164 PR-4: workgroup chat room.
    case 'chatroom':
      return t('tasks.tabChatroom')
    // RFC-167 PR-3: dynamic-workflow orchestration panel.
    case 'dw-orchestration':
      return t('tasks.tabDwOrchestration')
  }
}

function TaskStatusCanvas({
  canvasRef,
  task,
  runs,
  onSelectNodeRun,
  onJumpToQuestions,
}: {
  // RFC-158: RefObject (not the broader React.Ref) — the onSelect review branch
  // reads `.current` to clearSelection before routing to the review page.
  canvasRef?: React.RefObject<WorkflowCanvasHandle | null>
  task: Task
  runs: NodeRun[]
  onSelectNodeRun: (id: string | null) => void
  // RFC-120 D13: invoked with a node id when a canvas question badge is clicked.
  onJumpToQuestions: (nodeId: string) => void
}) {
  const { t } = useTranslation()
  const navigate = useNavigate()
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

  // RFC-245: call nodes need their identity set before status projection: their
  // status and click target must resolve from the exact same freshest run.
  const callNodeIds = useMemo(() => {
    const ids = new Set<string>()
    for (const n of definition?.nodes ?? [])
      if (n.kind === 'call-workflow' || n.kind === 'call-workgroup') ids.add(n.id)
    return ids
  }, [definition])

  const statuses = useMemo(() => deriveCanvasNodeStatuses(runs, callNodeIds), [callNodeIds, runs])

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

  // RFC-158: review nodes on the canvas open the review page instead of the
  // (near-empty) drawer. `reviewNodeIds` gates the onSelect branch; `reviewNavByNode`
  // holds the click target (or absent when not clickable); `reviewNavs` projects
  // the kinds to WorkflowCanvas so ReviewNode paints the click hint + cursor.
  const reviewNodeIds = useMemo(() => {
    const ids = new Set<string>()
    for (const n of definition?.nodes ?? []) if (n.kind === 'review') ids.add(n.id)
    return ids
  }, [definition])
  const reviewNavByNode = useMemo(() => {
    const m = new Map<string, ReturnType<typeof deriveReviewNodeNav>>()
    for (const nodeId of reviewNodeIds) {
      const nav = deriveReviewNodeNav(runs, nodeId)
      if (nav !== null) m.set(nodeId, nav)
    }
    return m
  }, [reviewNodeIds, runs])
  const reviewNavs = useMemo(() => {
    const out: Record<string, ReviewNodeNavKind> = {}
    for (const [nodeId, nav] of reviewNavByNode) if (nav !== null) out[nodeId] = nav.kind
    return out
  }, [reviewNavByNode])

  // RFC-161: clarify / cross-clarify nodes open the clarify page instead of the
  // (near-empty) drawer — the sister of the review three-piece above.
  const clarifyNodeIds = useMemo(() => {
    const ids = new Set<string>()
    for (const n of definition?.nodes ?? [])
      if (n.kind === 'clarify' || n.kind === 'clarify-cross-agent') ids.add(n.id)
    return ids
  }, [definition])
  const clarifyNavByNode = useMemo(() => {
    const m = new Map<string, ReturnType<typeof deriveClarifyNodeNav>>()
    for (const nodeId of clarifyNodeIds) {
      const nav = deriveClarifyNodeNav(runs, nodeId)
      if (nav !== null) m.set(nodeId, nav)
    }
    return m
  }, [clarifyNodeIds, runs])
  const clarifyNavs = useMemo(() => {
    const out: Record<string, ClarifyNodeNavKind> = {}
    for (const [nodeId, nav] of clarifyNavByNode) if (nav !== null) out[nodeId] = nav.kind
    return out
  }, [clarifyNavByNode])

  // RFC-245: call nodes open the CHILD TASK they launched instead of the drawer
  // — the third instance of the review/clarify three-piece above. `callNodeIds`
  // gates the onSelect branch (and, per design D1, gates it UNCONDITIONALLY: a
  // call node with no reachable child is inert, never a drawer fallback);
  // `callNavByNode` holds the target; `callNavs` projects clickability to the
  // canvas so the card paints the hint + pointer cursor.
  // The ACL-filtered direct-children list decides whether a stamped childTaskId
  // is actually reachable (design D5) — same query key, and therefore the same
  // single fetch, as the drawer/table ChildTaskLink. Enabled only for
  // definitions that HAVE call nodes, so the overwhelming majority of tasks
  // issue no extra request at all (D6); `parentActive` keeps it polling while
  // this task can still spawn a child (D9).
  const children = useTaskChildren(task.id, callNodeIds.size > 0, !isTerminal(task.status))
  const callNavByNode = useMemo(() => {
    const m = new Map<string, string>()
    for (const nodeId of callNodeIds) {
      const nav = deriveCallNodeNav(runs, nodeId)
      if (nav === null) continue
      if (!callNavIsReachable(nav.childTaskId, children.data, children.isError)) continue
      m.set(nodeId, nav.childTaskId)
    }
    return m
  }, [callNodeIds, runs, children.data, children.isError])
  const callNavs = useMemo(() => {
    const out: Record<string, CallNodeNavKind> = {}
    for (const nodeId of callNavByNode.keys()) out[nodeId] = 'child'
    return out
  }, [callNavByNode])

  if (definition === null) {
    return <div className="muted">{t('tasks.noWorkflowSnapshot')}</div>
  }

  return (
    <div className="canvas-frame canvas-frame--task">
      <WorkflowCanvas
        ref={canvasRef}
        surface="task"
        definition={definition}
        agents={agents.data ?? []}
        nodeStatuses={statuses}
        questionCounts={questionCounts}
        onNodeQuestionBadgeClick={onJumpToQuestions}
        clarifyDirectives={directives.data ?? {}}
        onNodeClarifyDirectiveToggle={(nodeId, next) =>
          setDirective.mutate({ nodeId, directive: next })
        }
        reviewNavs={reviewNavs}
        clarifyNavs={clarifyNavs}
        callNavs={callNavs}
        onSelect={(sel) => {
          if (sel === null || sel.kind !== 'node') {
            onSelectNodeRun(null)
            return
          }
          // RFC-158: review nodes never open the drawer — they route to the
          // review page. clearSelection() FIRST releases xyflow's selection
          // (and resets lastEmittedSelectionSig) so a re-click on the same node
          // isn't swallowed (the wedge locked by tasks-detail-drawer-close-reclick);
          // then close any open drawer; then navigate iff the node is clickable.
          if (reviewNodeIds.has(sel.id)) {
            canvasRef?.current?.clearSelection()
            onSelectNodeRun(null)
            const nav = reviewNavByNode.get(sel.id)
            if (nav != null) {
              void navigate({
                to: '/reviews/$nodeRunId',
                params: { nodeRunId: nav.nodeRunId },
                search: {},
              })
            }
            return
          }
          // RFC-161: clarify / cross-clarify nodes never open the drawer — they
          // route to the clarify page (same wedge-guard as the review branch; the
          // clarify route needs no search param — cf. the node-runs table jump link).
          if (clarifyNodeIds.has(sel.id)) {
            canvasRef?.current?.clearSelection()
            onSelectNodeRun(null)
            const nav = clarifyNavByNode.get(sel.id)
            if (nav != null) {
              void navigate({
                to: '/clarify/$nodeRunId',
                params: { nodeRunId: nav.nodeRunId },
              })
            }
            return
          }
          // RFC-245: call nodes never open the drawer either — they route to the
          // CHILD TASK they launched. `clearSelection()` must come FIRST: it is
          // what resets `lastEmittedSelectionSig` (WorkflowCanvas'
          // `clearSelection` handle), without which onNodeClick's same-signature
          // dedupe swallows a second click on the same node. `onSelectNodeRun(null)`
          // then only clears THIS component's drawer state — which matters when
          // the failed-task banner already opened the drawer. Design D1: when the
          // node has no reachable child we still fall through to `return`, never
          // to the drawer.
          if (callNodeIds.has(sel.id)) {
            canvasRef?.current?.clearSelection()
            onSelectNodeRun(null)
            const childTaskId = callNavByNode.get(sel.id)
            if (childTaskId !== undefined) {
              void navigate({ to: '/tasks/$id', params: { id: childTaskId }, search: {} })
            }
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

/**
 * Project node-run state onto the task canvas.
 *
 * Non-call nodes deliberately retain the route's established startedAt picker.
 * RFC-245 call nodes override that projection with the same pure-id, top-level
 * freshness rule used by `deriveCallNodeNav`: a fresh retry placeholder often
 * has no startedAt yet, and showing the older row's colour while navigation has
 * already moved to the new generation would violate A3.
 */
export function deriveCanvasNodeStatuses(
  runs: NodeRun[],
  callNodeIds: ReadonlySet<string> = new Set<string>(),
): Record<string, CanvasNodeData['status']> {
  const latest = new Map<string, NodeRun>()
  for (const r of runs) {
    const prev = latest.get(r.nodeId)
    if (prev === undefined || (r.startedAt ?? 0) >= (prev.startedAt ?? 0)) {
      latest.set(r.nodeId, r)
    }
  }
  const out: Record<string, CanvasNodeData['status']> = {}
  for (const [nodeId, run] of latest) out[nodeId] = canvasStatus(run.status)
  for (const nodeId of callNodeIds) {
    const current = deriveCurrentCallNodeRun(runs, nodeId)
    if (current !== null) out[nodeId] = canvasStatus(current.status)
  }
  return out
}

// RFC-075: synthetic commit&push node id prefix. Container rows carry
// `commitPush` metadata; the message/repair session children share the nodeId
// but have `commitPush == null` (hidden from the table — reachable via the
// container row's "view session" dialog). flag-audit W0：改用 shared 常量
// （原为与 backend 各写一份的裸字面量）。
const COMMIT_PUSH_PREFIX = COMMIT_PUSH_NODE_PREFIX

/** RFC-245: the two RFC-243 call kinds, read off the frozen workflow snapshot.
 *  Exported for the regression test that locks the table entry to call rows. */
export function isCallNodeKind(kind: string | null): boolean {
  return kind === 'call-workflow' || kind === 'call-workgroup'
}

function NodeRunsTable({
  taskId,
  runs,
  workflowSnapshot,
  onOpenRunDetail,
}: {
  taskId: string
  runs: NodeRun[]
  workflowSnapshot: unknown
  /** RFC-245: opens the node drawer for a call row (see `openRunDetail`). */
  onOpenRunDetail?: (nodeRunId: string) => void
}) {
  const { t } = useTranslation()
  if (runs.length === 0) return <div className="muted">{t('tasks.noNodeRuns')}</div>
  // Hide commit-session CHILD rows (kept reachable via the container's dialog).
  const visible = runs.filter(
    (r) => !(r.nodeId.startsWith(COMMIT_PUSH_PREFIX) && r.commitPush == null),
  )
  return (
    <TableViewport label={t('tasks.tabNodeRuns')} minWidth="lg">
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
            const nodeKind = resolveNodeKindFromSnapshot(workflowSnapshot, r.nodeId)
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
                  {/* RFC-243 PR-5: a call node_run links its child execution
                      (+ live status chip; neutral placeholder when the child
                      is deleted/invisible). */}
                  {r.childTaskId != null && (
                    <>
                      {' '}
                      <ChildTaskLink taskId={taskId} childTaskId={r.childTaskId} />
                    </>
                  )}
                  {/* RFC-245: a call node's canvas click now routes to the child
                      task and never opens the drawer, so this row carries the
                      drawer entry (Retry + cascade toggle + attempt history live
                      only there). Call rows only — every other kind still opens
                      its drawer from the canvas. */}
                  {onOpenRunDetail !== undefined &&
                    (isCallNodeKind(nodeKind) || r.childTaskId != null) && (
                      <>
                        {' '}
                        <button
                          type="button"
                          className="btn btn--sm"
                          onClick={() => onOpenRunDetail(r.id)}
                          data-testid={`node-run-detail-${r.id}`}
                        >
                          {t('tasks.runDetailButton')}
                        </button>
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
                  {durationMs === null
                    ? t('common.emDash')
                    : `${Math.round(durationMs / 100) / 10}s`}
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
    </TableViewport>
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
    // RFC-210: without this case the parent-withheld outcome falls into the
    // default below and renders as "skipped: no changes" — the exact opposite of
    // what happened. The switch has a default, so typecheck cannot catch it.
    case 'commit-local-subrepo-failed':
      return 'tasks.commitOutcomeSubrepoFailed'
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
        {/* RFC-210: per-submodule results. Without this the only visible signal
            for a withheld parent is the outcome chip, which says nothing about
            WHICH submodule blocked it. */}
        {cp.subrepos !== undefined && cp.subrepos.length > 0 && (
          <ul className="task-detail__subrepos" data-testid="commit-push-subrepos">
            {cp.subrepos.map((sr) => (
              <li key={sr.path} data-testid={`commit-push-subrepo-${sr.path}`}>
                <code>{sr.path}</code> <ShaRange from={sr.fromSha} to={sr.toSha} />{' '}
                <StatusChip kind={sr.pushed ? 'success' : 'danger'} size="sm">
                  {t(sr.pushed ? 'tasks.subrepoPushed' : 'tasks.subrepoNotPushed')}
                </StatusChip>
                {sr.error !== null && <span className="data-table__muted"> · {sr.error}</span>}
              </li>
            ))}
          </ul>
        )}
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

/**
 * Whether to render the generic Resume button. Composes `resumeStatus` with the
 * workgroup-dispatch gate that mirrors the backend `/api/tasks/:id/resume` guard
 * (`assertTaskWorkflowNotBuiltin`, routes/tasks.ts): a TURN-ENGINE workgroup task
 * (leader_worker / free_collab) is anchored on the builtin `__workgroup_host__`
 * workflow, so the endpoint 403s `builtin-readonly` — its recovery is relaunch /
 * engine re-entry (RFC-164 §4.3/§12), never generic resume. dynamic_workflow
 * groups (RFC-167) and agent / plain-workflow tasks stay resumable.
 *
 * Fail-safe while the room mode is still loading: a workgroup reads as
 * turn-engine (`isDynamicWorkgroup=false`) until the room config arrives, so the
 * button stays hidden until we KNOW it's dynamic — the UI never flashes a button
 * the API would refuse (the exact bug: a failed group showed Resume, click →
 * "workflow is a built-in read-only resource").
 *
 * Exported for unit tests.
 */
export function canOfferResume(input: {
  status: Task['status']
  worktreePath: string
  isWorkgroup: boolean
  isDynamicWorkgroup: boolean
}): boolean {
  if (resumeStatus(input.status, input.worktreePath) !== 'ready') return false
  if (input.isWorkgroup && !input.isDynamicWorkgroup) return false
  return true
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

/** Resolve the immutable agent id frozen into an agent-single snapshot.
 * Legacy name-only snapshots fail closed: mutable display names cannot address
 * the dependency-tree endpoint. Exported for unit tests. */
export function resolveAgentIdFromSnapshot(
  snapshot: unknown,
  nodeId: string | null,
): string | null {
  if (nodeId === null || typeof snapshot !== 'object' || snapshot === null) return null
  const nodes = (snapshot as { nodes?: unknown }).nodes
  if (!Array.isArray(nodes)) return null
  for (const n of nodes) {
    if (typeof n !== 'object' || n === null) continue
    const node = n as { id?: unknown; kind?: unknown; agentId?: unknown }
    if (node.id !== nodeId || node.kind !== 'agent-single') continue
    return typeof node.agentId === 'string' ? node.agentId : null
  }
  return null
}

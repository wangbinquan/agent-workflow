import type {
  LifecycleAlertSeverity,
  NodeRunEventsResponse,
  RepairOptionsResponse,
  RepairResponse,
  ReplaceReviewNodeReviewersBody,
  ReviewNodeReviewerConfig,
  StartTask,
  Task,
  TaskCatalogVisibility,
  TaskDiff,
  TaskListItem,
  TaskMembers,
  TaskNodeRuns,
  TaskStatus,
  TaskSummary,
  UpdateTaskMembersBody,
  WorkflowSyncPreview,
} from '@agent-workflow/shared'

import type { Actor } from '@/auth/actor'

/** Provider-neutral filters accepted by the classic task-list HTTP surface. */
export interface TaskRouteListFilters {
  readonly status?: TaskStatus
  readonly workflowId?: string
  readonly repoPath?: string
  readonly catalogVisibility?: TaskCatalogVisibility
  readonly scheduledTaskId?: string
  readonly topLevelOnly?: boolean
  readonly parentTaskId?: string
  readonly limit?: number
  readonly visibility?: Readonly<{
    actorUserId: string
    scope: 'mine' | 'shared'
  }>
}

export interface TaskRouteLifecycleAlertNotice {
  readonly taskId: string
  readonly rule: string
  readonly severity: LifecycleAlertSeverity
}

export interface TaskRouteDeleteResult {
  readonly taskId: string
  readonly cleanup: 'done' | 'pending'
}

/** Closed TaskExecution command/query face consumed by `/api/tasks`. */
export interface TaskRouteOperations {
  list(filters: TaskRouteListFilters): Promise<readonly TaskSummary[]>
  listItems(filters: TaskRouteListFilters): Promise<readonly TaskListItem[]>
  get(taskId: string): Promise<Task | null>

  assertVisible(actor: Actor, taskId: string): Promise<void>
  requireOperator(actor: Actor, taskId: string): Promise<void>
  assertReplayVisible(actor: Actor, sourceTaskId: string): Promise<void>

  getMembers(actor: Actor, taskId: string): Promise<TaskMembers>
  replaceMembers(actor: Actor, taskId: string, body: UpdateTaskMembersBody): Promise<TaskMembers>

  getReviewers(actor: Actor, taskId: string): Promise<ReviewNodeReviewerConfig>
  replaceReviewers(
    actor: Actor,
    taskId: string,
    body: ReplaceReviewNodeReviewersBody,
  ): Promise<ReviewNodeReviewerConfig>

  launchWorkflow(actor: Actor, task: StartTask): Promise<Task>
  launchMultipart(request: Request, actor: Actor): Promise<Task>
  cancel(taskId: string): Promise<Task>
  delete(taskId: string): Promise<TaskRouteDeleteResult>
  resume(input: { readonly actor: Actor; readonly taskId: string }): Promise<Task>
  retry(input: {
    readonly actor: Actor
    readonly taskId: string
    readonly nodeRunId: string
    readonly cascade: boolean
  }): Promise<Task>

  nodeRuns(taskId: string): Promise<TaskNodeRuns>
  diff(taskId: string): Promise<TaskDiff>
  stdout(taskId: string, nodeRunId: string): Promise<string>
  events(
    taskId: string,
    nodeRunId: string,
    options: Readonly<{ since?: number; limit?: number }>,
  ): Promise<NodeRunEventsResponse>

  assertManualExecutionAllowed(actor: Actor, taskId: string): Promise<void>
  workflowSyncPreview(actor: Actor, taskId: string): Promise<WorkflowSyncPreview>
  syncWorkflow(input: {
    readonly actor: Actor
    readonly taskId: string
    readonly expectedVersion: number
  }): Promise<Task>

  repairOptions(input: {
    readonly actor: Actor
    readonly taskId: string
    readonly alertId: string
  }): Promise<RepairOptionsResponse>
  applyRepair(input: {
    readonly actor: Actor
    readonly taskId: string
    readonly alertId: string
    readonly optionId: string
    readonly onAlert: (row: TaskRouteLifecycleAlertNotice, transition: 'new' | 'promoted') => void
    readonly onResolved: (taskId: string) => void
  }): Promise<RepairResponse>
}

import type {
  NodeRunEventsResponse,
  RepairOptionsResponse,
  RepairResponse,
  ReplaceReviewNodeReviewersBody,
  ReviewNodeReviewerConfig,
  StartTask,
  TaskDiff,
  TaskListItem,
  TaskMembers,
  TaskNodeRuns,
  TaskSummary,
  UpdateTaskMembersBody,
  WorkflowSyncPreview,
} from '@agent-workflow/shared'
import type {
  NodeRunPromptOperations,
  TaskArchivedEventsReader,
  TaskRouteListFilters,
  TaskRouteLifecycleAlertNotice,
  TaskRouteDeleteResult,
} from './types'
import type { TaskWorkgroupConfig } from '../domain/taskWorkgroupConfig'
import type {
  ClarifyDirective,
  FailureCode,
  NodeRunStatus,
  StartAgentTask,
  StartWorkgroupTask,
  Task,
  TaskStatus,
  TriggerContext,
} from '@agent-workflow/shared'
import type { WorkgroupRunSelectionProjection } from '@/platform/runSelectionProjection'
import type { CommittedEventRef } from '@/platform/events/committed/types'
import type {
  AuthenticatedAuthoritySnapshot,
  DirectAuthenticatedAuthority,
} from '@/modules/identity-access/public/participants'

import { parkPreparedHumanGate as parkPreparedHumanGateInternal } from '../composition/humanGate'
import type { SourceTerminationSnapshot } from './types'
import type { TaskSubject } from '../domain/taskSubject'

/** Frozen root-launch provenance shared by routes, schedules and webhooks. */
export type ExecutionInvoker =
  | Readonly<{ type: 'user'; launchKind: 'direct-json' | 'direct-multipart' }>
  | Readonly<{ type: 'scheduled'; scheduledTaskId: string }>
  | Readonly<{
      type: 'node'
      parentTaskId: string
      parentNodeRunId: string
      invocationDepth: number
    }>
  | Readonly<{
      type: 'event'
      eventSubscriptionId: string
      eventDeliveryId: string
      triggerContext: TriggerContext
      sourceTerminationSnapshot?: SourceTerminationSnapshot
    }>
  | Readonly<{
      type: 'webhook'
      webhookTriggerId: string
      webhookFireId: string
      triggerContext: TriggerContext
      sourceTerminationSnapshot?: SourceTerminationSnapshot
    }>

export type {
  InheritableRunConfig,
  SchedulerDriverPort,
  TaskDriveRequest,
  TaskDriveRuntimeOptions,
  TaskExecutionContextRef,
} from '../application/ports/taskExecutionTopology'
export type {
  TaskExecutionResourceAuthority,
  TaskExecutionResourceBinding,
} from '../application/ports/taskExecutionResourceSnapshots'
/** RFC-395 II-a：状态转移的伴随写（按目标表分组），legacy 生命周期 writer 经此取用。 */
export type { NodeRunLifecycleWrite } from '../application/ports/nodeRunWrites'

// RFC-333 temporary legacy-facing command seam. The service bridge supplies
// the required participant; consumers never reach task-execution internals.
export const parkPreparedHumanGate = parkPreparedHumanGateInternal

export { WORKGROUP_TURN_LEADER_NODE_ID } from '@agent-workflow/shared'

export interface WorkgroupTaskRoomTaskSnapshot {
  readonly subject: TaskSubject
  readonly id: string
  readonly name: string
  readonly ownerUserId: string | null
  readonly status: TaskStatus
  readonly workgroupId: string | null
  readonly workgroupConfig: TaskWorkgroupConfig | null
  readonly workflowSnapshot: string
  readonly triggerContextJson: string | null
}

export interface WorkgroupTaskRoomHostRunSnapshot {
  readonly selection: WorkgroupRunSelectionProjection
  readonly seq: number
  readonly id: string
  readonly nodeId: string
  readonly shardKey: string | null
  readonly status: NodeRunStatus
  readonly rerunCause: string | null
  readonly startedAt: number | null
  readonly finishedAt: number | null
  readonly failureCode: FailureCode | null
  readonly agentOverrideName: string | null
  readonly agentOverrideId: string | null
  readonly wgRound: number | null
}

export interface WorkgroupTaskRoomEventIdentity {
  readonly operationRef: string
  readonly eventGroupId: string
  readonly eventGroupOrdinal: number
  readonly correlationRef: string
}

export interface WorkgroupTaskRoomHolderClose {
  readonly rerunCause: 'wg-gate' | 'dw-gate'
  readonly reason: 'wg-gate-approved' | 'wg-gate-rejected' | 'dw-gate-approved' | 'dw-gate-rejected'
}

export interface WorkgroupTaskRoomClarifyProjection {
  readonly askingNodeRunIds: readonly string[]
  readonly stopDirectives: readonly Readonly<{
    nodeId: string
    shardKey: string
    directive: ClarifyDirective
  }>[]
}

/**
 * Collaboration-owned half of the task-room transaction. Implementations are
 * bound to the exact same reserved PostgreSQL transaction as TaskExecution;
 * TaskExecution therefore never reads or mutates clarify/directive tables.
 */
export interface WorkgroupTaskRoomOpenSelfClarifyPark {
  readonly nodeRunId: string
  readonly nodeId: string
  /** Resource Catalog interprets/requeues its own assignment shard. */
  readonly assignmentShardKey: string | null
}

export interface WorkgroupTaskRoomClarifyParticipantInTx {
  loadProjection(taskId: string): Promise<WorkgroupTaskRoomClarifyProjection>
  dismissOpenSelfClarifies(input: {
    readonly taskId: string
    readonly occurredAt: number
  }): Promise<
    Readonly<{
      dismissedSessions: number
      parks: readonly WorkgroupTaskRoomOpenSelfClarifyPark[]
    }>
  >
}

export interface WorkgroupTaskRoomAutonomyDismissalResult {
  readonly dismissedSessions: number
  readonly canceledParkRuns: readonly Readonly<{
    nodeRunId: string
    nodeId: string
  }>[]
  /** RC requeues only these RC-owned assignment shards before committing. */
  readonly assignmentShardKeys: readonly string[]
}

/**
 * TaskExecution's side of one Resource Catalog-owned task-room transaction.
 * The caller may combine these atoms with workgroup messages/assignments/state
 * on the same reserved connection without receiving TaskExecution tables or
 * reimplementing continuation/event minting.
 */
export interface WorkgroupTaskRoomTaskParticipantInTx {
  load(taskId: string): Promise<WorkgroupTaskRoomTaskSnapshot | null>
  loadVisible(
    authority: DirectAuthenticatedAuthority,
    taskId: string,
  ): Promise<WorkgroupTaskRoomTaskSnapshot | null>
  listActive(): Promise<readonly WorkgroupTaskRoomTaskSnapshot[]>
  listVisibleActive(
    authority: DirectAuthenticatedAuthority,
  ): Promise<readonly WorkgroupTaskRoomTaskSnapshot[]>
  loadClarifyProjection(taskId: string): Promise<WorkgroupTaskRoomClarifyProjection>
  listHostRuns(taskId: string): Promise<readonly WorkgroupTaskRoomHostRunSnapshot[]>
  replaceConfig(input: {
    readonly taskId: string
    readonly expectedConfigJson: string
    readonly nextConfigJson: string
    readonly newCollaborators: readonly Readonly<{
      userId: string
      addedBy: string
      addedAt: number
    }>[]
  }): Promise<boolean>
  dismissOpenClarifyParksForAutonomous(input: {
    readonly taskId: string
    readonly occurredAt: number
  }): Promise<WorkgroupTaskRoomAutonomyDismissalResult>
  continueTask(input: {
    readonly taskId: string
    readonly expectedStatus: 'awaiting_human' | 'interrupted' | 'awaiting_review'
    readonly actorUserId: string
    readonly occurredAt: number
    readonly identity: WorkgroupTaskRoomEventIdentity
    readonly closeHolder?: WorkgroupTaskRoomHolderClose
    readonly workflowSnapshot?: string
  }): Promise<Readonly<{
    intentId: string
    closedHolderIds: readonly string[]
    eventRef: CommittedEventRef | null
  }> | null>
  failTask(input: {
    readonly taskId: string
    readonly expectedStatus: 'awaiting_review'
    readonly errorSummary: string
    readonly errorMessage: string
    readonly occurredAt: number
    readonly identity: WorkgroupTaskRoomEventIdentity
    readonly closeHolder?: WorkgroupTaskRoomHolderClose
  }): Promise<Readonly<{
    closedHolderIds: readonly string[]
    eventRef: CommittedEventRef | null
  }> | null>
}

export interface TaskRouteUploadLimits {
  readonly perFile: number
  readonly perRequest: number
  readonly perCount: number
}

export interface TaskRouteMultipartFilePart {
  readonly inputKey: string
  readonly filename: string
  readonly declaredMime: string
  readonly blob: Blob
}

/** TaskExecution-owned launch boundary consumed by the Agent route. */
export interface AgentRouteTaskLaunchOperations {
  uploadLimits(): TaskRouteUploadLimits | Promise<TaskRouteUploadLimits>
  assertReplayVisible(actor: AuthenticatedAuthoritySnapshot, sourceTaskId: string): Promise<void>
  launch(
    actor: AuthenticatedAuthoritySnapshot,
    input: Readonly<{
      agentId: string
      payload: StartAgentTask
      uploads?: Readonly<{
        parts: readonly TaskRouteMultipartFilePart[]
        limits: TaskRouteUploadLimits
      }>
    }>,
  ): Promise<Task>
}

/** TaskExecution-owned launch boundary consumed by the Workgroup route. */
export interface WorkgroupRouteTaskLaunchOperations {
  assertReplayVisible(actor: AuthenticatedAuthoritySnapshot, sourceTaskId: string): Promise<void>
  launch(
    actor: AuthenticatedAuthoritySnapshot,
    input: Readonly<{ workgroupId: string; payload: StartWorkgroupTask }>,
  ): Promise<Task>
}

/** Bootstrap must supply one daemon-scoped driver to every command caller. */

// RFC-434: the archive maintenance command `/api/tasks/archive` calls (defined in application/ports).
export type { TaskArchiveMaintenanceCommand } from '../application/ports/taskArchiveMaintenanceCommand'

// RFC-434: the `/api/tasks` route face, folded in from the former non-exact `public/taskRoutes`.
/** Closed TaskExecution command/query face consumed by `/api/tasks`. */
export interface TaskRouteOperations {
  readonly archivedEvents?: TaskArchivedEventsReader
  readonly nodeRunPrompts: NodeRunPromptOperations
  list(filters: TaskRouteListFilters): Promise<readonly TaskSummary[]>
  listItems(filters: TaskRouteListFilters): Promise<readonly TaskListItem[]>
  get(taskId: string): Promise<Task | null>

  assertVisible(actor: AuthenticatedAuthoritySnapshot, taskId: string): Promise<void>
  requireOperator(actor: AuthenticatedAuthoritySnapshot, taskId: string): Promise<void>
  assertReplayVisible(actor: AuthenticatedAuthoritySnapshot, sourceTaskId: string): Promise<void>

  getMembers(actor: AuthenticatedAuthoritySnapshot, taskId: string): Promise<TaskMembers>
  replaceMembers(
    actor: AuthenticatedAuthoritySnapshot,
    taskId: string,
    body: UpdateTaskMembersBody,
  ): Promise<TaskMembers>

  getReviewers(
    actor: AuthenticatedAuthoritySnapshot,
    taskId: string,
  ): Promise<ReviewNodeReviewerConfig>
  replaceReviewers(
    actor: AuthenticatedAuthoritySnapshot,
    taskId: string,
    body: ReplaceReviewNodeReviewersBody,
  ): Promise<ReviewNodeReviewerConfig>

  launchWorkflow(actor: AuthenticatedAuthoritySnapshot, task: StartTask): Promise<Task>
  launchMultipart(request: Request, actor: AuthenticatedAuthoritySnapshot): Promise<Task>
  cancel(taskId: string): Promise<Task>
  delete(taskId: string): Promise<TaskRouteDeleteResult>
  resume(input: {
    readonly actor: AuthenticatedAuthoritySnapshot
    readonly taskId: string
  }): Promise<Task>
  retry(input: {
    readonly actor: AuthenticatedAuthoritySnapshot
    readonly taskId: string
    readonly nodeRunId: string
    readonly cascade: boolean
  }): Promise<Task>

  nodeRuns(taskId: string): Promise<
    Omit<TaskNodeRuns, 'runs'> & {
      readonly runs: readonly TaskNodeRuns['runs'][number][]
    }
  >
  diff(taskId: string): Promise<TaskDiff>
  stdout(taskId: string, nodeRunId: string): Promise<string>
  events(
    taskId: string,
    nodeRunId: string,
    options: Readonly<{ since?: number; limit?: number }>,
  ): Promise<NodeRunEventsResponse>

  assertManualExecutionAllowed(actor: AuthenticatedAuthoritySnapshot, taskId: string): Promise<void>
  workflowSyncPreview(
    actor: AuthenticatedAuthoritySnapshot,
    taskId: string,
  ): Promise<WorkflowSyncPreview>
  syncWorkflow(input: {
    readonly actor: AuthenticatedAuthoritySnapshot
    readonly taskId: string
    readonly expectedVersion: number
  }): Promise<Task>

  repairOptions(input: {
    readonly actor: AuthenticatedAuthoritySnapshot
    readonly taskId: string
    readonly alertId: string
  }): Promise<RepairOptionsResponse>
  applyRepair(input: {
    readonly actor: AuthenticatedAuthoritySnapshot
    readonly taskId: string
    readonly alertId: string
    readonly optionId: string
    readonly onAlert: (row: TaskRouteLifecycleAlertNotice, transition: 'new' | 'promoted') => void
    readonly onResolved: (taskId: string) => void
  }): Promise<RepairResponse>
}

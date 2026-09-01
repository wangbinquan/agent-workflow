import type {
  Agent,
  ClarifyDirective,
  FailureCode,
  NodeRunStatus,
  StartAgentTask,
  StartWorkgroupTask,
  Task,
  TaskStatus,
  TriggerContext,
} from '@agent-workflow/shared'
import type { NodeRunStatusMutation } from '../application/ports/nodeRunLifecyclePersistence'
import type { CommittedEventRef } from '@/platform/events/committed/types'
import type { Actor } from '@/auth/actor'
import type { DirectAuthenticatedAuthority } from '@/modules/identity-access/public/participants'

import { parkPreparedHumanGate as parkPreparedHumanGateInternal } from '../composition/humanGate'
import type { SchedulerDriverPort } from '../application/ports/taskExecutionTopology'
import type { SourceTerminationSnapshot } from './types'

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
export {
  INHERITABLE_RUN_CONFIG_KEYS,
  pickInheritableRunConfig,
} from '../application/ports/taskExecutionTopology'

export {
  taskDriveSubmission,
  type TaskDriveCompletionMode,
  type TaskDriveCoordinator,
  type TaskDriveReceipt,
  type TaskDriveSubmission,
} from '../application/drive/taskDriveTypes'

// RFC-333 temporary legacy-facing command seam. The service bridge supplies
// the required participant; consumers never reach task-execution internals.
export const parkPreparedHumanGate = parkPreparedHumanGateInternal

/**
 * Closed logging values accepted by the workgroup-turn command.  Keeping this
 * shape here prevents the public command from leaking the daemon Logger or an
 * open `Record<string, unknown>` field bag across bounded contexts.
 */
export type WorkgroupTurnLogFields = Readonly<{
  taskId?: string
  rowId?: string
  runId?: string
  item?: string
  error?: string
  revived?: number
  count?: number
  dismissed?: number
  doneAssignmentCount?: number
}>

export interface WorkgroupTurnLogger {
  debug(message: string, fields?: WorkgroupTurnLogFields): void
  info(message: string, fields?: WorkgroupTurnLogFields): void
  warn(message: string, fields?: WorkgroupTurnLogFields): void
  error(message: string, fields?: WorkgroupTurnLogFields): void
  child(name: string): WorkgroupTurnLogger
}

export interface WorkgroupTurnHostRequest {
  readonly nodeRunId: string
  readonly nodeId: string
  readonly agent: Agent
  readonly promptTemplate: string
  readonly workgroupProtocolBlock?: string
  readonly discardWrites?: boolean
  readonly clarifyEnabled?: boolean
  readonly hostOutputPorts?: readonly string[]
}

export interface WorkgroupTurnHostResult {
  readonly status: 'done' | 'failed' | 'canceled' | 'awaiting'
  readonly outputs: Readonly<Record<string, string>>
  readonly clarifyQuestionCount?: number
  readonly errorMessage?: string
  readonly processUnreaped?: true
  readonly failureCode?: FailureCode
}

export interface WorkgroupTurnHostOperations {
  runHost(request: WorkgroupTurnHostRequest): Promise<WorkgroupTurnHostResult>
  broadcastNodeStatus?(nodeRunId: string, nodeId: string, status: string): void
  getCanonicalFilesChanged?(): Promise<number>
}

export interface WorkgroupTurnsOutcome {
  readonly kind: 'ok' | 'handoff' | 'failed' | 'canceled' | 'awaiting_review' | 'awaiting_human'
  readonly detail?: Readonly<{
    summary: string
    message: string
    nodeId?: string
    processUnreaped?: true
  }>
  readonly processUnreaped?: true
}

/** Exact TaskExecution command consumed by the workgroup-turn driver. */
export interface WorkgroupTurnsOperations {
  drive(input: {
    readonly taskId: string
    readonly log: WorkgroupTurnLogger
    readonly signal?: AbortSignal
    readonly host: WorkgroupTurnHostOperations
  }): Promise<WorkgroupTurnsOutcome>
}

export const WORKGROUP_TURN_LEADER_NODE_ID = '__wg_leader__'
export const WORKGROUP_TURN_MEMBER_NODE_ID = '__wg_member__'

export interface WorkgroupHostLedgerRun {
  readonly id: string
  readonly nodeId: string
  readonly shardKey: string | null
  readonly status: NodeRunStatus
  readonly rerunCause: string | null
  readonly retryIndex: number
  readonly wgRound: number | null
  readonly envelopeNonce: string
}

export interface WorkgroupHostLedgerSnapshot {
  readonly workgroupConfigJson: string | null
  readonly hostRuns: readonly WorkgroupHostLedgerRun[]
  readonly leaderClarifyParked: boolean
}

export interface WorkgroupHostLedgerMintOperation {
  readonly kind: 'mint-host-run'
  readonly operationKey: string
  readonly runId: string
  readonly nodeId: string
  readonly status: 'pending' | 'awaiting_review'
  readonly cause:
    | 'wg-leader-round'
    | 'wg-assignment'
    | 'wg-message-turn'
    | 'wg-protocol-retry'
    | 'wg-gate'
  readonly retryIndex: number
  readonly shardKey: string | null
  readonly agentOverrideName: string | null
  readonly agentOverrideId: string | null
  readonly wgRound: number | null
}

export interface WorkgroupHostLedgerStampOperation {
  readonly kind: 'stamp-host-run-round'
  readonly operationKey: string
  readonly runId: string
  readonly wgRound: number
}

export type WorkgroupHostLedgerOperation =
  | WorkgroupHostLedgerMintOperation
  | WorkgroupHostLedgerStampOperation

export interface WorkgroupHostLedgerMintReceipt {
  readonly operationKey: string
  readonly runId: string
  readonly envelopeNonce: string
}

/**
 * TaskExecution-owned participant bound to one already-reserved transaction.
 * Resource Catalog may combine these host-ledger atoms with its own workgroup
 * ledger writes without receiving TaskExecution tables or mint mechanics.
 */
export interface WorkgroupHostLedgerParticipantInTx {
  load(taskId: string): Promise<WorkgroupHostLedgerSnapshot | null>
  apply(input: {
    readonly taskId: string
    readonly operations: readonly WorkgroupHostLedgerOperation[]
  }): Promise<
    | Readonly<{ committed: true; mintedRuns: readonly WorkgroupHostLedgerMintReceipt[] }>
    | Readonly<{ committed: false; conflictOperationKey: string }>
  >
}

export interface WorkgroupTaskRoomTaskSnapshot {
  readonly id: string
  readonly name: string
  readonly ownerUserId: string | null
  readonly status: TaskStatus
  readonly workgroupId: string | null
  readonly workgroupConfigJson: string | null
  readonly workflowSnapshot: string
  readonly triggerContextJson: string | null
}

export interface WorkgroupTaskRoomHostRunSnapshot {
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

export interface WorkgroupTaskRoomOpenSelfClarifyPark {
  readonly nodeRunId: string
  readonly nodeId: string
  /** Resource Catalog interprets/requeues its own assignment shard. */
  readonly assignmentShardKey: string | null
}

/**
 * Collaboration-owned half of the task-room transaction. Implementations are
 * bound to the exact same reserved PostgreSQL transaction as TaskExecution;
 * TaskExecution therefore never reads or mutates clarify/directive tables.
 */
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

/**
 * TaskExecution-owned node lifecycle CAS bound to a caller-reserved
 * transaction. Collaboration may compose its gate rows in the same commit
 * without importing TaskExecution tables or opening a nested transaction.
 */
export interface NodeRunLifecycleParticipantInTx {
  set(input: {
    readonly nodeRunId: string
    readonly to: NodeRunStatus
    readonly allowedFrom: readonly NodeRunStatus[]
    readonly extra?: NodeRunStatusMutation
    readonly allowTerminal?: boolean
    readonly reason?: string
  }): Promise<{ readonly from: NodeRunStatus; readonly to: NodeRunStatus }>
  completeClarifyNode(input: {
    readonly taskId: string
    readonly nodeRunId: string
    readonly nodeId: string
    readonly expectedStatus: 'awaiting_human'
    readonly status: 'done'
    readonly cause: 'clarify-deferred-answer'
    readonly finishedAt: number
    readonly occurredAt: number
    readonly identity: Readonly<{
      operationRef: string
      eventGroupId: string
      eventGroupOrdinal: number
      correlationRef: string
    }>
  }): Promise<CommittedEventRef | null>
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
  uploadLimits(): TaskRouteUploadLimits
  assertReplayVisible(actor: Actor, sourceTaskId: string): Promise<void>
  launch(
    actor: Actor,
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
  assertReplayVisible(actor: Actor, sourceTaskId: string): Promise<void>
  launch(
    actor: Actor,
    input: Readonly<{ workgroupId: string; payload: StartWorkgroupTask }>,
  ): Promise<Task>
}

/** Root or cascade cancellation with an explicit durable stop cause. */
export interface TaskCancellationCommand {
  cancel(input: {
    readonly taskId: string
    readonly cause:
      | Readonly<{ readonly kind: 'user' }>
      | Readonly<{ readonly kind: 'parent-cascade'; readonly parentTaskId: string }>
  }): Promise<void>
}

/** Bootstrap must supply one daemon-scoped driver to every command caller. */
export function requireSchedulerDriver(
  driver: SchedulerDriverPort | undefined,
): SchedulerDriverPort {
  if (driver === undefined) throw new Error('task-execution-driver-not-composed')
  return driver
}

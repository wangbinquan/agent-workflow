// RFC-303 exact public vocabulary. Cross-context callers may depend on these
// types, never on task rows, activeTasks, scheduler, GC, or process internals.
import type { ClarifyDirective, TaskActorRole, TaskStatus } from '@agent-workflow/shared'
import type { Actor } from '@/auth/actor'

export type { TaskEngineTaskSnapshot } from '../application/ports/taskEngineApplicationPersistence'

export type {
  SourceTerminationFence,
  SourceTerminationSnapshot,
  TaskStopCause,
  TaskStopProjection,
  WebhookTerminalCause,
} from '@/modules/task-execution/domain/sourceTermination'
export { taskStopProjection } from '@/modules/task-execution/domain/sourceTermination'

/** Safe cross-context failure codes; durable owner identities never cross here. */
export type TaskExecutionCommandErrorCode =
  | 'task-continuation-conflict'
  | 'task-continuation-stale'
  | 'task-terminal-maintenance-conflict'
  | 'task-execution-owner-conflict'
  | 'task-execution-resource-conflict'
  | 'task-execution-stale-owner'
  | 'task-execution-recovery-required'
  | 'task-execution-outcome-unknown'
  | 'task-execution-shutting-down'

export type TaskExecutionCommandResult =
  | Readonly<{ ok: true; intentRef: string; idempotent: boolean }>
  | Readonly<{
      ok: false
      code: TaskExecutionCommandErrorCode
      message: string
      winnerIntentRef?: string
    }>

/** Closed transport boundary for the task-scoped clarify directive route. */
export interface TaskClarifyDirectiveRouteOperations {
  resolveAccess(input: { readonly actor: Actor; readonly taskId: string }): Promise<Readonly<{
    readonly workflowSnapshot: string
    readonly actorRole: TaskActorRole | null
  }> | null>
  list(
    taskId: string,
  ): Promise<readonly Readonly<{ readonly nodeId: string; readonly directive: ClarifyDirective }>[]>
  set(input: {
    readonly taskId: string
    readonly nodeId: string
    readonly directive: ClarifyDirective
    readonly setBy: string
    readonly shardKey?: string
  }): Promise<void>
}

export type { TaskScopeOutcome } from '../domain/taskEngine'

export interface TaskStatusProjectionSnapshot {
  readonly taskId: string
  readonly status: TaskStatus
  readonly errorSummary: string | null
}

export interface TaskStatusProjectionReadModel {
  find(taskId: string): Promise<TaskStatusProjectionSnapshot | null>
}

export interface TaskCallGraphWorkspace {
  readonly taskId: string
  readonly worktreePath: string
  readonly repos: readonly {
    readonly worktreeDirName: string
    readonly worktreePath: string
  }[]
}

export interface TaskCallGraphWorkspaceReadModel {
  find(taskId: string): Promise<TaskCallGraphWorkspace | null>
}

/** RFC-340: the frozen review-node catalog exposed to collaboration. */
export interface TaskReviewNodeDescriptor {
  readonly reviewNodeId: string
  readonly title: string
  readonly description: string
}

export interface TaskReviewNodeCatalog {
  readonly taskId: string
  readonly taskOwnerUserId: string | null
  readonly nodes: readonly TaskReviewNodeDescriptor[]
}

export interface TaskReviewNodeCatalogReadModel {
  find(taskId: string): Promise<TaskReviewNodeCatalog | null>
}

/** Minimal gate identity; no task logs, outputs or sibling-node state cross the boundary. */
export interface ReviewGateSubject {
  readonly nodeRunId: string
  readonly taskId: string
  readonly reviewNodeId: string
  readonly taskOwnerUserId: string | null
}

export interface ReviewGateSubjectReadModel {
  find(nodeRunId: string): Promise<ReviewGateSubject | null>
}

export interface TaskStartupVerificationSource {
  readonly taskExists: boolean
  readonly nodeRun: Readonly<{
    taskId: string
    startupVerificationJson: string | null
  }> | null
}

export interface TaskStartupVerificationReadModel {
  find(taskId: string, nodeRunId: string): Promise<TaskStartupVerificationSource>
}

export interface TaskExecutionOutcomeSource {
  readonly task: Readonly<{
    id: string
    status: string
    errorSummary: string | null
    errorMessage: string | null
    failedNodeId: string | null
    workflowSnapshot: string | null
    workgroupId: string | null
    workgroupConfigJson: string | null
    sourceAgentName: string | null
    codeRoundId: string | null
  }>
  readonly runs: readonly Readonly<{
    id: string
    nodeId: string
    iteration: number
    parentNodeRunId: string | null
    status: string
  }>[]
  readonly outputs: readonly Readonly<{
    nodeRunId: string
    portName: string
    content: string
    kind: string | null
    active: boolean
    archiveJson: string | null
  }>[]
  readonly workgroup: Readonly<{
    gateSummary: string | null
    dwPhase: string | null
    resultMessageBody: string | null
  }> | null
}

export interface TaskExecutionOutcomeReadModel {
  find(taskId: string): Promise<TaskExecutionOutcomeSource | null>
}

/**
 * Provider-neutral source row for the runtime inventory presenter. The
 * application service owns JSON decoding and the in-flight filesystem
 * fallback; adapters only freeze the task/run relationship and stored
 * observation columns.
 */
export interface TaskRuntimeInventorySource {
  readonly taskExists: boolean
  readonly workflowSnapshot: string | null
  readonly nodeRun: Readonly<{
    taskId: string
    nodeId: string
    status: string
    runtime: string | null
    runtimeInventoryJson: string | null
    startupVerificationJson: string | null
    inventorySnapshotJson: string | null
  }> | null
}

export interface TaskRuntimeInventoryReadModel {
  find(taskId: string, nodeRunId: string): Promise<TaskRuntimeInventorySource>
}

/** Closed actor projection for the port-artifact HTTP read. Authentication
 * stays transport-owned; the provider adapter receives only the exact task
 * visibility facts it needs. */
export interface TaskPortArtifactActor {
  readonly userId: string
  readonly canReadAllTasks: boolean
}

export interface TaskPortArtifactSource {
  readonly taskId: string
  readonly worktreePath: string
  readonly archiveJson: string | null
  readonly content: string
  readonly kind: string | null
  readonly legacyRepoDirName: string
}

export type TaskPortArtifactLookup =
  | Readonly<{ readonly status: 'task-not-found' }>
  | Readonly<{ readonly status: 'node-run-not-found' }>
  | Readonly<{ readonly status: 'port-not-found' }>
  | Readonly<{ readonly status: 'found'; readonly artifact: TaskPortArtifactSource }>

export interface TaskPortArtifactReadModel {
  find(input: {
    readonly actor: TaskPortArtifactActor
    readonly taskId: string
    readonly nodeRunId: string
    readonly portName: string
  }): Promise<TaskPortArtifactLookup>
}

export interface TaskSessionRunSource {
  readonly id: string
  readonly taskId: string
  readonly nodeId: string
  readonly promptText: string | null
  readonly promptPath: string | null
  readonly startedAt: number | null
  readonly opencodeSessionId: string | null
  readonly retryIndex: number
}

export interface TaskSessionEventSource {
  readonly id: number
  readonly ts: number
  readonly kind: string
  readonly sessionId: string | null
  readonly parentSessionId: string | null
  readonly payload: string
}

export type TaskSessionSourceLookup =
  | Readonly<{ readonly status: 'task-not-found' }>
  | Readonly<{ readonly status: 'node-run-not-found' }>
  | Readonly<{
      readonly status: 'found'
      readonly workflowSnapshot: string
      readonly run: TaskSessionRunSource
      readonly siblings: readonly TaskSessionRunSource[]
      readonly events: readonly TaskSessionEventSource[]
    }>

export interface TaskSessionReadModel {
  find(input: {
    readonly taskId: string
    readonly nodeRunId: string
    readonly rootPrefixCap: number
    readonly tailCap: number
  }): Promise<TaskSessionSourceLookup>
}

export interface TaskExecutionReadModels {
  readonly statusProjection: TaskStatusProjectionReadModel
  readonly callGraphWorkspace: TaskCallGraphWorkspaceReadModel
  readonly taskReviewNodes: TaskReviewNodeCatalogReadModel
  readonly reviewGateSubjects: ReviewGateSubjectReadModel
  readonly startupVerification: TaskStartupVerificationReadModel
  readonly executionOutcome: TaskExecutionOutcomeReadModel
  readonly runtimeInventory: TaskRuntimeInventoryReadModel
  readonly portArtifacts: TaskPortArtifactReadModel
  readonly sessions: TaskSessionReadModel
}

/** Closed wrapper vocabulary exposed to the remaining legacy mechanics. */
export type WrapperExecutionKind = 'wrapper-git' | 'wrapper-loop' | 'wrapper-fanout'

export interface WrapperExecutionScopeSegment {
  readonly wrapperId: string
  readonly kind: WrapperExecutionKind
}

/** Purpose-specific projection: no scope maps or generic domain types cross the public seam. */
export interface WrapperExecutionScope {
  readonly wrapperId: string
  readonly kind: WrapperExecutionKind
  readonly parentScopeId: string | null
  readonly directNodeIds: readonly string[]
  readonly path: readonly WrapperExecutionScopeSegment[]
}

export interface WrapperExecutionScopeReadModel {
  find(wrapperId: string, kind: WrapperExecutionKind): WrapperExecutionScope
}

export { SETTLES_WITHOUT_ROW_KINDS } from '../composition/dagFrontier'

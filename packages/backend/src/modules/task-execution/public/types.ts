import type {
  LifecycleAlertSeverity,
  TaskCatalogVisibility,
  TaskListOrigin,
  TaskStatus,
} from '@agent-workflow/shared'
import type { TaskReadSubject } from '../domain/taskSubject'
import type { TaskWorkgroupConfig } from '../domain/taskWorkgroupConfig'
// RFC-480: the terminal workspace prune policy is a consumer-owned contract that integration implements; it moved here
// from the retired `public/operations` (the registration itself is wired by bootstrap through `composition.ts`).
export type {
  TerminalWorkspacePruneDecision,
  TerminalWorkspacePrunePolicy,
} from '../domain/terminalWorkspacePrune'
export type {
  NodeRunPromptOperations,
  PromptStorage,
} from '../application/ports/nodeRunPromptContent'
export type {
  ArchivePortArtifactsResult,
  PortArtifactArchiveNamespace,
  PortArtifactArchiveRequest,
  PortArtifactOperations,
  PortArtifactReadItem,
  PortArtifactReadRequest,
  PortArtifactWorkspaceFile,
} from '../application/ports/portArtifactContent'
export type { TaskDeletionEffects } from '../application/ports/taskDeletionContentEffects'
export type { TaskRuntimeInventoryContent } from '../application/ports/taskRuntimeInventoryContent'
// RFC-452: the diagnostics surface the tasks route reaches (alerts, recovery audit, diagnose, node-run reads).
export type {
  TaskDiagnostics,
  TaskLifecycleAlertNotices,
} from '../application/ports/taskDiagnostics'
export type { TaskArchiveContentBinding } from '../composition/taskArchiveMaintenance'

// RFC-303 exact public vocabulary. Cross-context callers may depend on these
// types, never on task rows, activeTasks, scheduler, GC, or process internals.

/**
 * RFC-359：human-gate 的四条跃迁边。此前有**两份逐字相同的定义**——`humanGateTaskLifecycleTransaction.ts`
 * （连同一个零实现、零消费者的 `HumanGateTaskLifecycle` 接口，随同步人工门链退役）与 legacy
 * 生命周期层自己那份。现在只有一份，在模块内，legacy 层按 exact public 合同消费它。
 */

export type {
  SourceTerminationFence,
  SourceTerminationSnapshot,
} from '@/modules/task-execution/domain/sourceTermination'

/**
 * RFC-359 W8-A —— 子任务启动的父任务准入判定。两个引擎的铸行事务各自读行、调这一份，
 * 于是同一次子启动在两侧同码同判（判定顺序也定死在 domain 那一份里）。
 * legacy 的通用启动引擎（`services/task.ts`）按 exact public 合同消费它，不穿模块内部。
 */

export type { TaskClarifyDirectiveRouteOperations } from '../application/ports/taskClarifyDirectiveRoutes'

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
    readonly mountPath: string
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
    subjectKind: TaskReadSubject['kind']
    workflowId: string
    id: string
    status: string
    errorSummary: string | null
    errorMessage: string | null
    failedNodeId: string | null
    workflowSnapshot: string | null
    workgroupId: string | null
    workgroupConfig: TaskWorkgroupConfig | null
    sourceAgentName: string | null
    codeRoundId: string | null
  }>
  readonly runs: readonly Readonly<{
    seq: number
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
 * application service owns JSON decoding and consumes selected live evidence;
 * adapters only freeze the task/run relationship and stored
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

export type { ArchivedEventsReader as TaskArchivedEventsReader } from '@/platform/background/eventsArchiveContent'

export type {
  TaskSubjectProjection,
  TaskSubjectQueries,
} from '../application/ports/taskSubjectQueries'
// RFC-482 — the run selection reads collaboration takes through its participant bindings (a closed interface).
export type { TaskRunSelectionReads } from '../application/ports/runSelection'
export type { TaskDefinitionSubject, TaskSubject, TaskReadSubject } from '../domain/taskSubject'

export type { TaskRepositoryCheckpoint } from '../domain/taskCheckpoint'
export type { TaskRollbackCheckpointRun } from '../domain/taskCheckpointRollback'

export type {
  TaskWorkgroupConfig,
  TaskWorkgroupLaunchConfig,
  TaskWorkgroupRuntimeConfig,
} from '../domain/taskWorkgroupConfig'

export type { DerivedNodeRunRole, NodeRunRole, NodeRunSyntheticKind } from '../domain/nodeRunRole'
export type {
  NodeRunConfigView,
  NodeRunIdentitySnapshot,
  NodeRunInputView,
  NodeRunResultView,
  NodeRunRuntimeStateView,
} from '../domain/nodeRunSnapshot'

export type {
  CodeNodeRunSnapshot,
  CodeWorkspaceTask,
  TaskCodeWorkspaceQueries,
} from '../application/ports/taskCodeWorkspaceQueries'
// RFC-477: `TaskResourceLimitFacts` left public with the resource-limit policy it served (now task-execution application).
export type { TaskStatusCountQueries } from '../application/ports/taskStatusCounts'

// RFC-481 — the human-gate ports Task Execution requires and collaboration implements (moved here from collaboration, which
// now takes them from this entry: task-execution does not import collaboration).
export type { PreparedHumanGateRef } from '../domain/humanGateContinuation'
export type {
  CollaborationAutonomousDismissalInput,
  CollaborationAutonomousDismissalResult,
  CollaborationClarifySuppressionInput,
  CollaborationRuntimeMechanics,
} from '../application/ports/collaborationRuntimeMechanics'
export type {
  TaskDagCollaborationOperations,
  TaskDagOpenClarifyEvidence,
} from '../application/ports/taskDagCollaborationOperations'

export { nodeRunMintIdentityForSlot } from '../application/nodeRunMintIdentity'
export type { NodeRunMintGeneration } from '../application/nodeRunMintIdentity'

// RFC-434: the `/api/tasks` route face, folded in from the former non-exact `public/taskRoutes`.
/** Provider-neutral filters accepted by the classic task-list HTTP surface. */
export interface TaskRouteListFilters {
  readonly status?: TaskStatus
  readonly workflowId?: string
  readonly repoPath?: string
  readonly catalogVisibility?: TaskCatalogVisibility
  readonly scheduledTaskId?: string
  /**
   * RFC-301 launch-origin filter. Applied in SQL against `tasks.launch_origin`
   * through `taskListOriginMatches`, NOT re-derived from `scheduledTaskId` —
   * that guess cannot see `event` / `api` at all and misreads a manual re-run
   * of a scheduled definition as `scheduled`.
   */
  readonly origin?: TaskListOrigin
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

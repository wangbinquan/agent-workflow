import type { TaskWorkgroupConfig } from '../../domain/taskWorkgroupConfig'
import { type RunLineageView, type TaskStatus } from '@agent-workflow/shared'
import type { TaskSubject } from '../../domain/taskSubject'

export type TaskRecoveryEventKind =
  | 'boot-reap'
  | 'periodic-reap'
  | 'shutdown-flip'
  | 'limit-cancel'
  | 'snapshot-lost'
  | 'live-child-survived'
  | 'auto-resume'
  | 'auto-repair'
  | 'heartbeat-kill'
  // RFC-350：不活跃超时收割（僵尸任务）。
  | 'idle-timeout-reap'
  | 'quarantine'
  | 'restore'
  | 'pre-migration'
  | 'worktree-skip'

export interface TaskRecoveryEventRecord {
  readonly id: string
  readonly taskId: string | null
  readonly nodeRunId: string | null
  readonly actor: string
  readonly kind: string
  readonly reason: string | null
  readonly beforeJson: string | null
  readonly afterJson: string | null
  readonly createdAt: number
}

export interface RecordTaskRecoveryEventInput {
  readonly id: string
  readonly taskId: string | null
  readonly nodeRunId: string | null
  readonly actor: string
  readonly kind: TaskRecoveryEventKind
  readonly reason: string | null
  readonly beforeJson: string | null
  readonly afterJson: string | null
  readonly createdAt: number
}

export interface TaskRecoveryBreakerConfig {
  readonly maxPerWindow: number
  readonly windowMs: number
}

export interface TaskLifecycleAlertRecord {
  readonly id: string
  readonly taskId: string
  readonly rule: string
  readonly severity: string
  readonly detail: string
  readonly detectedAt: number
}

export interface TaskRecoveryRunRecord {
  readonly id: string
  readonly taskId: string
  readonly nodeId: string
  readonly status: string
  readonly pid: number | null
  readonly startedAt: number | null
  readonly spawnBinaryPath: string | null
  readonly spawnLaunchNonce: string | null
  readonly parentNodeRunId: string | null
  readonly childTaskId: string | null
  /** RFC-354 — the generation row the run hangs off (null = top scope). */
  readonly containerRunId?: string | null
  readonly lastEventTs?: number | null
}

export interface TaskRecoveryBootTaskRecord {
  readonly id: string
  readonly status: 'running' | 'pending'
}

export interface TaskRecoveryBootSnapshot {
  readonly tasks: readonly TaskRecoveryBootTaskRecord[]
  readonly runs: readonly TaskRecoveryRunRecord[]
  readonly heldLeaseRunIds: readonly string[]
  readonly heldLeaseRuns: readonly TaskRecoveryRunRecord[]
}

export interface TaskRecoveryAutoResumeCandidate {
  readonly id: string
  readonly workgroupId: string | null
  readonly workgroupConfig: TaskWorkgroupConfig | null
  readonly worktreePath: string
  readonly workspacePruningAt: number | null
  readonly workspacePrunedAt: number | null
}

export interface TaskRecoveryPeriodicSnapshot {
  readonly workflowSnapshot: string | null
  readonly runs: readonly TaskRecoveryRunRecord[]
  readonly childTaskStatuses: Readonly<Record<string, TaskStatus>>
}

export interface TaskRecoveryStuckRunSnapshot {
  readonly id: string
  readonly nodeId: string
  readonly status: string
  readonly pid: number | null
  readonly childTaskId: string | null
  readonly lastEventTs: number | null
  readonly child: {
    readonly status: string
    readonly startedAt: number
    readonly lastEventTs: number | null
  } | null
}

export interface TaskRecoveryStuckTaskSnapshot {
  readonly subject: TaskSubject
  readonly taskId: string
  readonly parentTaskId: string | null
  readonly status: string
  readonly startedAt: number
  readonly ownerUserId: string | null
  readonly workgroupId: string | null
  readonly worktreePath: string
  readonly workspacePruningAt: number | null
  readonly workspacePrunedAt: number | null
  readonly hasRepoPrepRow: boolean
  readonly latestEventTs: number | null
  readonly hasPendingDocVersion: boolean
  readonly hasOpenClarifySession: boolean
  readonly hasUndispatchedDesignerQuestions: boolean
  readonly hasNoActiveHumanMember: boolean
  readonly workflowSnapshot: string
  readonly runs: readonly TaskRecoveryStuckRunSnapshot[]
}

export interface TaskLifecycleAlertFindingRecord {
  readonly taskId: string
  readonly rule: string
  readonly detail: Readonly<Record<string, unknown>>
}

export interface TaskLifecycleAlertProjection {
  readonly id: string
  readonly taskId: string
  readonly rule: string
  readonly severity: 'warning' | 'error'
  readonly detail: Readonly<Record<string, unknown>>
  readonly detectedAt: number
  readonly resolvedAt: null
}

export interface TaskLifecycleAlertReconciliation {
  readonly newAlerts: number
  readonly promotedAlerts: number
  readonly resolvedAlerts: number
  readonly openAlerts: readonly TaskLifecycleAlertProjection[]
  readonly transitions: readonly {
    readonly row: TaskLifecycleAlertProjection
    readonly kind: 'new' | 'promoted'
  }[]
  readonly resolvedTaskIds: readonly string[]
}

export type TaskLifecycleInvariantScope =
  | { readonly taskId: string }
  | { readonly since: number }
  | { readonly all: true }

export interface TaskLifecycleInvariantSnapshot {
  readonly taskId: string
  readonly taskStatus: string
  readonly workflowSnapshot: string
  readonly hasUndispatchedDesignerQuestions: boolean
  readonly documentVersions: readonly {
    readonly id: string
    readonly reviewNodeRunId: string
    readonly reviewNodeId: string
    readonly versionIndex: number
    readonly decision: string | null
  }[]
  readonly clarifyRounds: readonly {
    readonly id: string
    readonly kind: string
    readonly status: string
    readonly clarifyNodeRunId: string
    readonly clarifyNodeId: string
  }[]
  readonly nodeRuns: readonly {
    readonly seq: number
    readonly id: string
    readonly nodeId: string
    readonly status: string
    readonly parentNodeRunId: string | null
    readonly reviewIteration: number
    readonly shardKey: string | null
  }[]
}

export interface TaskRecoveryQuestionParkEntry {
  readonly dispatchedAt: number | null
  readonly triggerRunId: string | null
  readonly defaultTargetNodeId: string | null
  readonly overrideTargetNodeId: string | null
}

export interface TaskRecoveryQuestionRunLineage extends RunLineageView {
  readonly shardKey: string | null
}

/**
 * Closed recovery/maintenance persistence owned by Task Execution.  The
 * application sees exact recovery decisions and projections; provider rows,
 * SQL expressions and transaction handles remain in infrastructure.
 */
export interface TaskRecoveryOperations {
  recordEvent(input: RecordTaskRecoveryEventInput): Promise<void>
  listEventsForTask(taskId: string, limit: number): Promise<readonly TaskRecoveryEventRecord[]>

  isAutoRecoverySuspended(taskId: string): Promise<boolean>
  recordAutoRecoveryAttempt(input: {
    readonly taskId: string
    readonly config: TaskRecoveryBreakerConfig
    readonly now: number
  }): Promise<{ readonly suspended: boolean; readonly attempts: number }>
  clearAutoRecoverySuspension(taskId: string): Promise<void>

  listOpenLifecycleAlerts(taskId?: string): Promise<readonly TaskLifecycleAlertRecord[]>
  taskIdsWithRepoPrepRow(taskIds: readonly string[]): Promise<ReadonlySet<string>>

  listStalledRunningChildren(input: {
    readonly stallMs: number
    readonly now: number
    readonly eventWindowRows: number
  }): Promise<readonly TaskRecoveryRunRecord[]>
  listAutoResumeCandidates(): Promise<readonly TaskRecoveryAutoResumeCandidate[]>

  loadBootOrphanSnapshot(): Promise<TaskRecoveryBootSnapshot>
  interruptBootOrphanTask(input: {
    readonly taskId: string
    readonly from: 'running' | 'pending'
    readonly now: number
    readonly failureCode: string
    readonly errorMessage: string
  }): Promise<boolean>
  interruptNodeRun(input: {
    readonly nodeRunId: string
    readonly now: number
    readonly errorMessage?: string
  }): Promise<boolean>

  listPeriodicReconcileCandidates(startedBefore: number): Promise<readonly TaskRecoveryRunRecord[]>
  loadPeriodicReconcileSnapshot(taskId: string): Promise<TaskRecoveryPeriodicSnapshot | null>
  findHeldRuntimeSessionId(nodeRunId: string): Promise<string | null>
  repairRuntimeSessionLeaseAfterOrphanReap(nodeRunId: string): Promise<number>
  interruptPeriodicTaskIfIdle(input: {
    readonly taskId: string
    readonly now: number
    readonly failureCode: string
  }): Promise<boolean>

  loadStuckTaskSnapshots(
    taskIdFilter?: readonly string[],
  ): Promise<readonly TaskRecoveryStuckTaskSnapshot[]>
  loadLifecycleInvariantSnapshots(
    scope: TaskLifecycleInvariantScope,
  ): Promise<readonly TaskLifecycleInvariantSnapshot[]>
  reconcileStuckAlerts(input: {
    readonly taskIds: readonly string[]
    readonly findings: readonly TaskLifecycleAlertFindingRecord[]
    readonly ownedRules: readonly string[]
    readonly now: number
    readonly promotionAfterMs: number
  }): Promise<TaskLifecycleAlertReconciliation>
}

/** Boot orphan reaping needs only these operations. */
export type TaskBootOrphanOperations = Pick<
  TaskRecoveryOperations,
  'loadBootOrphanSnapshot' | 'interruptBootOrphanTask' | 'interruptNodeRun' | 'recordEvent'
>

/** Periodic orphan reconciliation needs only these operations. */
export type TaskPeriodicRecoveryOperations = Pick<
  TaskRecoveryOperations,
  | 'listPeriodicReconcileCandidates'
  | 'loadPeriodicReconcileSnapshot'
  | 'findHeldRuntimeSessionId'
  | 'interruptNodeRun'
  | 'repairRuntimeSessionLeaseAfterOrphanReap'
  | 'interruptPeriodicTaskIfIdle'
  | 'recordEvent'
>

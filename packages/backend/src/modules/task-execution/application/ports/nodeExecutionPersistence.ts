import type { MergeStateOrNull, NodeRunStatus, RerunCause } from '@agent-workflow/shared'

import type { TaskExecutionContextRef } from './taskExecutionTopology'

/**
 * Provider-neutral node-run projection consumed by the scheduler.  It is a
 * domain snapshot, not a Drizzle row: adapters deliberately copy the storage
 * record before it crosses the application seam.
 */
export interface NodeExecutionSnapshot {
  readonly id: string
  readonly taskId: string
  readonly nodeId: string
  readonly parentNodeRunId: string | null
  readonly iteration: number
  readonly shardKey: string | null
  readonly retryIndex: number
  readonly wgRound: number | null
  readonly reviewIteration: number
  readonly status: NodeRunStatus
  readonly startedAt: number | null
  readonly finishedAt: number | null
  readonly pid: number | null
  readonly spawnBinaryPath: string | null
  readonly spawnLaunchNonce: string | null
  readonly exitCode: number | null
  readonly errorMessage: string | null
  readonly failureCode: string | null
  readonly promptText: string | null
  readonly promptPath: string | null
  readonly envelopeNonce: string | null
  readonly forceActivated: boolean
  readonly tokInput: number | null
  readonly tokOutput: number | null
  readonly tokCacheCreate: number | null
  readonly tokCacheRead: number | null
  readonly tokTotal: number | null
  readonly preSnapshot: string | null
  readonly opencodeSessionId: string | null
  readonly runtime: string | null
  readonly runtimeBinary: string | null
  readonly runtimeParamsJson: string | null
  readonly inventorySnapshotJson: string | null
  readonly runtimeInventoryJson: string | null
  readonly startupVerificationJson: string | null
  readonly wrapperProgressJson: string | null
  readonly injectedMemoriesJson: string | null
  readonly portValidationFailuresJson: string | null
  readonly commitPushJson: string | null
  readonly preSnapshotReposJson: string | null
  readonly isoWorktreePath: string | null
  readonly isoBaseSnapshot: string | null
  readonly isoBaseSnapshotReposJson: string | null
  readonly isoNodeTree: string | null
  readonly isoNodeTreeReposJson: string | null
  readonly isoSubmodulesJson: string | null
  readonly isoSubmodulesReposJson: string | null
  readonly mergeState: MergeStateOrNull
  readonly consumedUpstreamRunsJson: string | null
  readonly shardValueHash: string | null
  readonly rerunCause: RerunCause | null
  readonly supersededByReview: string | null
  readonly rolledBack: boolean | null
  readonly agentOverrideName: string | null
  readonly agentOverrideId: string | null
  readonly childTaskId: string | null
  readonly continuationSlotKey: string | null
  readonly lineageSlotPathJson: string | null
  readonly operationGeneration: number
}

export interface NodeExecutionOutputSnapshot {
  readonly nodeRunId: string
  readonly portName: string
  readonly content: string
  readonly kind: string | null
  readonly archiveJson: string | null
  readonly active: boolean
}

export interface NodeExecutionEventSnapshot {
  readonly id: number
  readonly nodeRunId: string
  readonly ts: number
  readonly kind:
    | 'tool_use'
    | 'text'
    | 'reasoning'
    | 'permission_asked'
    | 'error'
    | 'step_start'
    | 'step_finish'
    | 'stderr'
    | 'subagent_capture_failed'
  readonly payload: string
  readonly sessionId: string | null
  readonly parentSessionId: string | null
}

export type NodeExecutionEventWrite = Omit<
  NodeExecutionEventSnapshot,
  'id' | 'nodeRunId' | 'sessionId' | 'parentSessionId'
> & {
  readonly sessionId?: string | null
  readonly parentSessionId?: string | null
}

export interface NodeExecutionQuery {
  readonly taskId: string
  readonly nodeId?: string
  readonly iteration?: number
  readonly status?: NodeRunStatus
  readonly mergeState?: MergeStateOrNull
  readonly parentNodeRunId?: string | null
  /** Restrict to wrapper/fanout children without selecting one generation. */
  readonly childOnly?: boolean
}

export type NodeExecutionProjectionPatch = Partial<
  Pick<
    NodeExecutionSnapshot,
    | 'childTaskId'
    | 'commitPushJson'
    | 'consumedUpstreamRunsJson'
    | 'envelopeNonce'
    | 'errorMessage'
    | 'failureCode'
    | 'finishedAt'
    | 'injectedMemoriesJson'
    | 'inventorySnapshotJson'
    | 'isoBaseSnapshot'
    | 'isoBaseSnapshotReposJson'
    | 'isoNodeTree'
    | 'isoNodeTreeReposJson'
    | 'isoSubmodulesJson'
    | 'isoSubmodulesReposJson'
    | 'isoWorktreePath'
    | 'mergeState'
    | 'opencodeSessionId'
    | 'pid'
    | 'portValidationFailuresJson'
    | 'preSnapshot'
    | 'preSnapshotReposJson'
    | 'promptPath'
    | 'promptText'
    | 'rolledBack'
    | 'runtime'
    | 'runtimeBinary'
    | 'runtimeInventoryJson'
    | 'runtimeParamsJson'
    | 'shardValueHash'
    | 'spawnBinaryPath'
    | 'spawnLaunchNonce'
    | 'startedAt'
    | 'startupVerificationJson'
    | 'tokCacheCreate'
    | 'tokCacheRead'
    | 'tokInput'
    | 'tokOutput'
    | 'tokTotal'
    | 'wrapperProgressJson'
  >
>

export interface NodeExecutionOutputWrite {
  readonly portName: string
  readonly content: string
  readonly kind?: string | null
  readonly archiveJson?: string | null
  readonly active?: boolean
}

/**
 * Scheduler-owned read/projection port.  Lifecycle state transitions stay on
 * NodeRunLifecyclePersistence; this port owns non-lifecycle projection data,
 * outputs and the append-only runtime event stream.
 */
export interface NodeExecutionPersistence {
  read(nodeRunId: string): Promise<NodeExecutionSnapshot | null>
  list(input: NodeExecutionQuery): Promise<readonly NodeExecutionSnapshot[]>
  listOutputs(nodeRunId: string): Promise<readonly NodeExecutionOutputSnapshot[]>
  countAgentTextEvents(nodeRunId: string, frameworkPrefix: string): Promise<number>
  readStderr(nodeRunId: string): Promise<string>
  patch(input: {
    readonly nodeRunId: string
    readonly values: NodeExecutionProjectionPatch
    readonly executionContext?: TaskExecutionContextRef
    readonly now?: number
  }): Promise<boolean>
  upsertOutputs(input: {
    readonly nodeRunId: string
    readonly outputs: readonly NodeExecutionOutputWrite[]
    readonly executionContext?: TaskExecutionContextRef
    readonly now?: number
  }): Promise<void>
  replaceOutputs(input: {
    readonly nodeRunId: string
    readonly outputs: readonly NodeExecutionOutputWrite[]
    readonly executionContext?: TaskExecutionContextRef
    readonly now?: number
  }): Promise<void>
  appendEvent(input: {
    readonly nodeRunId: string
    readonly ts: number
    readonly kind: NodeExecutionEventSnapshot['kind']
    readonly payload: string
    readonly sessionId?: string | null
    readonly parentSessionId?: string | null
    readonly executionContext?: TaskExecutionContextRef
  }): Promise<void>
  /** Persist one stream chunk atomically. The runner keeps stdout/stderr
   * batching at this provider-neutral boundary instead of issuing one
   * transaction per decoded line. */
  appendEvents(input: {
    readonly nodeRunId: string
    readonly events: readonly NodeExecutionEventWrite[]
    readonly executionContext?: TaskExecutionContextRef
  }): Promise<void>
  /** Collapse native-session reset epochs onto the final logical session id. */
  retagSessionEpochs(input: {
    readonly nodeRunId: string
    readonly supersededSessionIds: readonly string[]
    readonly logicalSessionId: string
    readonly executionContext?: TaskExecutionContextRef
    readonly now?: number
  }): Promise<void>
}

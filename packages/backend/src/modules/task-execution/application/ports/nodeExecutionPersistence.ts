import type { MergeStateOrNull, NodeRunStatus } from '@agent-workflow/shared'

import type {
  NodeRunIdentitySnapshot,
  NodeRunConfigView,
  NodeRunRuntimeStateView,
  NodeRunResultView,
  NodeRunCheckpointView,
  NodeRunInputView,
} from '../../domain/nodeRunSnapshot'
import type { SelectionChange } from './runSelection'
import type { NodeRunProjectionWrite } from './nodeRunWrites'
import type { TaskExecutionContextRef } from './taskExecutionTopology'

/**
 * Provider-neutral node-run projection consumed by the scheduler.  It is a
 * domain snapshot, not a Drizzle row: adapters deliberately copy the storage
 * record before it crosses the application seam.
 */
export interface NodeExecutionSnapshot
  extends
    NodeRunIdentitySnapshot,
    NodeRunConfigView,
    NodeRunRuntimeStateView,
    NodeRunResultView,
    NodeRunCheckpointView,
    NodeRunInputView {
  /** II-a 既有选择端口的尝试编号别名；由适配器与 attemptIndex 同源投影。 */
  readonly retryIndex: number
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
  readonly sourceKey?: string
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
  /** RFC-354 — restrict to one frame: null = the top scope, an id = that generation's body. */
  readonly containerRunId?: string | null
  /**
   * RFC-369 —— 排除已被同帧更新一代结构性取代的行（判据见 `domain/nodeRunSupersession.ts`）。
   * 入口重放必须带上：旧代作废不再在铸造时落 abandoned，而是由读侧推导。
   */
  readonly excludeSuperseded?: boolean
}

export type NodeExecutionProjectionPatch = NodeRunProjectionWrite

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
    readonly selection?: SelectionChange
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

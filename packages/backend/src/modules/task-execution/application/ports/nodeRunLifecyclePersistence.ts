import type { RecordedNodeRunInput } from '../../domain/consumedInputs'
import type { RunSlot } from './runSelection'
import type { NodeRunMintGeneration } from '../nodeRunMintIdentity'
import type { SelectionChange } from './runSelection'
import type { NodeRunRole, NodeRunSyntheticKind } from '../../domain/nodeRunRole'
import type { NodeRunLifecycleWrite, NodeRunMintWrite } from './nodeRunWrites'
import type { TaskRepositoryCheckpoint } from '../../domain/taskCheckpoint'
import type { NodeRunStatus, NodeRunTransitionEvent, RerunCause } from '@agent-workflow/shared'

import type { CommittedEventRef } from '@/platform/events/committed/types'

import type { NodeExecutionOutputWrite } from './nodeExecutionPersistence'
import type { TaskExecutionContextRef } from './taskExecutionTopology'

export type NodeRunStatusMutation = NodeRunLifecycleWrite

export interface NodeRunMintInheritance {
  readonly reviewIteration: number
  readonly shardKey: string | null
  readonly parentNodeRunId: string | null
  /** RFC-354 — a rerun / placeholder stays in the frame of the row it is minted from. */
  readonly containerRunId?: string | null
  readonly checkpointInheritance: readonly TaskRepositoryCheckpoint[]
  readonly continuationSlotKey?: string | null
  readonly lineageSlotPathJson?: string | null
  readonly operationGeneration?: number
}

export type NodeRunMintOverrides = NodeRunMintWrite

export interface NodeRunMintInput {
  readonly slot: RunSlot
  readonly envelopeNonce: string
  readonly executionGeneration: NodeRunMintGeneration
  readonly role: NodeRunRole
  readonly syntheticKind: NodeRunSyntheticKind | null
  readonly id?: string
  readonly taskId: string
  readonly nodeId: string
  /**
   * Statuses a row may be BORN with. Everything else (canceled / interrupted /
   * skipped / exhausted) is only reachable via lifecycle transitions on an
   * existing row.
   *
   *   - 'pending'         — the common case (scheduler / rerun mints)
   *   - 'running'         — commit&push container row ONLY (child row)
   *   - 'done'            — virtual IO rows (input / output nodes)
   *   - 'failed'          — retryNode 'queued for retry' placeholder rows
   *   - 'awaiting_review' — review park
   *   - 'awaiting_human'  — clarify / cross-clarify park
   *
   * (RFC-468: this and the three notes below came from `services/nodeRunMint.ts`'s retired copy of this input.)
   */
  readonly status: Extract<
    NodeRunStatus,
    'pending' | 'running' | 'done' | 'failed' | 'awaiting_review' | 'awaiting_human'
  >
  /**
   * WHY this row exists (RFC-098 WP-10 / audit S-25). Persisted on
   * `node_runs.rerun_cause` (migration 0044) and read back by the
   * scheduler's injection gates instead of proxy signals.
   */
  readonly cause: RerunCause
  readonly retryIndex?: number
  /**
   * RFC-354 — the frame (wrapper generation row) this row hangs off; null at
   * the top scope. `undefined` means "inherit from `inheritFrom`, else top".
   */
  readonly containerRunId?: string | null
  /** RFC-354 — explicit breadcrumb; omitted = derived from the container row by the adapter. */
  readonly scopePath?: string
  readonly iteration?: number
  /**
   * THE single inheritance list (RFC-098 survey §wp10-三): when a mint is a re-incarnation of a prior row,
   * exactly these fields carry over; null / undefined = defaults.
   */
  readonly inheritFrom?: NodeRunMintInheritance | null
  /**
   * Explicit per-site deviations; they always win over `inheritFrom`. `undefined` = "not overridden"
   * (inherit / default); explicit `null` is a real value (e.g. review-rerun rows force parentNodeRunId null).
   */
  readonly overrides?: NodeRunMintOverrides
  /**
   * RFC-359 W4-B1 批 2g：与行同一事务落库的初始输出。io-virtual 行（input / output 节点）是
   * 「born done」的——若行先可见、输出后到，另一条调度扫描会在两笔之间看见一个没有输出的 done
   * 行并据此派发下游（合一前 SQLite 两笔同步写恰好挤在同一个 tick 里，掩盖了这个缝）。
   */
  readonly outputs?: readonly NodeExecutionOutputWrite[]
  readonly executionContext?: TaskExecutionContextRef
}

/** Closed insert projection shared by both provider adapters. */
export interface NodeRunMintRecord {
  readonly slot: RunSlot
  readonly slotKey: string
  readonly executionGeneration: NodeRunMintGeneration
  readonly role: NodeRunRole
  readonly syntheticKind: NodeRunSyntheticKind | null
  readonly id: string
  readonly taskId: string
  readonly nodeId: string
  readonly status: NodeRunMintInput['status']
  readonly rerunCause: RerunCause
  readonly retryIndex: number
  readonly iteration: number
  readonly reviewIteration: number
  readonly shardKey: string | null
  readonly parentNodeRunId: string | null
  readonly containerRunId: string | null
  /** null = "derive from the container row" — the adapter resolves it before insert. */
  readonly scopePath: string | null
  readonly checkpoints: readonly TaskRepositoryCheckpoint[]
  readonly shardValueHash: string | null
  readonly consumedUpstreamRunsJson: string | null
  readonly recordedInputs: readonly RecordedNodeRunInput[] | null
  readonly errorMessage: string | null
  readonly forceActivated: boolean
  readonly startedAt: number | null
  readonly finishedAt: number | null
  readonly agentOverrideName: string | null
  readonly agentOverrideId: string | null
  readonly wgRound: number | null
  readonly envelopeNonce: string
  readonly continuationSlotKey: string | null
  readonly lineageSlotPathJson: string | null
  readonly operationGeneration: number
}

export interface NodeRunLifecyclePersistence {
  mint(input: NodeRunMintInput): Promise<string>
  transition(input: {
    readonly nodeRunId: string
    readonly event: NodeRunTransitionEvent
    readonly selection?: SelectionChange
    readonly extra?: NodeRunStatusMutation
    readonly executionGeneration?: NodeRunMintGeneration
    readonly executionContext?: TaskExecutionContextRef
  }): Promise<{ readonly from: NodeRunStatus; readonly to: NodeRunStatus }>
  set(input: {
    readonly nodeRunId: string
    readonly to: NodeRunStatus
    readonly allowedFrom: readonly NodeRunStatus[]
    readonly extra?: NodeRunStatusMutation
    readonly allowTerminal?: boolean
    readonly reason?: string
    readonly executionGeneration?: NodeRunMintGeneration
    readonly executionContext?: TaskExecutionContextRef
  }): Promise<{ readonly from: NodeRunStatus; readonly to: NodeRunStatus }>
  loadEnvelopeNonce(nodeRunId: string): Promise<string>
}

/**
 * TaskExecution-owned node lifecycle CAS bound to a caller-reserved
 * transaction. Collaboration may compose its gate rows in the same commit
 * without importing TaskExecution tables or opening a nested transaction.
 *
 * RFC-359 W8：这份合同曾住在 `public/commands.ts`。Collaboration 侧的
 * serializable 原子在 W7 合到中立的 `createCollaborationRuntimeMechanics` 之后，
 * 跨 context 的消费者归零（`tests/architecture/rfc294-review-public-consumer-ledger.test.ts`
 * 把它记成零 consumer 的 public symbol、点名本波清偿），与它配套的
 * `composePostgresqlNodeRunLifecycleParticipantFactory` 接缝也一并删除。
 * 现在它只被 task-execution 自己的 `infrastructure/nodeRunLifecyclePersistence.ts` 实现与使用，
 * 因此降级成模块内端口。
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

import type { MergeStateOrNull, NodeRunStatus, RerunCause } from '@agent-workflow/shared'

import type { NodeRunRole, NodeRunSyntheticKind } from './nodeRunRole'
import type { TaskRepositoryCheckpoint } from './taskCheckpoint'

// RFC-395 II-a：视图按目标表分组；旧协议字段名与 JSON 字节留到存储适配器切换时处理。
export interface NodeRunIdentitySnapshot {
  readonly role: NodeRunRole
  readonly syntheticKind: NodeRunSyntheticKind | null
  /** 当前 retry_index 的值，不承担时间排序。 */
  readonly attemptIndex: number
  readonly seq: number | null
  readonly id: string
  readonly taskId: string
  readonly nodeId: string
  /** 历史 parent；与 containerRunId 分别保留，不能相互推导。 */
  readonly parentNodeRunId: string | null
  readonly containerRunId: string | null
  readonly scopePath: string
  readonly iteration: number
  readonly shardKey: string | null
  readonly wgRound: number | null
  readonly reviewIteration: number
  readonly status: NodeRunStatus
  readonly startedAt: number | null
  readonly finishedAt: number | null
  readonly exitCode: number | null
  readonly errorMessage: string | null
  readonly failureCode: string | null
  readonly envelopeNonce: string | null
  readonly forceActivated: boolean
  readonly rerunCause: RerunCause | null
  readonly childTaskId: string | null
  readonly continuationSlotKey: string | null
  readonly lineageSlotPathJson: string | null
  readonly operationGeneration: number
}

export interface NodeRunConfigView {
  readonly promptText: string | null
  readonly promptPath: string | null
  readonly runtime: string | null
  readonly runtimeBinary: string | null
  readonly runtimeParamsJson: string | null
  readonly inventorySnapshotJson: string | null
  readonly runtimeInventoryJson: string | null
  readonly injectedMemoriesJson: string | null
  readonly agentOverrideName: string | null
  readonly agentOverrideId: string | null
  readonly shardValueHash: string | null
}

export interface NodeRunRuntimeStateView {
  readonly pid: number | null
  readonly spawnBinaryPath: string | null
  readonly spawnLaunchNonce: string | null
  readonly opencodeSessionId: string | null
  readonly startupVerificationJson: string | null
  readonly wrapperProgressJson: string | null
  readonly isoWorktreePath: string | null
  readonly mergeState: MergeStateOrNull
}

export interface NodeRunResultView {
  readonly tokInput: number | null
  readonly tokOutput: number | null
  readonly tokCacheCreate: number | null
  readonly tokCacheRead: number | null
  readonly tokTotal: number | null
  readonly portValidationFailuresJson: string | null
  readonly commitPushJson: string | null
  readonly supersededByReview: string | null
  readonly rolledBack: boolean | null
}

export interface NodeRunCheckpointView {
  readonly checkpoints: readonly TaskRepositoryCheckpoint[]
  readonly checkpointInheritance: readonly TaskRepositoryCheckpoint[]
}

export interface NodeRunInputView {
  readonly consumedUpstreamRunsJson: string | null
}

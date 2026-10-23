import type {
  NodeRunIdentitySnapshot,
  NodeRunConfigView,
  NodeRunRuntimeStateView,
  NodeRunResultView,
  NodeRunInputView,
} from '../../domain/nodeRunSnapshot'
import type {
  TaskCheckpointComponent,
  TaskPendingSubResolves,
  TaskRepositoryCheckpoint,
} from '../../domain/taskCheckpoint'

export interface NodeRunCheckpointWrite {
  readonly checkpoints?: readonly TaskRepositoryCheckpoint[]
  readonly checkpointComponents?: readonly TaskCheckpointComponent[]
  readonly checkpointMountPaths?: readonly string[]
  readonly pendingSubResolves?: readonly TaskPendingSubResolves[]
}

/** 状态和 reviewIteration 的 CAS 伴随项；身份不可变字段不在更新集合里。 */
// 字段逐个写出（而不是 Partial<Pick<…>>）：该类型经 public/commands 供 legacy 生命周期 writer 使用，
// RFC-294 公共合同不接受 Partial。
export interface NodeRunLifecycleWrite {
  readonly identity?: {
    readonly finishedAt?: NodeRunIdentitySnapshot['finishedAt']
    readonly startedAt?: NodeRunIdentitySnapshot['startedAt']
    readonly errorMessage?: NodeRunIdentitySnapshot['errorMessage']
    readonly failureCode?: NodeRunIdentitySnapshot['failureCode']
    readonly exitCode?: NodeRunIdentitySnapshot['exitCode']
    readonly reviewIteration?: NodeRunIdentitySnapshot['reviewIteration']
  }
  readonly runtime?: {
    readonly pid?: NodeRunRuntimeStateView['pid']
    readonly opencodeSessionId?: NodeRunRuntimeStateView['opencodeSessionId']
  }
  readonly result?: {
    readonly supersededByReview?: NodeRunResultView['supersededByReview']
    readonly rolledBack?: NodeRunResultView['rolledBack']
    readonly tokInput?: NodeRunResultView['tokInput']
    readonly tokOutput?: NodeRunResultView['tokOutput']
    readonly tokCacheCreate?: NodeRunResultView['tokCacheCreate']
    readonly tokCacheRead?: NodeRunResultView['tokCacheRead']
    readonly tokTotal?: NodeRunResultView['tokTotal']
  }
  readonly inputs?: {
    readonly consumedUpstreamRunsJson?: NodeRunInputView['consumedUpstreamRunsJson']
  }
}

/** 非生命周期写仍沿用调用点原有事务；不能借此改写 status / reviewIteration。 */
export interface NodeRunProjectionWrite {
  readonly identity?: Partial<
    Pick<
      NodeRunIdentitySnapshot,
      'childTaskId' | 'errorMessage' | 'failureCode' | 'finishedAt' | 'startedAt'
    >
  >
  readonly config?: Partial<Omit<NodeRunConfigView, 'agentOverrideName' | 'agentOverrideId'>>
  readonly runtime?: Partial<Omit<NodeRunRuntimeStateView, 'mergeState'>>
  readonly result?: Partial<Omit<NodeRunResultView, 'supersededByReview'>>
  readonly checkpoint?: NodeRunCheckpointWrite
  readonly inputs?: Partial<NodeRunInputView>
}

/** merge_state 与隔离根 / wrapper 进度同组，checkpoint 只在 CAS 命中时随写。 */
export interface NodeRunMergeWrite {
  readonly runtime?: Partial<
    Pick<NodeRunRuntimeStateView, 'isoWorktreePath' | 'wrapperProgressJson'>
  >
  readonly checkpoint?: Omit<NodeRunCheckpointWrite, 'pendingSubResolves'>
}

export interface NodeRunMintWrite {
  readonly identity?: Partial<
    Pick<
      NodeRunIdentitySnapshot,
      | 'parentNodeRunId'
      | 'shardKey'
      | 'reviewIteration'
      | 'errorMessage'
      | 'forceActivated'
      | 'startedAt'
      | 'finishedAt'
      | 'wgRound'
      | 'continuationSlotKey'
      | 'lineageSlotPathJson'
      | 'operationGeneration'
    >
  > & { readonly envelopeNonce?: string }
  readonly config?: Partial<
    Pick<NodeRunConfigView, 'shardValueHash' | 'agentOverrideName' | 'agentOverrideId'>
  >
  readonly checkpoint?: Pick<NodeRunCheckpointWrite, 'checkpoints'>
  readonly inputs?: Partial<NodeRunInputView>
}

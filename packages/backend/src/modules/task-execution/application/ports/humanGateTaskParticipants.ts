import type {
  NodeRunStatus,
  NodeRunTransitionEvent,
  RerunCause,
  TaskStatus,
} from '@agent-workflow/shared'
import type { NodeRunMintGeneration } from '../nodeRunMintIdentity'
import type { NodeRunMintInheritance } from './nodeRunLifecyclePersistence'
import type { NodeRunLifecycleWrite } from './nodeRunWrites'
import type { RunSlot } from './runSelection'
import type { TaskExecutionContextRef } from './taskExecutionTopology'
import type { NodeRunRole, NodeRunSyntheticKind } from '../../domain/nodeRunRole'
import type { TaskRepositoryCheckpoint } from '../../domain/taskCheckpoint'
import type {
  TaskNodeChangeV1,
  TaskNodeStatusesTransitionedPayloadV1,
} from '../../domain/taskLifecycleCommittedEvent'
import type { TaskExecutionPostCommitEventRef } from '../../domain/postCommitEventRef'

/** Closed request for the review and clarify mint sites; no persistence or broad write DTO. */
export interface HumanGateNodeRunMintRequest {
  readonly slot: RunSlot
  readonly envelopeNonce: string
  readonly executionGeneration: NodeRunMintGeneration
  readonly role: NodeRunRole
  readonly syntheticKind: NodeRunSyntheticKind | null
  readonly id?: string
  readonly taskId: string
  readonly nodeId: string
  readonly status: 'pending' | 'awaiting_review'
  readonly cause: RerunCause
  readonly retryIndex?: number
  readonly containerRunId?: string | null
  readonly scopePath?: string
  readonly iteration?: number
  readonly inheritFrom?: NodeRunMintInheritance | null
  readonly overrides?: {
    readonly identity?: {
      readonly parentNodeRunId?: string | null
      readonly shardKey?: string | null
      readonly reviewIteration?: number
      readonly startedAt?: number | null
    }
    readonly config?: {
      readonly agentOverrideName?: string | null
      readonly agentOverrideId?: string | null
    }
    readonly checkpoint?: { readonly checkpoints?: readonly TaskRepositoryCheckpoint[] }
    readonly inputs?: { readonly consumedUpstreamRunsJson?: string | null }
  }
  readonly executionContext?: TaskExecutionContextRef
}

export interface HumanGateNodeRunSetRequest {
  readonly nodeRunId: string
  readonly to: NodeRunStatus
  readonly allowedFrom: readonly NodeRunStatus[]
  readonly extra?: NodeRunLifecycleWrite
  readonly allowTerminal?: boolean
  readonly reason?: string
}

export interface HumanGateNodeRunTransitionRequest {
  readonly nodeRunId: string
  readonly event: NodeRunTransitionEvent
  readonly extra?: NodeRunLifecycleWrite
}

export interface HumanGateTaskEventIdentity {
  readonly operationRef?: string
  readonly eventGroupId?: string
  readonly eventGroupOrdinal?: number
  readonly correlationRef?: string | null
  readonly causationRef?: string | null
}

export interface HumanGateTaskNodeStatusesRequest {
  readonly taskId: string
  readonly reason?: TaskNodeStatusesTransitionedPayloadV1['reason']
  readonly nodeChanges: readonly TaskNodeChangeV1[]
  readonly occurredAt: number
  readonly identity: HumanGateTaskEventIdentity & { readonly operationRef: string }
}

export interface HumanGateTaskTransitionRequest {
  readonly taskId: string
  readonly expectedTaskRevision: number
  readonly transition: 'park-review' | 'park-human' | 'release-review' | 'release-human'
  readonly now: number
  readonly nodeChanges?: readonly TaskNodeChangeV1[]
  readonly committedEventIdentity?: HumanGateTaskEventIdentity
}

export interface HumanGateTaskTransitionResult {
  readonly from: TaskStatus
  readonly to: TaskStatus
  readonly taskRevision: number
  readonly eventRefs: readonly TaskExecutionPostCommitEventRef[]
}

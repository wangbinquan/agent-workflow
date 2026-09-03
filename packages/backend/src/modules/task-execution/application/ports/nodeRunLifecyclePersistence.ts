import type { NodeRunStatus, NodeRunTransitionEvent, RerunCause } from '@agent-workflow/shared'

import type { TaskExecutionContextRef } from './taskExecutionTopology'

export interface NodeRunStatusMutation {
  readonly finishedAt?: number | null
  readonly startedAt?: number | null
  readonly errorMessage?: string | null
  readonly failureCode?: string | null
  readonly supersededByReview?: string | null
  readonly rolledBack?: boolean
  readonly exitCode?: number | null
  readonly pid?: number | null
  readonly reviewIteration?: number
  readonly consumedUpstreamRunsJson?: string | null
  readonly preSnapshot?: string | null
  readonly opencodeSessionId?: string | null
  readonly tokInput?: number | null
  readonly tokOutput?: number | null
  readonly tokCacheCreate?: number | null
  readonly tokCacheRead?: number | null
  readonly tokTotal?: number | null
}

export interface NodeRunMintInheritance {
  readonly reviewIteration: number
  readonly shardKey: string | null
  readonly parentNodeRunId: string | null
  /** RFC-354 — a rerun / placeholder stays in the frame of the row it is minted from. */
  readonly containerRunId?: string | null
  readonly preSnapshot: string | null
  readonly continuationSlotKey?: string | null
  readonly lineageSlotPathJson?: string | null
  readonly operationGeneration?: number
}

export interface NodeRunMintOverrides {
  readonly parentNodeRunId?: string | null
  readonly shardKey?: string | null
  readonly reviewIteration?: number
  readonly preSnapshot?: string | null
  readonly shardValueHash?: string | null
  readonly consumedUpstreamRunsJson?: string | null
  readonly errorMessage?: string | null
  readonly forceActivated?: boolean
  readonly startedAt?: number | null
  readonly finishedAt?: number | null
  readonly agentOverrideName?: string | null
  readonly agentOverrideId?: string | null
  readonly wgRound?: number | null
  readonly envelopeNonce?: string
  readonly continuationSlotKey?: string | null
  readonly lineageSlotPathJson?: string | null
  readonly operationGeneration?: number
}

export interface NodeRunMintInput {
  readonly id?: string
  readonly taskId: string
  readonly nodeId: string
  readonly status: Extract<
    NodeRunStatus,
    'pending' | 'running' | 'done' | 'failed' | 'awaiting_review' | 'awaiting_human'
  >
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
  readonly inheritFrom?: NodeRunMintInheritance | null
  readonly overrides?: NodeRunMintOverrides
  readonly executionContext?: TaskExecutionContextRef
}

/** Closed insert projection shared by both provider adapters. */
export interface NodeRunMintRecord {
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
  readonly preSnapshot: string | null
  readonly shardValueHash: string | null
  readonly consumedUpstreamRunsJson: string | null
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
    readonly extra?: NodeRunStatusMutation
    readonly executionContext?: TaskExecutionContextRef
  }): Promise<{ readonly from: NodeRunStatus; readonly to: NodeRunStatus }>
  set(input: {
    readonly nodeRunId: string
    readonly to: NodeRunStatus
    readonly allowedFrom: readonly NodeRunStatus[]
    readonly extra?: NodeRunStatusMutation
    readonly allowTerminal?: boolean
    readonly reason?: string
    readonly executionContext?: TaskExecutionContextRef
  }): Promise<{ readonly from: NodeRunStatus; readonly to: NodeRunStatus }>
  loadEnvelopeNonce(nodeRunId: string): Promise<string>
}

// RFC-333 — collaboration-owned required shape for task-execution participation.
// A composition adapter binds one instance to the live transaction; the port
// therefore exposes no DbTx/repository handle.

import type { HumanGateIdentity } from '../../domain/gateReceipt'

export interface GateNodeProjectionFence {
  readonly digest: string
  readonly memberCount: number
}

export interface GateContinuationLineage {
  readonly sourceNodeRunIds: readonly string[]
  readonly rerunNodeRunIds: readonly string[]
}

export interface PreparedWorkspaceRollbackRef {
  readonly operationId: string
  readonly planDigest: string
}

export interface TaskDecisionParticipantResult {
  readonly taskRevision: number
  readonly continuationRef: string
}

export interface TaskDecisionParticipantInTx {
  acceptGateDecisionTx(input: {
    readonly taskId: string
    readonly gate: HumanGateIdentity
    readonly expectedTaskRevision: number
    readonly expectedNodeProjection: GateNodeProjectionFence
    readonly continuationLineage: GateContinuationLineage
    readonly workspaceRollbackPlan?: PreparedWorkspaceRollbackRef
    readonly operationId: string
    readonly now: number
  }): TaskDecisionParticipantResult
}

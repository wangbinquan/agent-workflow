// RFC-333 — purpose-specific ports for the gate-continuation rollback effect.

import type { DbTxSync } from '@/db/txSync'
import type { TaskExecutionHumanGateKind } from '../../domain/humanGateContinuation'

export interface GateWorkspaceRollbackRef {
  readonly taskId: string
  readonly operationId: string
  readonly planDigest: string
}

export interface GateWorkspaceRollbackPlanView extends GateWorkspaceRollbackRef {
  readonly resourceKeys: readonly string[]
}

export interface GateWorkspaceRollbackOutcome {
  /** True only when every planned target was rolled back successfully. */
  readonly rolledBack: boolean
  /** Whether the external act changed anything, or provably changed nothing. */
  readonly applicationEvidence: 'applied' | 'definitely-not-applied'
  readonly receipt: Readonly<Record<string, unknown>>
}

export interface GateWorkspaceRollbackExecutor {
  loadValidatedPlan(ref: GateWorkspaceRollbackRef): Promise<GateWorkspaceRollbackPlanView>
  executeValidatedPlan(plan: GateWorkspaceRollbackPlanView): Promise<GateWorkspaceRollbackOutcome>
}

export interface GateWorkspaceRollbackProjectionParticipantInTx {
  projectWorkspaceRollbackTx(input: {
    readonly taskId: string
    readonly gateKind: TaskExecutionHumanGateKind
    readonly operationId: string
    readonly planDigest: string
    readonly sourceNodeRunIds: readonly string[]
    readonly rerunNodeRunIds: readonly string[]
    readonly rolledBack: boolean
    readonly receipt: Readonly<Record<string, unknown>>
    readonly now: number
  }): void
}

/** Internal composition seam; callers receive only a tx-bound participant. */
export interface GateWorkspaceRollbackProjectionFactory {
  bind(tx: DbTxSync): GateWorkspaceRollbackProjectionParticipantInTx
}

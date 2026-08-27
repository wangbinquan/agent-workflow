// RFC-333 — purpose-specific port for the gate-continuation rollback effect.

export interface GateWorkspaceRollbackRef {
  readonly taskId: string
  readonly operationId: string
  readonly planDigest: string
}

export interface GateWorkspaceRollbackPlanView extends GateWorkspaceRollbackRef {
  readonly resourceKeys: readonly string[]
}

export interface GateWorkspaceRollbackTargetReceipt {
  readonly sourceNodeRunId: string
  readonly worktreeDirName: string
  readonly snapshot: string
  readonly ok: boolean
  readonly code?: string
  readonly message?: string
}

export interface GateWorkspaceRollbackReceipt {
  readonly targetCount: number
  readonly failureCount: number
  readonly successfulSourceNodeRunIds: readonly string[]
  readonly targets: readonly GateWorkspaceRollbackTargetReceipt[]
}

export interface GateWorkspaceRollbackOutcome {
  /** True only when every planned target was rolled back successfully. */
  readonly rolledBack: boolean
  /** Whether the external act changed anything, or provably changed nothing. */
  readonly applicationEvidence: 'applied' | 'definitely-not-applied'
  readonly receipt: GateWorkspaceRollbackReceipt
}

export interface GateWorkspaceRollbackExecutor {
  loadValidatedPlan(ref: GateWorkspaceRollbackRef): Promise<GateWorkspaceRollbackPlanView>
  executeValidatedPlan(plan: GateWorkspaceRollbackPlanView): Promise<GateWorkspaceRollbackOutcome>
}

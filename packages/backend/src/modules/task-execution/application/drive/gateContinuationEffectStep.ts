// RFC-349 — provider-neutral gate rollback pre-drive step.

import type { OwnershipToken } from '../../domain/ownership'
import type {
  GateWorkspaceRollbackExecutor,
  GateWorkspaceRollbackRef,
} from '../ports/gateWorkspaceRollback'
import type { RepositoryPreparationStep, TaskDriveContext } from './taskDriveCoordinator'

export interface PendingGateRollbackEffect extends GateWorkspaceRollbackRef {
  readonly effectId: string
  readonly operationKey: string
  readonly executionLineageId: string
  readonly operationFamilyKey: string
  readonly operationGeneration: number
  readonly requestHash: string
  readonly slotPathJson: string
  readonly slotPathDigest: string
  readonly sourceNodeRunIds: readonly string[]
}

export type GateRollbackInspection =
  | Readonly<{ kind: 'ready' }>
  | Readonly<{ kind: 'pending'; effect: PendingGateRollbackEffect }>

/** Named atomic port owns intent/effect validation, attempt/fence acquisition,
 * and final review-node projection with the effect settlement. */
export interface GateContinuationEffectPersistence {
  inspect(input: {
    readonly taskId: string
    readonly intentId: string
    readonly token: OwnershipToken
  }): Promise<GateRollbackInspection>
  prepare(input: {
    readonly taskId: string
    readonly intentId: string
    readonly token: OwnershipToken
    readonly effect: PendingGateRollbackEffect
    readonly resourceKeys: readonly string[]
  }): Promise<{ readonly effectId: string; readonly attemptId: string }>
  settle(input: {
    readonly token: OwnershipToken
    readonly effectId: string
    readonly attemptId: string
    readonly operationId: string
    readonly planDigest: string
    readonly sourceNodeRunIds: readonly string[]
    readonly outcome:
      | Readonly<{ kind: 'threw'; error: string }>
      | Readonly<{
          kind: 'completed'
          rolledBack: boolean
          applicationEvidence: 'applied' | 'definitely-not-applied'
          receipt: Readonly<Record<string, unknown>>
          successfulSourceNodeRunIds: readonly string[]
        }>
  }): Promise<void>
}

function clippedError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 2_000)
}

export class GateContinuationEffectStep implements RepositoryPreparationStep {
  constructor(
    private readonly persistence: GateContinuationEffectPersistence,
    private readonly executor: GateWorkspaceRollbackExecutor,
  ) {}

  async run(context: TaskDriveContext): Promise<{ kind: 'ready' }> {
    const inspected = await this.persistence.inspect({
      taskId: context.taskId,
      intentId: context.execution.intentId,
      token: context.execution.token,
    })
    if (inspected.kind === 'ready') return inspected
    const ref: GateWorkspaceRollbackRef = inspected.effect
    const plan = await this.executor.loadValidatedPlan(ref)
    if (
      plan.taskId !== ref.taskId ||
      plan.operationId !== ref.operationId ||
      plan.planDigest !== ref.planDigest ||
      plan.resourceKeys.length === 0
    ) {
      throw new Error(
        `workspace rollback plan '${ref.operationId}' no longer matches its reference`,
      )
    }
    const prepared = await this.persistence.prepare({
      taskId: context.taskId,
      intentId: context.execution.intentId,
      token: context.execution.token,
      effect: inspected.effect,
      resourceKeys: plan.resourceKeys,
    })
    try {
      const outcome = await this.executor.executeValidatedPlan(plan)
      if (outcome.rolledBack && outcome.applicationEvidence !== 'applied') {
        throw new Error(`workspace rollback '${ref.operationId}' reported success without evidence`)
      }
      await this.persistence.settle({
        token: context.execution.token,
        effectId: prepared.effectId,
        attemptId: prepared.attemptId,
        operationId: ref.operationId,
        planDigest: ref.planDigest,
        sourceNodeRunIds: inspected.effect.sourceNodeRunIds,
        outcome: {
          kind: 'completed',
          rolledBack: outcome.rolledBack,
          applicationEvidence: outcome.applicationEvidence,
          receipt: { ...outcome.receipt },
          successfulSourceNodeRunIds: outcome.receipt.successfulSourceNodeRunIds,
        },
      })
    } catch (error) {
      await this.persistence.settle({
        token: context.execution.token,
        effectId: prepared.effectId,
        attemptId: prepared.attemptId,
        operationId: ref.operationId,
        planDigest: ref.planDigest,
        sourceNodeRunIds: inspected.effect.sourceNodeRunIds,
        outcome: { kind: 'threw', error: clippedError(error) },
      })
      throw error
    }
    return { kind: 'ready' }
  }
}

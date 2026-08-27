// RFC-333 — settle a linked workspace rollback before gate-continuation drive.

import { and, eq, inArray } from '@/db/query'
import type { DbClient } from '@/db/client'
import {
  taskExecutionEffectAttempts,
  taskExecutionEffects,
  taskExecutionIntents,
} from '@/db/schema'
import { decodeHumanGateContinuationPayload } from '../../domain/humanGateContinuation'
import type { TaskExecutionEffectStore } from '../ports/taskExecutionEffectStore'
import type {
  GateWorkspaceRollbackExecutor,
  GateWorkspaceRollbackProjectionFactory,
  GateWorkspaceRollbackRef,
} from '../ports/gateWorkspaceRollback'
import { waitForEffectResourceTurn } from '../effectResourceWait'
import { TaskExecutionError } from '../taskExecutionError'
import type { RepositoryPreparationStep, TaskDriveContext } from './taskDriveCoordinator'

const CLASSIFIER_VERSION = 'rfc333-gate-workspace-rollback-v1'
const TRANSPORT_VERSION = 'rfc333-local-plan-v1'

function clippedError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 2_000)
}

export class GateContinuationEffectStep implements RepositoryPreparationStep {
  constructor(
    private readonly db: DbClient,
    private readonly effects: TaskExecutionEffectStore,
    private readonly executor: GateWorkspaceRollbackExecutor,
    private readonly projections: GateWorkspaceRollbackProjectionFactory,
  ) {}

  async run(context: TaskDriveContext): Promise<{ kind: 'ready' }> {
    const intent = this.db
      .select({
        kind: taskExecutionIntents.kind,
        state: taskExecutionIntents.state,
        payloadJson: taskExecutionIntents.payloadJson,
      })
      .from(taskExecutionIntents)
      .where(
        and(
          eq(taskExecutionIntents.id, context.execution.intentId),
          eq(taskExecutionIntents.taskId, context.taskId),
        ),
      )
      .get()
    if (intent === undefined || intent.state !== 'claimed') {
      throw new TaskExecutionError(
        'task-execution-stale-owner',
        `gate pre-drive cannot read claimed intent '${context.execution.intentId}'`,
      )
    }
    if (intent.kind !== 'gate-continuation') return { kind: 'ready' }

    const payload = decodeHumanGateContinuationPayload(intent.payloadJson)
    const linked = this.db
      .select()
      .from(taskExecutionEffects)
      .where(
        and(
          eq(taskExecutionEffects.currentIntentId, context.execution.intentId),
          eq(taskExecutionEffects.taskId, context.taskId),
          eq(taskExecutionEffects.kind, 'workspace-rollback'),
        ),
      )
      .all()
    if (linked.length > 1) {
      throw new TaskExecutionError(
        'task-continuation-conflict',
        `gate continuation '${context.execution.intentId}' has multiple rollback effects`,
      )
    }
    const effect = linked[0]
    if (payload.workspaceRollbackPlan === undefined) {
      if (effect !== undefined) {
        throw new TaskExecutionError(
          'task-continuation-conflict',
          `gate continuation '${context.execution.intentId}' has an undeclared rollback effect`,
        )
      }
      return { kind: 'ready' }
    }
    if (effect === undefined) {
      throw new TaskExecutionError(
        'task-continuation-stale',
        `gate continuation '${context.execution.intentId}' lost its rollback effect`,
      )
    }
    if (effect.requestHash !== payload.workspaceRollbackPlan.planDigest) {
      throw new TaskExecutionError(
        'task-continuation-conflict',
        `gate continuation '${context.execution.intentId}' rollback digest changed`,
      )
    }
    if (effect.state === 'succeeded' || effect.state === 'failed') return { kind: 'ready' }
    if (effect.state === 'outcome-unknown') {
      throw new TaskExecutionError(
        'task-execution-outcome-unknown',
        `workspace rollback effect '${effect.id}' has an unknown outcome`,
      )
    }
    const unresolvedAttempt = this.db
      .select({ id: taskExecutionEffectAttempts.id })
      .from(taskExecutionEffectAttempts)
      .where(
        and(
          eq(taskExecutionEffectAttempts.effectId, effect.id),
          inArray(taskExecutionEffectAttempts.state, ['prepared', 'acting', 'recovery-required']),
        ),
      )
      .get()
    if (unresolvedAttempt !== undefined) {
      throw new TaskExecutionError(
        'task-execution-recovery-required',
        `workspace rollback effect '${effect.id}' requires recovery before drive`,
      )
    }

    const ref: GateWorkspaceRollbackRef = {
      taskId: context.taskId,
      operationId: payload.workspaceRollbackPlan.operationId,
      planDigest: payload.workspaceRollbackPlan.planDigest,
    }
    const plan = await this.executor.loadValidatedPlan(ref)
    if (
      plan.taskId !== ref.taskId ||
      plan.operationId !== ref.operationId ||
      plan.planDigest !== ref.planDigest ||
      plan.resourceKeys.length === 0
    ) {
      throw new TaskExecutionError(
        'task-continuation-conflict',
        `workspace rollback plan '${ref.operationId}' no longer matches its committed reference`,
      )
    }
    const prepared = await waitForEffectResourceTurn(() =>
      this.effects.prepareAndAcquire({
        db: this.db,
        token: context.execution.token,
        intentId: context.execution.intentId,
        operationKey: effect.operationKey,
        executionLineageId: effect.executionLineageId,
        operationFamilyKey: effect.operationFamilyKey,
        operationGeneration: effect.operationGeneration,
        kind: 'workspace-rollback',
        requestHash: effect.requestHash,
        slotPathJson: effect.slotPathJson,
        slotPathDigest: effect.slotPathDigest,
        candidateId: `human-gate:${ref.operationId}`,
        recoveryClass: 'human-gate-workspace-rollback',
        recoveryDescriptorJson: JSON.stringify({
          v: 1,
          kind: 'human-gate-workspace-rollback',
          operationId: ref.operationId,
          planDigest: ref.planDigest,
        }),
        classifierVersion: CLASSIFIER_VERSION,
        transportPolicyVersion: TRANSPORT_VERSION,
        retryAuthority: 'none',
        resourceKeys: plan.resourceKeys,
      }),
    )

    let outcome
    try {
      outcome = await this.executor.executeValidatedPlan(plan)
    } catch (error) {
      this.effects.settle({
        db: this.db,
        token: context.execution.token,
        effectId: prepared.effectId,
        attemptId: prepared.attemptId,
        state: 'recovery-required',
        applicationEvidence: 'ambiguous',
        retryAuthority: 'none',
        receiptJson: JSON.stringify({
          v: 1,
          operationId: ref.operationId,
          planDigest: ref.planDigest,
          error: clippedError(error),
        }),
        failureCode: 'human-gate-workspace-rollback-threw',
      })
      throw error
    }
    if (outcome.rolledBack && outcome.applicationEvidence !== 'applied') {
      throw new TaskExecutionError(
        'task-continuation-conflict',
        `workspace rollback '${ref.operationId}' reported success without application evidence`,
      )
    }
    const receipt = {
      v: 1,
      operationId: ref.operationId,
      planDigest: ref.planDigest,
      rolledBack: outcome.rolledBack,
      outcome: outcome.receipt,
    }
    this.effects.settle({
      db: this.db,
      token: context.execution.token,
      effectId: prepared.effectId,
      attemptId: prepared.attemptId,
      state: outcome.applicationEvidence === 'applied' ? 'succeeded' : 'failed-not-applied',
      applicationEvidence: outcome.applicationEvidence,
      retryAuthority: 'none',
      receiptJson: JSON.stringify(receipt),
      ...(outcome.rolledBack ? {} : { failureCode: 'human-gate-workspace-rollback-incomplete' }),
      onSettledTx: (tx) =>
        this.projections.bind(tx).projectWorkspaceRollbackTx({
          taskId: context.taskId,
          gateKind: payload.gate.kind,
          operationId: ref.operationId,
          planDigest: ref.planDigest,
          sourceNodeRunIds: payload.continuationLineage.sourceNodeRunIds,
          rerunNodeRunIds: payload.continuationLineage.rerunNodeRunIds,
          rolledBack: outcome.rolledBack,
          receipt,
          now: Date.now(),
        }),
    })
    return { kind: 'ready' }
  }
}

// RFC-349 — SQLite adapter for the human-gate rollback pre-drive atom.

import { and, eq, inArray } from '@/db/query'
import type { DbClient } from '@/db/client'
import {
  taskExecutionEffectAttempts,
  taskExecutionEffects,
  taskExecutionIntents,
} from '@/db/schema'
import type { GateContinuationEffectPersistence } from '../application/drive/gateContinuationEffectStep'
import { waitForEffectResourceTurn } from '../application/effectResourceWait'
import { TaskExecutionError } from '../application/taskExecutionError'
import {
  decodeHumanGateContinuationPayload,
  isLegacyTaskGateContinuationPayload,
} from '../domain/humanGateContinuation'
import { SqliteTaskExecutionEffectPersistence } from './sqliteTaskExecutionEffectPersistence'

const CLASSIFIER_VERSION = 'rfc333-gate-workspace-rollback-v1'
const TRANSPORT_VERSION = 'rfc333-local-plan-v1'

export class SqliteGateContinuationEffectPersistence implements GateContinuationEffectPersistence {
  constructor(
    private readonly db: DbClient,
    private readonly effects = new SqliteTaskExecutionEffectPersistence(db),
  ) {}

  async inspect(input: Parameters<GateContinuationEffectPersistence['inspect']>[0]) {
    const intent = this.db
      .select({
        kind: taskExecutionIntents.kind,
        state: taskExecutionIntents.state,
        payloadJson: taskExecutionIntents.payloadJson,
      })
      .from(taskExecutionIntents)
      .where(
        and(
          eq(taskExecutionIntents.id, input.intentId),
          eq(taskExecutionIntents.taskId, input.taskId),
        ),
      )
      .get()
    if (intent === undefined || intent.state !== 'claimed') {
      throw new TaskExecutionError(
        'task-execution-stale-owner',
        `gate pre-drive cannot read claimed intent '${input.intentId}'`,
      )
    }
    if (
      intent.kind !== 'gate-continuation' ||
      isLegacyTaskGateContinuationPayload(intent.payloadJson)
    ) {
      return { kind: 'ready' as const }
    }
    const payload = decodeHumanGateContinuationPayload(intent.payloadJson)
    const linked = this.db
      .select()
      .from(taskExecutionEffects)
      .where(
        and(
          eq(taskExecutionEffects.currentIntentId, input.intentId),
          eq(taskExecutionEffects.taskId, input.taskId),
          eq(taskExecutionEffects.kind, 'workspace-rollback'),
        ),
      )
      .limit(2)
      .all()
    if (linked.length > 1) {
      throw new TaskExecutionError(
        'task-continuation-conflict',
        `gate continuation '${input.intentId}' has multiple rollback effects`,
      )
    }
    const effect = linked[0]
    if (payload.workspaceRollbackPlan === undefined) {
      if (effect !== undefined) {
        throw new TaskExecutionError(
          'task-continuation-conflict',
          `gate continuation '${input.intentId}' has an undeclared rollback effect`,
        )
      }
      return { kind: 'ready' as const }
    }
    if (effect === undefined) {
      throw new TaskExecutionError(
        'task-continuation-stale',
        `gate continuation '${input.intentId}' lost its rollback effect`,
      )
    }
    if (effect.requestHash !== payload.workspaceRollbackPlan.planDigest) {
      throw new TaskExecutionError(
        'task-continuation-conflict',
        `gate continuation '${input.intentId}' rollback digest changed`,
      )
    }
    if (effect.state === 'succeeded' || effect.state === 'failed') {
      return { kind: 'ready' as const }
    }
    if (effect.state === 'outcome-unknown') {
      throw new TaskExecutionError(
        'task-execution-outcome-unknown',
        `workspace rollback effect '${effect.id}' has an unknown outcome`,
      )
    }
    const unresolved = this.db
      .select({ id: taskExecutionEffectAttempts.id })
      .from(taskExecutionEffectAttempts)
      .where(
        and(
          eq(taskExecutionEffectAttempts.effectId, effect.id),
          inArray(taskExecutionEffectAttempts.state, ['prepared', 'acting', 'recovery-required']),
        ),
      )
      .get()
    if (unresolved !== undefined) {
      throw new TaskExecutionError(
        'task-execution-recovery-required',
        `workspace rollback effect '${effect.id}' requires recovery before drive`,
      )
    }
    return {
      kind: 'pending' as const,
      effect: {
        taskId: input.taskId,
        operationId: payload.workspaceRollbackPlan.operationId,
        planDigest: payload.workspaceRollbackPlan.planDigest,
        effectId: effect.id,
        operationKey: effect.operationKey,
        executionLineageId: effect.executionLineageId,
        operationFamilyKey: effect.operationFamilyKey,
        operationGeneration: effect.operationGeneration,
        requestHash: effect.requestHash,
        slotPathJson: effect.slotPathJson,
        slotPathDigest: effect.slotPathDigest,
        sourceNodeRunIds:
          payload.gate.kind === 'review' ? payload.continuationLineage.sourceNodeRunIds : [],
      },
    }
  }

  async prepare(input: Parameters<GateContinuationEffectPersistence['prepare']>[0]) {
    return await waitForEffectResourceTurn(async () => {
      const prepared = await this.effects.prepareAndAcquire({
        token: input.token,
        intentId: input.intentId,
        operationKey: input.effect.operationKey,
        executionLineageId: input.effect.executionLineageId,
        operationFamilyKey: input.effect.operationFamilyKey,
        operationGeneration: input.effect.operationGeneration,
        kind: 'workspace-rollback',
        requestHash: input.effect.requestHash,
        slotPathJson: input.effect.slotPathJson,
        slotPathDigest: input.effect.slotPathDigest,
        candidateId: `human-gate:${input.effect.operationId}`,
        recoveryClass: 'human-gate-workspace-rollback',
        recoveryDescriptorJson: JSON.stringify({
          v: 1,
          kind: 'human-gate-workspace-rollback',
          operationId: input.effect.operationId,
          planDigest: input.effect.planDigest,
        }),
        classifierVersion: CLASSIFIER_VERSION,
        transportPolicyVersion: TRANSPORT_VERSION,
        retryAuthority: 'none',
        resourceKeys: input.resourceKeys,
      })
      return { effectId: prepared.effectId, attemptId: prepared.attemptId }
    })
  }

  async settle(input: Parameters<GateContinuationEffectPersistence['settle']>[0]): Promise<void> {
    await this.effects.settleGateRollback(input)
  }
}

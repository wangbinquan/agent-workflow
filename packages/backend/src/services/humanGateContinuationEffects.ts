// RFC-333 T8 — legacy bootstrap wiring for the gate-continuation pre-drive
// phase.  The bounded contexts meet through their purpose-specific ports; this
// file is the temporary composition bridge tracked by RFC-294 W4.

import { and, eq, isNotNull, isNull } from 'drizzle-orm'
import type { DbClient } from '@/db/client'
import { collaborationGateOperations, taskExecutionIntents, taskQuestions } from '@/db/schema'
import {
  GateContinuationEffectStep,
  TaskExecutionError,
  isLegacyTaskGateContinuationPayload,
  type GateWorkspaceRollbackExecutor,
  type GateWorkspaceRollbackOutcome,
  type GateWorkspaceRollbackPlanView,
  type GateWorkspaceRollbackRef,
  type GateWorkspaceRollbackTargetReceipt,
  taskExecutionModule,
} from '@/modules/task-execution/public/participants'
import {
  humanGateComposition,
  type ValidatedWorkspaceRollbackPlanBridge as ValidatedWorkspaceRollbackPlan,
} from '@/services/humanGateComposition'
import { finishCommittedClarifyAutoDispatch } from '@/services/clarify/autoDispatch'
import { getTaskWriteSem } from '@/services/taskWriteLocks'
import { rollbackToSnapshot } from '@/util/git'

const { decodeReviewDecisionManifest } = humanGateComposition

type GatePreDriveContext = Parameters<InstanceType<typeof GateContinuationEffectStep>['run']>[0]

function decodeClarifyContinuation(raw: string): {
  readonly operationId: string
  readonly gateRef: string
  readonly originNodeRunId: string
} | null {
  let decoded: unknown
  try {
    decoded = JSON.parse(raw)
  } catch {
    throw new TaskExecutionError(
      'task-continuation-conflict',
      'clarify gate continuation payload is not valid JSON',
    )
  }
  if (decoded === null || typeof decoded !== 'object' || Array.isArray(decoded)) {
    throw new TaskExecutionError(
      'task-continuation-conflict',
      'clarify gate continuation payload is not an object',
    )
  }
  const value = decoded as Record<string, unknown>
  const gate = value.gate
  if (gate === null || typeof gate !== 'object' || Array.isArray(gate)) return null
  const gateValue = gate as Record<string, unknown>
  if (gateValue.kind !== 'clarify') return null
  const lineage = value.continuationLineage
  const lineageValue =
    lineage !== null && typeof lineage === 'object' && !Array.isArray(lineage)
      ? (lineage as Record<string, unknown>)
      : null
  const sourceNodeRunIds = lineageValue?.sourceNodeRunIds
  const rerunNodeRunIds = lineageValue?.rerunNodeRunIds
  if (
    value.v !== 1 ||
    typeof value.operationId !== 'string' ||
    value.operationId.length === 0 ||
    typeof gateValue.ref !== 'string' ||
    gateValue.ref.length === 0 ||
    !Array.isArray(sourceNodeRunIds) ||
    sourceNodeRunIds.length !== 1 ||
    typeof sourceNodeRunIds[0] !== 'string' ||
    sourceNodeRunIds[0].length === 0 ||
    !Array.isArray(rerunNodeRunIds) ||
    rerunNodeRunIds.length !== 0
  ) {
    throw new TaskExecutionError(
      'task-continuation-conflict',
      'clarify gate continuation payload does not match its durable decision',
    )
  }
  return {
    operationId: value.operationId,
    gateRef: gateValue.ref,
    originNodeRunId: sourceNodeRunIds[0],
  }
}

function releaseClarifyConvergenceForRetry(db: DbClient, context: GatePreDriveContext): void {
  const released = db
    .update(taskExecutionIntents)
    .set({
      state: 'pending',
      claimedEpoch: null,
      claimedAt: null,
      failureCode: 'clarify-convergence-retry',
      updatedAt: Date.now(),
    })
    .where(
      and(
        eq(taskExecutionIntents.id, context.execution.intentId),
        eq(taskExecutionIntents.taskId, context.taskId),
        eq(taskExecutionIntents.kind, 'gate-continuation'),
        eq(taskExecutionIntents.state, 'claimed'),
        eq(taskExecutionIntents.claimedEpoch, context.execution.token.epoch),
      ),
    )
    .returning({ id: taskExecutionIntents.id })
    .get()
  if (released === undefined) {
    throw new TaskExecutionError(
      'task-execution-stale-owner',
      `clarify convergence could not release exact intent '${context.execution.intentId}' for retry`,
    )
  }
}

function clippedError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 2_000)
}

export class SqliteGateWorkspaceRollbackExecutor implements GateWorkspaceRollbackExecutor {
  private readonly resolvedPlans = new WeakMap<object, ValidatedWorkspaceRollbackPlan>()

  constructor(private readonly db: DbClient) {}

  async loadValidatedPlan(ref: GateWorkspaceRollbackRef): Promise<GateWorkspaceRollbackPlanView> {
    const operation = this.db
      .select({
        taskId: collaborationGateOperations.taskId,
        manifestJson: collaborationGateOperations.manifestJson,
      })
      .from(collaborationGateOperations)
      .where(eq(collaborationGateOperations.id, ref.operationId))
      .get()
    if (operation === undefined || operation.taskId !== ref.taskId) {
      throw new Error(`workspace rollback operation '${ref.operationId}' does not exist`)
    }
    const plan = decodeReviewDecisionManifest(operation.manifestJson).workspaceRollbackPlan
    if (plan === null || plan.taskId !== ref.taskId || plan.digest !== ref.planDigest) {
      throw new Error(`workspace rollback operation '${ref.operationId}' changed its plan`)
    }
    const view = Object.freeze({
      taskId: ref.taskId,
      operationId: ref.operationId,
      planDigest: ref.planDigest,
      resourceKeys: plan.resourceKeys,
    })
    this.resolvedPlans.set(view, plan)
    return view
  }

  async executeValidatedPlan(
    view: GateWorkspaceRollbackPlanView,
  ): Promise<GateWorkspaceRollbackOutcome> {
    const plan = this.resolvedPlans.get(view)
    if (plan === undefined)
      throw new Error('workspace rollback plan was not loaded by this executor')
    return getTaskWriteSem(plan.taskId).run(async () => {
      const targets: GateWorkspaceRollbackTargetReceipt[] = []
      for (const target of plan.targets) {
        try {
          await rollbackToSnapshot(target.worktreePath, target.snapshot)
          targets.push({
            sourceNodeRunId: target.sourceNodeRunId,
            worktreeDirName: target.worktreeDirName,
            snapshot: target.snapshot,
            ok: true,
          })
        } catch (error) {
          targets.push({
            sourceNodeRunId: target.sourceNodeRunId,
            worktreeDirName: target.worktreeDirName,
            snapshot: target.snapshot,
            ok: false,
            code: (error as { code?: string }).code ?? 'rollback-failed',
            message: clippedError(error),
          })
        }
      }
      const bySource = new Map<string, boolean>()
      for (const target of targets) {
        bySource.set(
          target.sourceNodeRunId,
          (bySource.get(target.sourceNodeRunId) ?? true) && target.ok,
        )
      }
      const successfulSourceNodeRunIds = [...bySource]
        .filter(([, ok]) => ok)
        .map(([id]) => id)
        .sort()
      const rolledBack = targets.length > 0 && targets.every((target) => target.ok)
      return {
        rolledBack,
        // Every non-empty plan starts a concrete git act. A partial failure is
        // still application evidence and is projected source-by-source.
        applicationEvidence: targets.length > 0 ? 'applied' : 'definitely-not-applied',
        receipt: {
          targetCount: targets.length,
          failureCount: targets.filter((target) => !target.ok).length,
          successfulSourceNodeRunIds,
          targets,
        },
      }
    })
  }
}

export function createGateContinuationPreDriveStep(db: DbClient): {
  run(context: GatePreDriveContext): Promise<{ kind: 'ready' }>
} {
  const effects = new GateContinuationEffectStep(
    db,
    taskExecutionModule.effects,
    new SqliteGateWorkspaceRollbackExecutor(db),
  )
  return {
    async run(context) {
      const intent = db
        .select({
          kind: taskExecutionIntents.kind,
          state: taskExecutionIntents.state,
          claimedEpoch: taskExecutionIntents.claimedEpoch,
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
      if (
        intent === undefined ||
        intent.state !== 'claimed' ||
        intent.claimedEpoch !== context.execution.token.epoch
      ) {
        throw new TaskExecutionError(
          'task-execution-stale-owner',
          `clarify convergence cannot read exact claimed intent '${context.execution.intentId}'`,
        )
      }
      if (
        intent.kind === 'gate-continuation' &&
        !isLegacyTaskGateContinuationPayload(intent.payloadJson)
      ) {
        try {
          const clarify = decodeClarifyContinuation(intent.payloadJson)
          if (clarify !== null) {
            if (clarify.gateRef !== `clarify:${clarify.originNodeRunId}`) {
              throw new TaskExecutionError(
                'task-continuation-conflict',
                `clarify continuation '${context.execution.intentId}' changed its gate reference`,
              )
            }
            await finishCommittedClarifyAutoDispatch({
              db,
              operationId: clarify.operationId,
              expectedTaskId: context.taskId,
              expectedOriginNodeRunId: clarify.originNodeRunId,
              expectedContinuationRef: context.execution.intentId,
            })
            const pending = db
              .select({ id: taskQuestions.id })
              .from(taskQuestions)
              .where(
                and(
                  eq(taskQuestions.taskId, context.taskId),
                  eq(taskQuestions.originNodeRunId, clarify.originNodeRunId),
                  eq(taskQuestions.confirmation, 'open'),
                  isNotNull(taskQuestions.sealedAt),
                  isNull(taskQuestions.dispatchedAt),
                ),
              )
              .get()
            if (pending !== undefined) {
              throw new TaskExecutionError(
                'task-execution-recovery-required',
                `clarify continuation '${context.execution.intentId}' still has undispatched durable work`,
              )
            }
          }
        } catch (error) {
          releaseClarifyConvergenceForRetry(db, context)
          throw error
        }
      }
      return await effects.run(context)
    },
  }
}

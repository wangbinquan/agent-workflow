// RFC-333 T8 — legacy bootstrap wiring for the gate-continuation pre-drive
// phase.  The bounded contexts meet through their purpose-specific ports; this
// file is the temporary composition bridge tracked by RFC-294 W4.

import { GateContinuationEffectStep } from '@/modules/task-execution/application/drive/gateContinuationEffectStep'
import type { TaskExecutionPersistence } from '@/modules/task-execution/application/ports/taskExecutionPersistence'
import {
  TaskExecutionError,
  type GateWorkspaceRollbackExecutor,
  type GateWorkspaceRollbackOutcome,
  type GateWorkspaceRollbackPlanView,
  type GateWorkspaceRollbackRef,
  type GateWorkspaceRollbackTargetReceipt,
} from '@/modules/task-execution/public/participants'
import type { HumanGateOperationStore } from '@/modules/collaboration/application/ports/humanGateOperationStore'
import type { ClarifyContinuationConvergence } from '@/modules/collaboration/application/ports/clarifyContinuationConvergence'
import {
  humanGateComposition,
  type ValidatedWorkspaceRollbackPlanBridge as ValidatedWorkspaceRollbackPlan,
} from '@/services/humanGateComposition'
import { getTaskWriteSem } from '@/services/taskWriteLocks'
import { rollbackToSnapshot } from '@/util/git'

const { decodeReviewDecisionManifest } = humanGateComposition

type GatePreDriveContext = Parameters<InstanceType<typeof GateContinuationEffectStep>['run']>[0]

function clippedError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 2_000)
}

export class GateWorkspaceRollbackExecutorAdapter implements GateWorkspaceRollbackExecutor {
  private readonly resolvedPlans = new WeakMap<object, ValidatedWorkspaceRollbackPlan>()

  constructor(private readonly operations: Pick<HumanGateOperationStore, 'get'>) {}

  async loadValidatedPlan(ref: GateWorkspaceRollbackRef): Promise<GateWorkspaceRollbackPlanView> {
    const operation = await this.operations.get(ref.operationId)
    if (operation === null || operation.taskId !== ref.taskId) {
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

export function createGateContinuationPreDriveStep(input: {
  readonly persistence: Pick<
    TaskExecutionPersistence,
    'gateContinuationEffects' | 'gateContinuationPreDrive'
  >
  readonly humanGateOperations: Pick<HumanGateOperationStore, 'get'>
  readonly clarifyConvergence: ClarifyContinuationConvergence
}): {
  run(context: GatePreDriveContext): Promise<{ kind: 'ready' }>
} {
  const effects = new GateContinuationEffectStep(
    input.persistence.gateContinuationEffects,
    new GateWorkspaceRollbackExecutorAdapter(input.humanGateOperations),
  )
  return {
    async run(context) {
      const inspected = await input.persistence.gateContinuationPreDrive.inspect({
        taskId: context.taskId,
        intentId: context.execution.intentId,
        token: context.execution.token,
      })
      if (inspected.kind === 'clarify') {
        const clarify = inspected.continuation
        try {
          if (clarify.gateRef !== `clarify:${clarify.originNodeRunId}`) {
            throw new TaskExecutionError(
              'task-continuation-conflict',
              `clarify continuation '${context.execution.intentId}' changed its gate reference`,
            )
          }
          await input.clarifyConvergence.finish({
            operationId: clarify.operationId,
            expectedTaskId: context.taskId,
            expectedOriginNodeRunId: clarify.originNodeRunId,
            expectedContinuationRef: context.execution.intentId,
          })
          if (
            await input.persistence.gateContinuationPreDrive.hasUndispatchedClarifyWork({
              taskId: context.taskId,
              originNodeRunId: clarify.originNodeRunId,
            })
          ) {
            throw new TaskExecutionError(
              'task-execution-recovery-required',
              `clarify continuation '${context.execution.intentId}' still has undispatched durable work`,
            )
          }
        } catch (error) {
          await input.persistence.gateContinuationPreDrive.releaseClarifyForRetry({
            taskId: context.taskId,
            intentId: context.execution.intentId,
            token: context.execution.token,
            now: Date.now(),
          })
          throw error
        }
      }
      return await effects.run(context)
    },
  }
}

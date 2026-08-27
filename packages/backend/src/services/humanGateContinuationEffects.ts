// RFC-333 T8 — legacy bootstrap wiring for the gate-continuation pre-drive
// phase.  The bounded contexts meet through their purpose-specific ports; this
// file is the temporary composition bridge tracked by RFC-294 W4.

import { and, eq, inArray } from 'drizzle-orm'
import type { DbClient } from '@/db/client'
import { collaborationGateOperations, nodeRuns } from '@/db/schema'
import { decodeReviewDecisionManifest } from '@/modules/collaboration/domain/reviewDecision'
import type { ValidatedWorkspaceRollbackPlan } from '@/modules/collaboration/domain/workspaceRollbackPlan'
import { GateContinuationEffectStep } from '@/modules/task-execution/application/drive/gateContinuationEffectStep'
import type {
  GateWorkspaceRollbackExecutor,
  GateWorkspaceRollbackOutcome,
  GateWorkspaceRollbackPlanView,
  GateWorkspaceRollbackProjectionFactory,
  GateWorkspaceRollbackRef,
} from '@/modules/task-execution/application/ports/gateWorkspaceRollback'
import { taskExecutionModule } from '@/modules/task-execution/public/participants'
import { getTaskWriteSem } from '@/services/taskWriteLocks'
import { rollbackToSnapshot } from '@/util/git'

type TargetReceipt = Readonly<{
  sourceNodeRunId: string
  worktreeDirName: string
  snapshot: string
  ok: boolean
  code?: string
  message?: string
}>

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
      const targets: TargetReceipt[] = []
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

function rollbackSources(receipt: Readonly<Record<string, unknown>>): Set<string> {
  const nested = receipt.outcome
  const value =
    nested !== null && typeof nested === 'object' && !Array.isArray(nested)
      ? (nested as Readonly<Record<string, unknown>>).successfulSourceNodeRunIds
      : undefined
  if (!Array.isArray(value) || value.some((id) => typeof id !== 'string')) return new Set()
  return new Set(value as string[])
}

function projectRollbackMarker(errorMessage: string | null, rolledBack: boolean): string | null {
  if (errorMessage === null) return null
  return errorMessage.replace(
    /^(superseded-by-review-(?:rejected|iterated))(?:-rollback)?:/,
    `$1${rolledBack ? '-rollback' : ''}:`,
  )
}

export class SqliteGateWorkspaceRollbackProjectionFactory implements GateWorkspaceRollbackProjectionFactory {
  bind(tx: Parameters<GateWorkspaceRollbackProjectionFactory['bind']>[0]) {
    return {
      projectWorkspaceRollbackTx(
        input: Parameters<
          ReturnType<GateWorkspaceRollbackProjectionFactory['bind']>['projectWorkspaceRollbackTx']
        >[0],
      ) {
        if (input.gateKind !== 'review') return
        const succeeded = rollbackSources(input.receipt)
        const rows =
          input.sourceNodeRunIds.length === 0
            ? []
            : tx
                .select({ id: nodeRuns.id, errorMessage: nodeRuns.errorMessage })
                .from(nodeRuns)
                .where(
                  and(
                    eq(nodeRuns.taskId, input.taskId),
                    inArray(nodeRuns.id, [...input.sourceNodeRunIds]),
                  ),
                )
                .all()
        if (rows.length !== input.sourceNodeRunIds.length) {
          throw new Error(
            `workspace rollback projection for '${input.operationId}' lost a source row`,
          )
        }
        for (const row of rows) {
          const rolledBack = succeeded.has(row.id)
          tx.update(nodeRuns)
            .set({
              rolledBack,
              errorMessage: projectRollbackMarker(row.errorMessage, rolledBack),
            })
            .where(and(eq(nodeRuns.id, row.id), eq(nodeRuns.taskId, input.taskId)))
            .run()
        }
      },
    }
  }
}

export function createGateContinuationPreDriveStep(db: DbClient): GateContinuationEffectStep {
  return new GateContinuationEffectStep(
    db,
    taskExecutionModule.effects,
    new SqliteGateWorkspaceRollbackExecutor(db),
    new SqliteGateWorkspaceRollbackProjectionFactory(),
  )
}

import type { TaskStatus } from '@agent-workflow/shared'
import { and, eq, inArray, like } from 'drizzle-orm'
import type { DbClient } from '@/db/client'
import { nodeRuns, taskExecutionEffectAttempts, taskExecutionEffects, tasks } from '@/db/schema'
import { withTaskReviewMutationLock } from '@/services/reviewMutationCoordinator'
import type { TaskExecutionTopologyLogger } from '../application/ports/taskExecutionTopology'
import type {
  TaskDriveAttachOutcome,
  TaskDriverLifecyclePort,
} from '../application/drive/taskDriveCoordinator'
import { createTaskExecutionContext } from '../composition/sqliteTaskExecutionContext'
import {
  DEFAULT_OWNERSHIP_HEARTBEAT_MS,
  DEFAULT_OWNERSHIP_LEASE_MS,
  taskExecutionModule,
} from '../composition'
import { canonicalJson } from '../domain/executionIntent'
import {
  createVerifiedOutcomeUnknownClosure,
  createVerifiedStopProof,
  ownershipTokenKey,
  type OwnershipToken,
} from '../domain/ownership'
import { sha256Hex } from '../domain/digest'
import { TaskExecutionError } from '../application/taskExecutionError'

const DRIVER_ATTACHABLE_STATUSES: ReadonlySet<TaskStatus> = new Set(['pending', 'running'])
const ownerHeartbeatTimers = new Map<string, ReturnType<typeof setInterval>>()

export interface TaskDriverLifecycleAdapterOptions {
  readonly db: DbClient
  readonly log: TaskExecutionTopologyLogger
  readonly finalizeWorkspace: (taskId: string) => Promise<void>
}

export async function attachTaskDriver(input: {
  readonly db: DbClient
  readonly taskId: string
  readonly intentId: string
  readonly controller: AbortController
  readonly log: TaskExecutionTopologyLogger
}): Promise<TaskDriveAttachOutcome> {
  return withTaskReviewMutationLock(input.taskId, async () => {
    const row = input.db
      .select({ status: tasks.status, sourceTerminationFence: tasks.sourceTerminationFence })
      .from(tasks)
      .where(eq(tasks.id, input.taskId))
      .limit(1)
      .all()[0]
    if (
      row === undefined ||
      !DRIVER_ATTACHABLE_STATUSES.has(row.status) ||
      row.sourceTerminationFence !== null
    ) {
      return { kind: 'not-attached' }
    }

    const claimed = taskExecutionModule.claim({ db: input.db, intentId: input.intentId })
    let attached: ReturnType<typeof taskExecutionModule.runtimeRegistry.tryAttach>
    try {
      attached = taskExecutionModule.runtimeRegistry.tryAttach({
        token: claimed.token,
        intentId: input.intentId,
        permit: claimed.permit,
        controller: input.controller,
      })
    } finally {
      taskExecutionModule.claimGate.leave(claimed.permit)
    }
    if (attached !== 'attached') return { kind: 'not-attached' }

    startOwnerHeartbeat(input.db, claimed.token, input.controller, input.log)
    return {
      kind: 'attached',
      attachment: {
        execution: createTaskExecutionContext({
          intentId: input.intentId,
          token: claimed.token,
          db: input.db,
        }),
      },
    }
  })
}

function startOwnerHeartbeat(
  db: DbClient,
  token: OwnershipToken,
  controller: AbortController,
  log: TaskExecutionTopologyLogger,
): void {
  const key = ownershipTokenKey(token)
  const existing = ownerHeartbeatTimers.get(key)
  if (existing !== undefined) clearInterval(existing)
  const timer = setInterval(() => {
    try {
      taskExecutionModule.ownership.heartbeat({
        db,
        token,
        now: Date.now(),
        leaseMs: DEFAULT_OWNERSHIP_LEASE_MS,
      })
    } catch (error) {
      controller.abort('task-execution-stale-owner')
      log.warn('durable task owner heartbeat was fenced', {
        taskId: token.taskId,
        epoch: token.epoch,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }, DEFAULT_OWNERSHIP_HEARTBEAT_MS)
  timer.unref?.()
  ownerHeartbeatTimers.set(key, timer)
}

export async function releaseTaskDriverAndFinalize(input: {
  readonly db: DbClient
  readonly taskId: string
  readonly controller: AbortController
  readonly finalizeWorkspace: (taskId: string) => Promise<void>
}): Promise<void> {
  const registry = taskExecutionModule.runtimeRegistry
  const token = registry.tokenForTask(input.taskId)
  if (token === null || registry.controllerFor(token) !== input.controller) return
  const intentId = registry.intentFor(token)
  if (intentId === null) return
  const unreaped = unreapedProcessCode(input.db, input.taskId)
  if (
    !registry.release({
      token,
      controller: input.controller,
      result: unreaped === null ? { kind: 'released' } : { kind: 'unreaped', code: unreaped },
    })
  ) {
    return
  }

  const tokenKey = ownershipTokenKey(token)
  const timer = ownerHeartbeatTimers.get(tokenKey)
  if (timer !== undefined) clearInterval(timer)
  ownerHeartbeatTimers.delete(tokenKey)
  const stopResult = await registry.awaitStopped({ token, tokenKey })
  const owner = taskExecutionModule.ownership.read(input.db, input.taskId)
  if (owner !== null && owner.epoch === token.epoch) {
    if (stopResult.kind === 'released') {
      const verifiedAt = Date.now()
      const stopProof = createVerifiedStopProof({
        taskId: input.taskId,
        ownerRevision: owner.revision,
        epoch: token.epoch,
        evidenceDigest: stopResult.evidenceDigest,
        verifiedAt,
      })
      taskExecutionModule.effects.resolveQuiescedManagedProcesses({
        db: input.db,
        authority: 'exact-stop',
        token,
        expectedRevision: owner.revision,
        proof: stopProof,
        quiescenceEvidenceDigest: stopResult.evidenceDigest,
        now: verifiedAt,
      })
      const unresolvedEffectIds = [
        ...new Set(
          input.db
            .select({ effectId: taskExecutionEffects.id })
            .from(taskExecutionEffectAttempts)
            .innerJoin(
              taskExecutionEffects,
              eq(taskExecutionEffects.id, taskExecutionEffectAttempts.effectId),
            )
            .where(
              and(
                eq(taskExecutionEffects.taskId, input.taskId),
                eq(taskExecutionEffects.state, 'open'),
                inArray(taskExecutionEffectAttempts.state, [
                  'prepared',
                  'acting',
                  'recovery-required',
                ]),
              ),
            )
            .all()
            .map((row) => row.effectId),
        ),
      ].sort()
      if (unresolvedEffectIds.length > 0) {
        const quiescenceDigest = sha256Hex(
          canonicalJson({
            v: 1,
            taskId: input.taskId,
            epoch: token.epoch,
            runtimeStopEvidence: stopResult.evidenceDigest,
            unresolvedEffectIds,
          }),
        )
        taskExecutionModule.effects.closeOutcomeUnknownAndRelease({
          db: input.db,
          token,
          intentId,
          proof: createVerifiedOutcomeUnknownClosure({
            taskId: input.taskId,
            ownerRevision: owner.revision,
            epoch: token.epoch,
            quiescenceDigest,
            unresolvedEffectIds,
            verifiedAt,
          }),
          now: verifiedAt,
        })
      } else {
        taskExecutionModule.ownership.releaseAfterStop({
          db: input.db,
          token,
          intentId,
          proof: stopProof,
          now: verifiedAt,
        })
      }
    } else {
      taskExecutionModule.ownership.markRecoveryRequired({
        db: input.db,
        token,
        expectedRevision: owner.revision,
        code: stopResult.code,
        evidenceDigest: stopResult.evidenceDigest,
        now: Date.now(),
      })
    }
  }
  await input.finalizeWorkspace(input.taskId)
}

function unreapedProcessCode(db: DbClient, taskId: string): string | null {
  const row = db
    .select({ errorMessage: nodeRuns.errorMessage })
    .from(nodeRuns)
    .where(and(eq(nodeRuns.taskId, taskId), like(nodeRuns.errorMessage, '%child-unkillable%')))
    .limit(1)
    .all()[0]
  return row === undefined ? null : 'child-unkillable'
}

export function activeTaskDriverController(taskId: string): AbortController | undefined {
  const registry = taskExecutionModule.runtimeRegistry
  const token = registry.tokenForTask(taskId)
  return token === null ? undefined : (registry.controllerFor(token) ?? undefined)
}

export function isTaskDriverActive(taskId: string): boolean {
  return taskExecutionModule.runtimeRegistry.hasTask(taskId)
}

/** Wait for the current process-local owner to release without requesting a stop. */
export async function awaitTaskDriverIdle(taskId: string): Promise<void> {
  const registry = taskExecutionModule.runtimeRegistry
  const token = registry.tokenForTask(taskId)
  if (token === null) return
  const result = await registry.awaitStopped({ token, tokenKey: ownershipTokenKey(token) })
  if (result.kind === 'unreaped') {
    throw new TaskExecutionError(
      'task-execution-recovery-required',
      `task '${taskId}' owner stopped with unreaped work (${result.code})`,
    )
  }
}

/** Test isolation for the module-owned heartbeat/runtime handles. */
export function clearTaskDriverLifecycleForTesting(): void {
  for (const timer of ownerHeartbeatTimers.values()) clearInterval(timer)
  ownerHeartbeatTimers.clear()
  taskExecutionModule.runtimeRegistry.clearForTesting()
}

export function createTaskDriverLifecyclePort(
  options: TaskDriverLifecycleAdapterOptions,
): TaskDriverLifecyclePort {
  return {
    attach: async (input) =>
      await attachTaskDriver({
        db: options.db,
        taskId: input.taskId,
        intentId: input.intentId,
        controller: input.controller,
        log: options.log,
      }),
    releaseAndFinalize: async (input) =>
      await releaseTaskDriverAndFinalize({
        db: options.db,
        taskId: input.taskId,
        controller: input.controller,
        finalizeWorkspace: options.finalizeWorkspace,
      }),
  }
}

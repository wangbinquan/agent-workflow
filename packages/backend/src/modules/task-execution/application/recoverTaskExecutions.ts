// RFC-328 — same/new-daemon durable ownership recovery.

import { createHash } from 'node:crypto'
import { and, eq, inArray, ne } from '@/db/query'
import type { DbClient } from '@/db/client'
import {
  nodeRunOutputs,
  nodeRuns,
  taskExecutionEffectAttempts,
  taskExecutionEffects,
  taskExecutionOwners,
} from '@/db/schema'
import { taskExecutionModule } from '../composition'
import {
  createVerifiedOutcomeUnknownClosure,
  createVerifiedTakeoverProof,
  type ExclusiveDaemonLockProof,
  type OwnershipTuple,
} from '../domain/ownership'
import { canonicalJson } from '../domain/executionIntent'
import {
  decodeCodeHostRecoveryDescriptor,
  type CodeHostProbeOutcome,
  type CodeHostRecoveryDescriptor,
} from '../domain/codeHostRecovery'

export interface TaskExecutionRecoveryPreparation {
  readonly revokedTaskIds: readonly string[]
}

export interface TaskExecutionRecoveryFinalization {
  readonly releasedTaskIds: readonly string[]
  readonly outcomeUnknownTaskIds: readonly string[]
  readonly recoveredProcessEffectIds: readonly string[]
  readonly recoveredCodeHostEffectIds: readonly string[]
  readonly retryAuthorizedCodeHostEffectIds: readonly string[]
}

export interface TaskExecutionProcessRecoveryEvidence extends Readonly<Record<string, unknown>> {
  /** Set only after reapOrphanRuns and held-runtime-lease repair returned. */
  readonly orphanReaperCompleted: true
}

function tuple(row: typeof taskExecutionOwners.$inferSelect): OwnershipTuple {
  return {
    taskId: row.taskId,
    ownerId: row.ownerId,
    daemonGeneration: row.daemonGeneration,
    epoch: row.epoch,
  }
}

/**
 * Linearize old claimed owners behind the successor daemon's exclusive lock.
 * This runs before process/orphan probing, so no new execution generation can
 * appear while recovery is inspecting the old one.
 */
export function prepareTaskExecutionRecovery(input: {
  db: DbClient
  lockProof: ExclusiveDaemonLockProof
  now?: number
}): TaskExecutionRecoveryPreparation {
  const now = input.now ?? Date.now()
  const oldClaims = input.db
    .select()
    .from(taskExecutionOwners)
    .where(
      and(
        eq(taskExecutionOwners.state, 'claimed'),
        ne(taskExecutionOwners.daemonGeneration, input.lockProof.daemonGeneration),
      ),
    )
    .all()
  const revokedTaskIds: string[] = []
  for (const owner of oldClaims) {
    taskExecutionModule.ownership.revokeOldDaemon({
      db: input.db,
      owner: tuple(owner),
      expectedRevision: owner.revision,
      lockProof: input.lockProof,
      now,
    })
    revokedTaskIds.push(owner.taskId)
  }
  return { revokedTaskIds }
}

/**
 * Called only after the boot process reaper has completed. Known generations
 * are released for ordinary auto/manual continuation. Ambiguous external acts
 * are converted to retained requires-actor decisions; auto sends remain zero,
 * while the existing manual Resume/Retry/Sync commands can authorize N+1.
 */
export async function finalizeTaskExecutionRecovery(input: {
  db: DbClient
  lockProof: ExclusiveDaemonLockProof
  processEvidence: TaskExecutionProcessRecoveryEvidence
  codeHostProbe?: (descriptor: CodeHostRecoveryDescriptor) => Promise<CodeHostProbeOutcome>
  now?: number
}): Promise<TaskExecutionRecoveryFinalization> {
  if (input.processEvidence.orphanReaperCompleted !== true) {
    throw new Error('task execution recovery requires a completed orphan-process barrier')
  }
  const now = input.now ?? Date.now()
  const candidates = input.db
    .select()
    .from(taskExecutionOwners)
    .where(
      and(
        inArray(taskExecutionOwners.state, ['revoked', 'recovery-required']),
        ne(taskExecutionOwners.daemonGeneration, input.lockProof.daemonGeneration),
      ),
    )
    .all()
  const releasedTaskIds: string[] = []
  const outcomeUnknownTaskIds: string[] = []
  const recoveredProcessEffectIds: string[] = []
  const recoveredCodeHostEffectIds: string[] = []
  const retryAuthorizedCodeHostEffectIds: string[] = []
  for (const owner of candidates) {
    const oldOwner = tuple(owner)
    const preResolutionEffectIds = [
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
              eq(taskExecutionEffects.taskId, owner.taskId),
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
    const processEvidenceDigest = createHash('sha256')
      .update(
        canonicalJson({
          v: 1,
          taskId: owner.taskId,
          oldOwner,
          successorGeneration: input.lockProof.daemonGeneration,
          lockReceiptDigest: input.lockProof.lockReceiptDigest,
          processEvidence: input.processEvidence,
          preResolutionEffectIds,
        }),
      )
      .digest('hex')
    const processResolution = taskExecutionModule.effects.resolveQuiescedManagedProcesses({
      db: input.db,
      authority: 'successor-daemon',
      owner: oldOwner,
      expectedRevision: owner.revision,
      lockProof: input.lockProof,
      quiescenceEvidenceDigest: processEvidenceDigest,
      now,
    })
    recoveredProcessEffectIds.push(...processResolution.resolvedEffectIds)

    const codeHostCandidates = input.db
      .select({
        effectId: taskExecutionEffects.id,
        attemptId: taskExecutionEffectAttempts.id,
        recoveryDescriptorJson: taskExecutionEffectAttempts.recoveryDescriptorJson,
      })
      .from(taskExecutionEffectAttempts)
      .innerJoin(
        taskExecutionEffects,
        eq(taskExecutionEffects.id, taskExecutionEffectAttempts.effectId),
      )
      .where(
        and(
          eq(taskExecutionEffects.taskId, owner.taskId),
          eq(taskExecutionEffects.kind, 'code-host-mutation'),
          eq(taskExecutionEffects.state, 'open'),
          eq(taskExecutionEffectAttempts.epoch, owner.epoch),
          inArray(taskExecutionEffectAttempts.state, ['acting', 'recovery-required']),
        ),
      )
      .all()
      .sort(
        (left, right) =>
          left.effectId.localeCompare(right.effectId) ||
          left.attemptId.localeCompare(right.attemptId),
      )
    const probed = await Promise.all(
      codeHostCandidates.map(async (candidate) => {
        if (candidate.recoveryDescriptorJson === null || input.codeHostProbe === undefined) {
          return null
        }
        let descriptor: CodeHostRecoveryDescriptor
        try {
          descriptor = decodeCodeHostRecoveryDescriptor(candidate.recoveryDescriptorJson)
        } catch {
          return null
        }
        if (descriptor.probe.kind === 'actor-replay') return null
        let probe: CodeHostProbeOutcome
        try {
          probe = await input.codeHostProbe(descriptor)
        } catch {
          return null
        }
        if (probe.kind === 'unknown') return null
        return {
          effectId: candidate.effectId,
          attemptId: candidate.attemptId,
          outcome: probe.kind,
          receiptJson: JSON.stringify({
            v: 1,
            recovery: 'successor-daemon-code-host-probe',
            proofCode: probe.proofCode,
            responseStatus: probe.responseStatus,
          }),
          nodeRunId: descriptor.nodeRunId,
          responseStatus: probe.responseStatus,
          responseBody: probe.responseBody,
          evidence: {
            effectId: candidate.effectId,
            attemptId: candidate.attemptId,
            descriptor,
            outcome: probe.kind,
            proofCode: probe.proofCode,
            responseStatus: probe.responseStatus,
          },
        } as const
      }),
    )
    const knownProbeResults = probed.filter(
      (result): result is Exclude<(typeof probed)[number], null> => result !== null,
    )
    const codeHostEvidenceDigest = createHash('sha256')
      .update(
        canonicalJson({
          v: 1,
          taskId: owner.taskId,
          processEvidenceDigest,
          probeResults: knownProbeResults.map((result) => result.evidence),
        }),
      )
      .digest('hex')
    const codeHostResolution = taskExecutionModule.effects.resolveQuiescedCodeHostMutations({
      db: input.db,
      owner: oldOwner,
      expectedRevision: owner.revision,
      lockProof: input.lockProof,
      quiescenceEvidenceDigest: codeHostEvidenceDigest,
      resolutions: knownProbeResults.map(({ evidence: _evidence, ...resolution }) => resolution),
      onAppliedTx(tx, resolution) {
        if (resolution.nodeRunId === null) return
        const run = tx
          .select({ id: nodeRuns.id, status: nodeRuns.status })
          .from(nodeRuns)
          .where(and(eq(nodeRuns.id, resolution.nodeRunId), eq(nodeRuns.taskId, owner.taskId)))
          .get()
        if (run === undefined || (run.status !== 'interrupted' && run.status !== 'running')) {
          throw new Error(
            `code-host recovery node '${resolution.nodeRunId}' is not an interrupted run`,
          )
        }
        for (const value of [
          {
            nodeRunId: resolution.nodeRunId,
            portName: 'response',
            content: resolution.responseBody,
          },
          {
            nodeRunId: resolution.nodeRunId,
            portName: 'status',
            content: String(resolution.responseStatus),
          },
        ]) {
          tx.insert(nodeRunOutputs)
            .values(value)
            .onConflictDoUpdate({
              target: [nodeRunOutputs.nodeRunId, nodeRunOutputs.portName],
              set: { content: value.content },
            })
            .run()
        }
        const projected = tx
          .update(nodeRuns)
          .set({
            status: 'done',
            finishedAt: now,
            errorMessage: null,
            failureCode: null,
          })
          .where(
            and(
              eq(nodeRuns.id, resolution.nodeRunId),
              eq(nodeRuns.taskId, owner.taskId),
              inArray(nodeRuns.status, ['interrupted', 'running']),
            ),
          )
          .returning({ id: nodeRuns.id })
          .get()
        if (projected === undefined) {
          throw new Error(`code-host recovery node '${resolution.nodeRunId}' projection lost`)
        }
      },
      now,
    })
    recoveredCodeHostEffectIds.push(...codeHostResolution.appliedEffectIds)
    retryAuthorizedCodeHostEffectIds.push(...codeHostResolution.retryAuthorizedEffectIds)

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
              eq(taskExecutionEffects.taskId, owner.taskId),
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
    const evidenceDigest = createHash('sha256')
      .update(
        canonicalJson({
          v: 2,
          taskId: owner.taskId,
          oldOwner,
          successorGeneration: input.lockProof.daemonGeneration,
          lockReceiptDigest: input.lockProof.lockReceiptDigest,
          processEvidenceDigest,
          recoveredProcessEffectIds: processResolution.resolvedEffectIds,
          recoveredCodeHostEffectIds: codeHostResolution.appliedEffectIds,
          retryAuthorizedCodeHostEffectIds: codeHostResolution.retryAuthorizedEffectIds,
          codeHostEvidenceDigest,
          unresolvedEffectIds,
        }),
      )
      .digest('hex')
    if (unresolvedEffectIds.length > 0) {
      taskExecutionModule.effects.closeRecoveredOutcomeUnknownAndRelease({
        db: input.db,
        owner: oldOwner,
        expectedRevision: owner.revision,
        lockProof: input.lockProof,
        proof: createVerifiedOutcomeUnknownClosure({
          taskId: owner.taskId,
          ownerRevision: owner.revision,
          epoch: owner.epoch,
          quiescenceDigest: evidenceDigest,
          unresolvedEffectIds,
          verifiedAt: now,
        }),
        now,
      })
      outcomeUnknownTaskIds.push(owner.taskId)
      continue
    }
    taskExecutionModule.ownership.releaseRecovered({
      db: input.db,
      owner: oldOwner,
      expectedRevision: owner.revision,
      proof: createVerifiedTakeoverProof({
        taskId: owner.taskId,
        oldOwnerRevision: owner.revision,
        oldEpoch: owner.epoch,
        evidenceDigest,
        verifiedAt: now,
      }),
      now,
    })
    releasedTaskIds.push(owner.taskId)
  }
  return {
    releasedTaskIds,
    outcomeUnknownTaskIds,
    recoveredProcessEffectIds: [...new Set(recoveredProcessEffectIds)].sort(),
    recoveredCodeHostEffectIds: [...new Set(recoveredCodeHostEffectIds)].sort(),
    retryAuthorizedCodeHostEffectIds: [...new Set(retryAuthorizedCodeHostEffectIds)].sort(),
  }
}

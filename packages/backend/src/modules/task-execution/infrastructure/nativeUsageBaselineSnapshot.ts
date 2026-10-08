import { nativeUsageEvidenceStorage } from './nativeUsageEvidenceStorage'
import { and, eq, inArray } from 'drizzle-orm'
import {
  ObservationNativePassCompletionSchema,
  ObservationNativePassAckSchema,
  type ObservationNativeBeforeSpawnAck,
  type ObservationNativePassCompletion,
} from '@agent-workflow/shared'

import type { ProviderNeutralDatabase } from '@/db/query'
import type { ReportSnapshotSession } from '@/platform/persistence/reportSnapshotTypes'
import { chunkedAll } from '@/util/sqlChunk'
import type {
  NativeUsageExecutionOwnerBinding as NativeUsageOwnerBinding,
  NativeUsageReadBinding,
} from '../application/ports/nativeUsagePersistence'
import type { NativeUsageBaselineReadView } from '../application/ports/nativeUsageBaseline'
import { verifyNativeUsagePass } from './nativeUsagePassVerification'

/** Obtain a small reference from the original admitted relations; never cache a population. */
export async function originalNativeUsageBaseline(input: {
  readonly db: ProviderNeutralDatabase
  readonly binding: NativeUsageOwnerBinding
  readonly before: ObservationNativeBeforeSpawnAck
}): Promise<ObservationNativePassCompletion | null> {
  const { nativeUsagePasses, nativeUsagePassHeads } = nativeUsageEvidenceStorage(
    input.binding.sourceKind,
  )

  const before = input.before
  if (before.mode !== 'resume') return null
  const key = JSON.stringify([
    input.binding.invocationId,
    before.nativeSource,
    before.sourceGeneration,
    before.rootSessionId,
    before.lineage,
    before.epoch,
    'baseline',
  ])
  const row = (
    await input.db
      .select({ pass: nativeUsagePasses })
      .from(nativeUsagePassHeads)
      .innerJoin(nativeUsagePasses, eq(nativeUsagePasses.passId, nativeUsagePassHeads.passId))
      .where(eq(nativeUsagePassHeads.key, key))
      .limit(1)
  )[0]?.pass
  if (!row || row.state !== 'eof' || row.lastAck === null) return null
  if (row.invocationId !== input.binding.invocationId || row.headKey !== key)
    throw new Error('Original native before reference changed its accepted owner')
  const ack = ObservationNativePassAckSchema.parse(JSON.parse(row.lastAck))
  const identity = ack.identity
  if (
    identity.invocationId !== input.binding.invocationId ||
    identity.phase !== 'baseline' ||
    identity.nativeSource !== before.nativeSource ||
    identity.sourceGeneration !== before.sourceGeneration ||
    identity.rootSessionId !== before.rootSessionId ||
    identity.lineage !== before.lineage ||
    identity.epoch !== before.epoch ||
    ack.eof === null ||
    ack.nextCursor !== null
  )
    throw new Error('Original native before reference changed its preparation or EOF')
  return ObservationNativePassCompletionSchema.parse({ ack, pageCount: row.nextOrdinal })
}

/** Keep the actual original before index snapshot alive across final-page commits.
 * A later missing live membership cannot make an original before step look new.
 * This uses the existing separate report read channel, never a whole-tree array or cached header.
 * Callers select this only for separate-channel file/PG deployments; one-connection memory
 * deployments keep the existing per-page full verification instead of nesting positive ACKs.
 */
export async function withNativeUsageBaselineSnapshot<T>(input: {
  readonly snapshots: ReportSnapshotSession
  readonly binding: NativeUsageReadBinding
  readonly original: ObservationNativePassCompletion
  readonly signal?: AbortSignal
  readonly run: (baseline: NativeUsageBaselineReadView | null) => Promise<T>
}): Promise<T> {
  const { nativeUsageStepMembers } = nativeUsageEvidenceStorage(input.binding.sourceKind)

  const original = ObservationNativePassCompletionSchema.parse(input.original)
  if (original.ack.identity.phase !== 'baseline')
    throw new Error('Native before snapshot requires the original baseline')
  return input.snapshots.run(async (snapshot) => {
    const verified = await verifyNativeUsagePass(snapshot.executor, input.binding, original, true)
    if (verified.hasPopulationIssues) return input.run(null)
    let active = true
    try {
      return await input.run({
        original,
        snapshotId: snapshot.snapshotId,
        databaseGeneration: snapshot.generationId,
        async members(stepIds) {
          input.signal?.throwIfAborted()
          if (!active) throw new Error('Original native before index snapshot is already closed')
          if (stepIds.length > 1000)
            throw new RangeError('Native before lookup exceeds one transport packet')
          const rows = await chunkedAll([...new Set(stepIds)], (ids) =>
            snapshot.executor
              .select({ stepId: nativeUsageStepMembers.stepId })
              .from(nativeUsageStepMembers)
              .where(
                and(
                  eq(nativeUsageStepMembers.passId, original.ack.identity.passId),
                  inArray(nativeUsageStepMembers.stepId, ids),
                ),
              ),
          )
          if (!active) throw new Error('Original native before index snapshot closed while reading')
          return new Set(rows.map((row) => row.stepId))
        },
      })
    } finally {
      active = false
    }
  }, input.signal)
}

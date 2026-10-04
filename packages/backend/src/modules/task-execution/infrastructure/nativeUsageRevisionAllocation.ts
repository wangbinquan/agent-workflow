import { and, asc, eq, gt, max } from 'drizzle-orm'
import {
  nativeUsageRevisionHeads,
  observationUsageEvents,
  observationUsageSources,
  taskExecutionObservationSources,
} from '@/db/schema'
import { engineOf } from '@/platform/persistence/databaseTransaction'
import { sha256Hex } from '@/util/hash'
import type {
  NativeUsageEvidence,
  NativeUsageOwnerBinding,
} from '../application/ports/nativeUsagePersistence'
import type { TaskExecutionTransaction } from './ownedTaskExecution'

// These are allocation keys, never native record identities or a second numeric ledger.
const recordKey = (recordId: string) => 'record:' + sha256Hex(recordId)
const sourceCheckpoint = 'source-watermark'

async function rememberRevision(
  tx: TaskExecutionTransaction,
  invocationId: string,
  id: string,
  revision: number,
): Promise<void> {
  if (!Number.isSafeInteger(revision) || revision < 0)
    throw new Error('Original native revision is not exact')
  const where = and(
    eq(nativeUsageRevisionHeads.invocationId, invocationId),
    eq(nativeUsageRevisionHeads.recordId, id),
  )
  const prior = (await tx.select().from(nativeUsageRevisionHeads).where(where).limit(1))[0]
  if (prior && prior.revision >= revision) return
  await tx
    .insert(nativeUsageRevisionHeads)
    .values({ invocationId, recordId: id, revision })
    .onConflictDoUpdate({
      target: [nativeUsageRevisionHeads.invocationId, nativeUsageRevisionHeads.recordId],
      set: { revision },
    })
    .run()
}

/** Serialize with the original projection and historical repair, after the Task/node locks. */
export async function lockOriginalNativeUsageSource(
  tx: TaskExecutionTransaction,
  nodeRunId: string,
): Promise<string> {
  const sourceId = 'local-node:' + nodeRunId
  await tx.insert(observationUsageSources).values({ sourceId }).onConflictDoNothing().run()
  await engineOf(tx).lockAggregateRoot(
    tx,
    observationUsageSources,
    observationUsageSources.sourceId,
    sourceId,
  )
  return sourceId
}

/**
 * Read every original source through EOF, including rows already acknowledged by projection.
 * The checkpoint makes each retained source row enter the allocation index once per invocation.
 * It is advanced only in the same original transaction as the numeric source append.
 */
async function indexOriginalNativeRevisions(
  tx: TaskExecutionTransaction,
  binding: NativeUsageOwnerBinding,
): Promise<void> {
  const checkpoint = (
    await tx
      .select({ revision: nativeUsageRevisionHeads.revision })
      .from(nativeUsageRevisionHeads)
      .where(
        and(
          eq(nativeUsageRevisionHeads.invocationId, binding.invocationId),
          eq(nativeUsageRevisionHeads.recordId, sourceCheckpoint),
        ),
      )
      .limit(1)
  )[0]
  let after = checkpoint?.revision ?? 0
  while (true) {
    const rows = await tx
      .select({
        id: taskExecutionObservationSources.id,
        document: taskExecutionObservationSources.evidenceJson,
      })
      .from(taskExecutionObservationSources)
      .where(
        and(
          eq(taskExecutionObservationSources.nodeRunId, binding.nodeRunId),
          gt(taskExecutionObservationSources.id, after),
        ),
      )
      .orderBy(asc(taskExecutionObservationSources.id))
      .limit(200)
      .all()
    if (!rows.length) break
    for (const row of rows) {
      if (!Number.isSafeInteger(row.id) || row.id <= after)
        throw new Error('Original native revision source did not advance')
      const evidence = JSON.parse(row.document) as NativeUsageEvidence
      if (evidence.invocationId === binding.invocationId) {
        for (const measurement of evidence.measurements) {
          if (
            measurement.invocationId !== binding.invocationId ||
            typeof measurement.recordId !== 'string' ||
            !Number.isSafeInteger(measurement.revision) ||
            measurement.revision < 1
          )
            throw new Error('Original native pending revision changed its binding')
          await rememberRevision(
            tx,
            binding.invocationId,
            recordKey(measurement.recordId),
            measurement.revision,
          )
        }
      }
      after = row.id
    }
  }
  await rememberRevision(tx, binding.invocationId, sourceCheckpoint, after)
}

/** Caller holds the original source lock; observed, pending and frozen originals all participate. */
export async function allocateOriginalNativeRevisions(
  tx: TaskExecutionTransaction,
  binding: NativeUsageOwnerBinding,
  sourceId: string,
  measurements: NativeUsageEvidence['measurements'],
): Promise<NativeUsageEvidence['measurements']> {
  if (sourceId !== 'local-node:' + binding.nodeRunId)
    throw new Error('Original native revision source changed')
  await indexOriginalNativeRevisions(tx, binding)
  const allocated: NativeUsageEvidence['measurements'][number][] = []
  for (const measurement of measurements) {
    if (
      measurement.invocationId !== binding.invocationId ||
      measurement.taskId !== binding.taskId ||
      measurement.nodeRunId !== binding.nodeRunId ||
      !Number.isSafeInteger(measurement.revision) ||
      measurement.revision < 1
    )
      throw new Error('Original native emission changed its binding')
    const id = recordKey(measurement.recordId)
    const frozen = (
      await tx
        .select({ revision: nativeUsageRevisionHeads.revision })
        .from(nativeUsageRevisionHeads)
        .where(
          and(
            eq(nativeUsageRevisionHeads.invocationId, binding.invocationId),
            eq(nativeUsageRevisionHeads.recordId, id),
          ),
        )
        .limit(1)
    )[0]
    const observed = (
      await tx
        .select({ revision: max(observationUsageEvents.revision) })
        .from(observationUsageEvents)
        .where(
          eq(
            observationUsageEvents.recordKey,
            sha256Hex(JSON.stringify([sourceId, binding.invocationId, measurement.recordId])),
          ),
        )
    )[0]
    const highWater = Math.max(frozen?.revision ?? 0, observed?.revision ?? 0)
    const revision = Math.max(measurement.revision, highWater + 1)
    if (!Number.isSafeInteger(revision) || revision < 1)
      throw new Error('Original native revision exhausted its exact integer representation')
    await rememberRevision(tx, binding.invocationId, id, revision)
    allocated.push({ ...measurement, revision })
  }
  return allocated
}

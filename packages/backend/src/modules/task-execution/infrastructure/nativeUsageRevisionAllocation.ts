import { nativeUsageEvidenceStorage } from './nativeUsageEvidenceStorage'
import { and, asc, eq, gt, inArray, max, sql } from 'drizzle-orm'
import { observationUsageEvents, observationUsageSources } from '@/db/schema'
import { engineOf } from '@/platform/persistence/databaseTransaction'
import { insertInBatches } from '@/platform/persistence/batchInsert'
import { sha256Hex } from '@/util/hash'
import { chunkedAll } from '@/util/sqlChunk'
import type {
  NativeUsageEvidence,
  NativeUsageExecutionOwnerBinding as NativeUsageOwnerBinding,
} from '../application/ports/nativeUsagePersistence'
import type { TaskExecutionTransaction } from './ownedTaskExecution'

// These are allocation keys, never native record identities or a second numeric ledger.
const recordKey = (recordId: string) => 'record:' + sha256Hex(recordId)
export const nativeUsageRecordSourceKey = (recordId: string) => 'source:' + sha256Hex(recordId)
const sourceCheckpoint = 'source-watermark'

async function rememberRevisions(
  tx: TaskExecutionTransaction,
  invocationId: string,
  values: ReadonlyMap<string, number>,
  sourceKind: 'task' | 'system' = 'task',
): Promise<void> {
  const { nativeUsageRevisionHeads } = nativeUsageEvidenceStorage(sourceKind)

  const rows = [...values].map(([recordId, revision]) => {
    if (!Number.isSafeInteger(revision) || revision < 0)
      throw new Error('Original native revision is not exact')
    return { invocationId, recordId, revision }
  })
  await insertInBatches(tx, nativeUsageRevisionHeads, rows, (batch) =>
    tx
      .insert(nativeUsageRevisionHeads)
      .values([...batch])
      .onConflictDoUpdate({
        target: [nativeUsageRevisionHeads.invocationId, nativeUsageRevisionHeads.recordId],
        set: {
          revision: sql`CASE WHEN ${nativeUsageRevisionHeads.revision} < excluded.revision
        THEN excluded.revision ELSE ${nativeUsageRevisionHeads.revision} END`,
        },
      })
      .run(),
  )
}

/** Original source row locators only; numeric authority remains the original source/ledger. */
export async function rememberOriginalNativeSources(
  tx: TaskExecutionTransaction,
  invocationId: string,
  measurements: NativeUsageEvidence['measurements'],
  sourceRowId: number,
  sourceKind: 'task' | 'system' = 'task',
): Promise<void> {
  if (!Number.isSafeInteger(sourceRowId) || sourceRowId < 1)
    throw new Error('Original native source row is not exact')
  await rememberRevisions(
    tx,
    invocationId,
    new Map(
      measurements.map((measurement) => [
        nativeUsageRecordSourceKey(measurement.recordId),
        sourceRowId,
      ]),
    ),
    sourceKind,
  )
}

/** Serialize with the original projection and historical repair, after the Task/node locks. */
export async function lockOriginalNativeUsageSource(
  tx: TaskExecutionTransaction,
  nodeRunId: string,
  sourceKind: 'task' | 'system' = 'task',
): Promise<string> {
  const { sourcePrefix } = nativeUsageEvidenceStorage(sourceKind)
  const sourceId = sourcePrefix + nodeRunId
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
  const { nativeUsageRevisionHeads, taskExecutionObservationSources } = nativeUsageEvidenceStorage(
    binding.sourceKind,
  )

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
        const revisions = new Map<string, number>()
        for (const measurement of evidence.measurements) {
          if (
            measurement.invocationId !== binding.invocationId ||
            typeof measurement.recordId !== 'string' ||
            !Number.isSafeInteger(measurement.revision) ||
            measurement.revision < 1
          )
            throw new Error('Original native pending revision changed its binding')
          const key = recordKey(measurement.recordId)
          revisions.set(key, Math.max(revisions.get(key) ?? 0, measurement.revision))
        }
        await rememberRevisions(tx, binding.invocationId, revisions, binding.sourceKind)
        await rememberOriginalNativeSources(
          tx,
          binding.invocationId,
          evidence.measurements,
          row.id,
          binding.sourceKind,
        )
      }
      after = row.id
    }
  }
  await rememberRevisions(
    tx,
    binding.invocationId,
    new Map([[sourceCheckpoint, after]]),
    binding.sourceKind,
  )
}

/** Caller holds the original source lock; observed, pending and frozen originals all participate. */
export async function allocateOriginalNativeRevisions(
  tx: TaskExecutionTransaction,
  binding: NativeUsageOwnerBinding,
  sourceId: string,
  measurements: NativeUsageEvidence['measurements'],
): Promise<NativeUsageEvidence['measurements']> {
  const { nativeUsageRevisionHeads, sourcePrefix } = nativeUsageEvidenceStorage(binding.sourceKind)

  if (sourceId !== sourcePrefix + binding.nodeRunId)
    throw new Error('Original native revision source changed')
  await indexOriginalNativeRevisions(tx, binding)
  const keys = [...new Set(measurements.map((measurement) => recordKey(measurement.recordId)))]
  const heads = new Map(
    (
      await chunkedAll(keys, (ids) =>
        tx
          .select()
          .from(nativeUsageRevisionHeads)
          .where(
            and(
              eq(nativeUsageRevisionHeads.invocationId, binding.invocationId),
              inArray(nativeUsageRevisionHeads.recordId, ids),
            ),
          ),
      )
    ).map((row) => [row.recordId, row.revision]),
  )
  const observedKeys = [
    ...new Set(
      measurements.map((measurement) =>
        sha256Hex(JSON.stringify([sourceId, binding.invocationId, measurement.recordId])),
      ),
    ),
  ]
  const observed = new Map(
    (
      await chunkedAll(observedKeys, (ids) =>
        tx
          .select({
            key: observationUsageEvents.recordKey,
            revision: max(observationUsageEvents.revision),
          })
          .from(observationUsageEvents)
          .where(inArray(observationUsageEvents.recordKey, ids))
          .groupBy(observationUsageEvents.recordKey),
      )
    ).map((row) => [row.key, row.revision ?? 0]),
  )
  const allocated: NativeUsageEvidence['measurements'][number][] = []
  const revisions = new Map<string, number>()
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
    const observedKey = sha256Hex(
      JSON.stringify([sourceId, binding.invocationId, measurement.recordId]),
    )
    const highWater = Math.max(heads.get(id) ?? 0, observed.get(observedKey) ?? 0)
    const revision = Math.max(measurement.revision, highWater + 1)
    if (!Number.isSafeInteger(revision) || revision < 1)
      throw new Error('Original native revision exhausted its exact integer representation')
    heads.set(id, revision)
    revisions.set(id, revision)
    allocated.push({ ...measurement, revision })
  }
  await rememberRevisions(tx, binding.invocationId, revisions, binding.sourceKind)
  return allocated
}

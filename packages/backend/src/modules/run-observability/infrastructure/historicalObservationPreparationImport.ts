import { createHash } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import { observationCalculationRows, observationCalculationVersions } from '@/db/schema'
import type { DatabaseTransaction } from '@/platform/persistence/databaseTransaction'
import { CompleteCalculationInvalid } from '../domain/completeCalculationFacts'
import {
  HISTORICAL_PREPARATION_GROUPS,
  parseHistoricalPreparationGroup,
} from '../domain/historicalObservationPreparation'
import type { CompleteCalculationFactItem } from '../ports/completeCalculationFacts'
import type {
  HistoricalObservationPreparationItem,
  HistoricalObservationPreparationVersion,
} from '../ports/historicalObservationPreparation'
import { updateCalculationRowDigest } from './completeCalculationFactReader'

/** One immutable preparation commits with its complete index and rows, never a partial head. */
export async function importHistoricalObservationPreparation(input: {
  readonly tx: DatabaseTransaction
  readonly iterator: Iterator<CompleteCalculationFactItem | HistoricalObservationPreparationItem>
  readonly version: HistoricalObservationPreparationVersion
  readonly signal?: AbortSignal
}) {
  const { tx, version, iterator } = input
  await tx
    .delete(observationCalculationVersions)
    .where(eq(observationCalculationVersions.cacheKey, version.cacheKey))
    .run()
  await tx
    .insert(observationCalculationVersions)
    .values({
      cacheKey: version.cacheKey,
      sourceKey: version.sourceKey,
      document: JSON.stringify(version),
    })
    .run()
  let batch: (typeof observationCalculationRows.$inferInsert)[] = []
  const flush = async () => {
    if (!batch.length) return
    await tx.insert(observationCalculationRows).values(batch).run()
    batch = []
  }
  const read = () => {
    input.signal?.throwIfAborted()
    const next = iterator.next()
    if (
      next.done ||
      next.value.kind !== 'row' ||
      next.value.cacheKey !== version.cacheKey ||
      !next.value.key
    )
      throw new CompleteCalculationInvalid('Historical preparation row missing')
    return next.value
  }
  const append = async (row: ReturnType<typeof read>) => {
    batch.push({
      cacheKey: version.cacheKey,
      namespace: row.namespace,
      key: row.key,
      document: JSON.stringify(row.document),
    })
    if (batch.length >= 200) await flush()
  }
  let previousGroup: string | null = null,
    declaredRows = 0n
  const groupsHash = createHash('sha256')
  for (let group = 0n; group < BigInt(version.groups); group++) {
    const row = read()
    if (
      row.namespace !== HISTORICAL_PREPARATION_GROUPS ||
      (previousGroup !== null && row.key <= previousGroup)
    )
      throw new CompleteCalculationInvalid('Historical preparation group index order changed')
    const declaration = parseHistoricalPreparationGroup(row.key, row.document)
    declaredRows += BigInt(declaration.rows)
    updateCalculationRowDigest(groupsHash, row.key, row.document)
    previousGroup = row.key
    await append(row)
  }
  await flush()
  const population = BigInt(version.rows) - BigInt(version.groups)
  if (declaredRows !== population || groupsHash.digest('hex') !== version.groupDigest)
    throw new CompleteCalculationInvalid('Historical preparation group index EOF incomplete')
  for (const name of ['/executions', '/roots', '/native-records', '/receipts', '/root-results']) {
    const declaration = await tx
      .select()
      .from(observationCalculationRows)
      .where(
        and(
          eq(observationCalculationRows.cacheKey, version.cacheKey),
          eq(observationCalculationRows.namespace, HISTORICAL_PREPARATION_GROUPS),
          eq(observationCalculationRows.key, name),
        ),
      )
      .get()
    if (!declaration)
      throw new CompleteCalculationInvalid('Historical preparation original namespace missing')
  }
  let previous: { namespace: string; key: string } | null = null,
    groupRows = 0n,
    hash = createHash('sha256'),
    expected: ReturnType<typeof parseHistoricalPreparationGroup> | null = null
  const finish = () => {
    if (expected === null) return
    if (String(groupRows) !== expected.rows || hash.digest('hex') !== expected.digest)
      throw new CompleteCalculationInvalid('Historical preparation original group incomplete')
  }
  const readPrevious = (): { namespace: string; key: string } | null => previous
  for (let ordinal = 0n; ordinal < population; ordinal++) {
    const row = read()
    if (
      row.namespace === HISTORICAL_PREPARATION_GROUPS ||
      (previous &&
        (row.namespace < previous.namespace ||
          (row.namespace === previous.namespace && row.key <= previous.key)))
    )
      throw new CompleteCalculationInvalid('Historical preparation original row order changed')
    if (row.namespace !== readPrevious()?.namespace) {
      finish()
      const declaration = await tx
        .select()
        .from(observationCalculationRows)
        .where(
          and(
            eq(observationCalculationRows.cacheKey, version.cacheKey),
            eq(observationCalculationRows.namespace, HISTORICAL_PREPARATION_GROUPS),
            eq(observationCalculationRows.key, row.namespace),
          ),
        )
        .get()
      let document: unknown
      try {
        document = declaration && JSON.parse(declaration.document)
      } catch {
        throw new CompleteCalculationInvalid('Historical preparation declaration cannot be decoded')
      }
      expected = parseHistoricalPreparationGroup(row.namespace, document)
      groupRows = 0n
      hash = createHash('sha256')
    }
    updateCalculationRowDigest(hash, row.key, row.document)
    groupRows++
    previous = { namespace: row.namespace, key: row.key }
    await append(row)
  }
  finish()
  await flush()
  const next = iterator.next()
  if (!next.done && next.value.kind !== 'version')
    throw new CompleteCalculationInvalid('Historical preparation extra row')
  return { rows: BigInt(version.rows), next }
}

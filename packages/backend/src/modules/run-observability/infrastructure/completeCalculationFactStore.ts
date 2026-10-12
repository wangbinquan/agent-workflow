import { createHash } from 'node:crypto'
import { eq } from 'drizzle-orm'
import type { ProviderNeutralDatabase } from '@/db/query'
import { observationCalculationRows, observationCalculationVersions } from '@/db/schema'
import { databaseSessionFor } from '@/platform/persistence/databaseTransaction'
import {
  calculationSourceKey,
  CompleteCalculationInvalid,
  parseTaskCalculationVersion,
} from '../domain/completeCalculationFacts'
import type {
  CompleteCalculationFactManifest,
  CompleteCalculationFactSpool,
  CompleteCalculationFactItem,
} from '../ports/completeCalculationFacts'
import { updateCalculationRowDigest } from './completeCalculationFactReader'

function* items(
  spool: CompleteCalculationFactSpool,
  manifest: CompleteCalculationFactManifest,
  signal?: AbortSignal,
): Generator<CompleteCalculationFactItem> {
  for (const packet of spool.pages(manifest, signal)) yield* packet.items
}

/** Atomic immutable versions are imported only after the original read reservation is released. */
export async function importCompleteTaskCalculations(input: {
  readonly db: ProviderNeutralDatabase
  readonly spool: CompleteCalculationFactSpool
  readonly manifest: CompleteCalculationFactManifest
  readonly signal?: AbortSignal
}) {
  for (const _packet of input.spool.pages(input.manifest, input.signal))
    input.signal?.throwIfAborted()
  const sourceKey = calculationSourceKey(input.manifest.context)
  const iterator = items(input.spool, input.manifest, input.signal)
  let next = iterator.next(),
    imported = 0n,
    population = 0n
  while (!next.done) {
    input.signal?.throwIfAborted()
    if (next.value.kind !== 'version')
      throw new CompleteCalculationInvalid('Task calculation header missing')
    const version = parseTaskCalculationVersion(
      next.value.version,
      sourceKey,
      next.value.version.cacheKey,
    )
    await databaseSessionFor(input.db).transaction(async (tx) => {
      await tx
        .delete(observationCalculationVersions)
        .where(eq(observationCalculationVersions.cacheKey, version.cacheKey))
        .run()
      await tx
        .insert(observationCalculationVersions)
        .values({ cacheKey: version.cacheKey, sourceKey, document: JSON.stringify(version) })
        .run()
      let count = 0n
      for (const group of version.groups) {
        const hash = createHash('sha256')
        let previous: string | null = null
        let batch: (typeof observationCalculationRows.$inferInsert)[] = []
        const flush = async () => {
          if (!batch.length) return
          await tx.insert(observationCalculationRows).values(batch).run()
          batch = []
        }
        for (let ordinal = 0n; ordinal < BigInt(group.rows); ordinal++) {
          input.signal?.throwIfAborted()
          const item = iterator.next()
          if (
            item.done ||
            item.value.kind !== 'row' ||
            item.value.cacheKey !== version.cacheKey ||
            item.value.namespace !== group.namespace ||
            !item.value.key ||
            (previous !== null && item.value.key <= previous)
          )
            throw new CompleteCalculationInvalid('Task calculation complete group changed')
          updateCalculationRowDigest(hash, item.value.key, item.value.document)
          previous = item.value.key
          batch.push({
            cacheKey: version.cacheKey,
            namespace: group.namespace,
            key: item.value.key,
            document: JSON.stringify(item.value.document),
          })
          count++
          if (batch.length >= 200) await flush()
        }
        await flush()
        if (hash.digest('hex') !== group.digest)
          throw new CompleteCalculationInvalid('Task calculation group content changed')
      }
      if (String(count) !== version.rows)
        throw new CompleteCalculationInvalid('Task calculation version EOF incomplete')
      next = iterator.next()
      if (!next.done && next.value.kind !== 'version')
        throw new CompleteCalculationInvalid('Task calculation extra row')
      input.signal?.throwIfAborted()
      population += count
    })
    imported++
  }
  if (String(imported) !== input.manifest.versions || String(population) !== input.manifest.rows)
    throw new CompleteCalculationInvalid('Task calculation manifest EOF incomplete')
}

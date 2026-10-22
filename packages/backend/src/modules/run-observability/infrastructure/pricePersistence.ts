import { insertOne } from '@/platform/persistence/singleInsert'
import { tablesOf, type PersistenceTables } from '@/platform/persistence/sessionTables'
import { first } from '@/platform/persistence/queryHelpers'
import { and, asc, desc, eq } from 'drizzle-orm'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { databaseSessionFor } from '@/platform/persistence/databaseTransaction'
import type { PriceVersion } from '../domain/pricing'
import type { PriceStore } from '../application/ports/priceStore'

function version(row: PersistenceTables['observationPrices']['$inferSelect']): PriceVersion {
  const rate = (value: number | null) => (value === null ? null : Number(value))
  return {
    id: row.id,
    runtimeId: row.runtimeId,
    model: row.model,
    inputMicro: rate(row.inputMicro),
    cacheReadMicro: rate(row.cacheReadMicro),
    cacheWriteMicro: rate(row.cacheWriteMicro),
    outputMicro: rate(row.outputMicro),
    effectiveFrom: Number(row.effectiveFrom),
    createdAt: Number(row.createdAt),
    createdBy: row.createdBy,
    note: row.note,
  }
}

export function createPricePersistence(db: PersistenceDb): PriceStore {
  return {
    async line(runtimeId, model) {
      const { observationPrices } = tablesOf(db)
      const rows = await db
        .select()
        .from(observationPrices)
        .where(and(eq(observationPrices.runtimeId, runtimeId), eq(observationPrices.model, model)))
        .orderBy(asc(observationPrices.createdAt), asc(observationPrices.id))
      return rows.map(version)
    },
    async all() {
      const { observationPrices } = tablesOf(db)
      const rows = await db
        .select()
        .from(observationPrices)
        .orderBy(
          asc(observationPrices.runtimeId),
          asc(observationPrices.model),
          asc(observationPrices.createdAt),
          asc(observationPrices.id),
        )
      return rows.map(version)
    },
    async append(next, expectedLatestId) {
      // Price saves are rare administrator actions; predicate isolation keeps the CAS exact.
      return await databaseSessionFor(db).serializable(async (tx) => {
        const { observationPrices } = tablesOf(tx)
        const latest = await first(
          tx
            .select({ id: observationPrices.id })
            .from(observationPrices)
            .where(
              and(
                eq(observationPrices.runtimeId, next.runtimeId),
                eq(observationPrices.model, next.model),
              ),
            )
            .orderBy(desc(observationPrices.createdAt), desc(observationPrices.id))
            .limit(1),
        )
        if ((latest?.id ?? null) !== expectedLatestId) return 'conflict' as const
        await insertOne(tx, observationPrices, { ...next })
        return 'appended' as const
      })
    },
  }
}

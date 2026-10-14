import { and, asc, desc, eq } from 'drizzle-orm'
import type { ProviderNeutralDatabase } from '@/db/query'
import { observationPrices as prices } from '@/db/schema'
import { databaseSessionFor } from '@/platform/persistence/databaseTransaction'
import type { PriceVersion } from '../domain/pricing'
import type { PriceStore } from '../application/ports/priceStore'

function version(row: typeof prices.$inferSelect): PriceVersion {
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

export function createPricePersistence(db: ProviderNeutralDatabase): PriceStore {
  return {
    async line(runtimeId, model) {
      const rows = await db
        .select()
        .from(prices)
        .where(and(eq(prices.runtimeId, runtimeId), eq(prices.model, model)))
        .orderBy(asc(prices.createdAt), asc(prices.id))
        .all()
      return rows.map(version)
    },
    async all() {
      const rows = await db
        .select()
        .from(prices)
        .orderBy(asc(prices.runtimeId), asc(prices.model), asc(prices.createdAt), asc(prices.id))
        .all()
      return rows.map(version)
    },
    async append(next, expectedLatestId) {
      // Price saves are rare administrator actions; predicate isolation keeps the CAS exact.
      return await databaseSessionFor(db).serializable(async (tx) => {
        const latest = await tx
          .select({ id: prices.id })
          .from(prices)
          .where(and(eq(prices.runtimeId, next.runtimeId), eq(prices.model, next.model)))
          .orderBy(desc(prices.createdAt), desc(prices.id))
          .limit(1)
          .get()
        if ((latest?.id ?? null) !== expectedLatestId) return 'conflict' as const
        await tx.insert(prices).values({ ...next })
        return 'appended' as const
      })
    },
  }
}

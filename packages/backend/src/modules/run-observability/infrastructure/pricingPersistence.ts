import { and, desc, eq, inArray, isNull, lt, lte } from 'drizzle-orm'
import { ObservationPriceVersionSchema } from '@agent-workflow/shared'
import type { ObservationPriceIdentity, ObservationPriceVersion } from '@agent-workflow/shared'
import type { ProviderNeutralDatabase } from '@/db/query'
import { observationPriceHeads, observationPriceVersions as prices } from '@/db/schema'
import { databaseSessionFor, engineOf } from '@/platform/persistence/databaseTransaction'
import type { ObservationPriceScope, ObservationPriceStore } from '../ports/pricing'

function decode(document: string): ObservationPriceVersion {
  return ObservationPriceVersionSchema.parse(JSON.parse(document))
}
function matching(registrationId: string, identity: ObservationPriceIdentity, acceptedAt?: number) {
  return and(
    eq(prices.registrationId, registrationId),
    eq(prices.configurationRevision, identity.configurationRevision),
    eq(prices.protocol, identity.protocol),
    eq(prices.provider, identity.provider),
    eq(prices.model, identity.model),
    identity.condition === null
      ? isNull(prices.condition)
      : eq(prices.condition, identity.condition),
    acceptedAt === undefined ? undefined : lte(prices.effectiveFrom, acceptedAt),
  )
}
function priceScope(db: ProviderNeutralDatabase): ObservationPriceScope {
  return {
    head: async (id) =>
      (
        await db
          .select()
          .from(observationPriceHeads)
          .where(eq(observationPriceHeads.registrationId, id))
          .get()
      )?.revision ?? 0,
    receipt: async (id, key) => {
      const row = await db
        .select()
        .from(prices)
        .where(and(eq(prices.registrationId, id), eq(prices.requestKey, key)))
        .get()
      return row ? { fingerprint: row.fingerprint, version: decode(row.document) } : undefined
    },
    latest: async (id, identity, at) => {
      const row = await db
        .select()
        .from(prices)
        .where(matching(id, identity, at))
        .orderBy(desc(prices.effectiveFrom), desc(prices.revision))
        .limit(1)
        .get()
      return row ? decode(row.document) : undefined
    },
    append: async (version, requestKey, fingerprint) => {
      await db
        .insert(prices)
        .values({
          id: version.id,
          registrationId: version.registrationId,
          revision: version.revision,
          requestKey,
          fingerprint,
          configurationRevision: version.configurationRevision,
          protocol: version.protocol,
          provider: version.provider,
          model: version.model,
          condition: version.condition,
          effectiveFrom: Date.parse(version.effectiveFrom),
          document: JSON.stringify(version),
        })
        .run()
      await db
        .update(observationPriceHeads)
        .set({ revision: version.revision })
        .where(eq(observationPriceHeads.registrationId, version.registrationId))
        .run()
    },
  }
}
export function createObservationPriceStore(db: ProviderNeutralDatabase): ObservationPriceStore {
  return {
    heads: async (ids) =>
      ids.length === 0
        ? new Map()
        : new Map(
            (
              await db
                .select()
                .from(observationPriceHeads)
                .where(inArray(observationPriceHeads.registrationId, [...ids]))
                .all()
            ).map((row) => [row.registrationId, row.revision]),
          ),
    history: async (id, query) =>
      (
        await db
          .select()
          .from(prices)
          .where(
            and(
              eq(prices.registrationId, id),
              query.beforeRevision === undefined
                ? undefined
                : lt(prices.revision, query.beforeRevision),
            ),
          )
          .orderBy(desc(prices.revision))
          .limit(query.limit)
          .all()
      ).map((row) => decode(row.document)),
    priceAt: (id, identity, at) => priceScope(db).latest(id, identity, at),
    change: (id, work) =>
      databaseSessionFor(db).transaction(async (tx) => {
        await tx
          .insert(observationPriceHeads)
          .values({ registrationId: id, revision: 0 })
          .onConflictDoNothing()
          .run()
        await engineOf(tx).lockAggregateRoot(
          tx,
          observationPriceHeads,
          observationPriceHeads.registrationId,
          id,
        )
        return work(priceScope(tx))
      }),
  }
}

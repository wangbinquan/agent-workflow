import { asc, eq } from 'drizzle-orm'
import { AcceptedObservationInvocationSchema } from '@agent-workflow/shared'
import type { AcceptedObservationInvocation } from '@agent-workflow/shared'
import type { ProviderNeutralDatabase } from '@/db/query'
import { observationInvocations } from '@/db/schema'
import { databaseSessionFor } from '@/platform/persistence/databaseTransaction'
import { createInvocationValuation } from '../application/invocationValuation'
import type { ObservationSnapshot, ObservationTaskSource } from '../ports/taskObservations'
import { createObservationInvocationStore } from './invocationPersistence'
import { readPlatformObservationPage } from './platformObservationPersistence'
import { createObservationPriceStore } from './pricingPersistence'
import { createUsageLedgerStore } from './usageLedgerPersistence'

export function createTaskObservationSnapshot(input: {
  readonly db: ProviderNeutralDatabase
  readonly taskSource: (connection: ProviderNeutralDatabase) => ObservationTaskSource
}): ObservationSnapshot {
  return {
    read: (work) =>
      databaseSessionFor(input.db).snapshotRead(async (tx) => {
        const invocations = createObservationInvocationStore(tx),
          prices = createObservationPriceStore(tx)
        const accepted = new Map<string, Promise<AcceptedObservationInvocation | undefined>>()
        const tariffs = new Map<string, ReturnType<typeof prices.priceAt>>()
        return work({
          tasks: input.taskSource(tx),
          async invocations(taskId) {
            const rows = await tx
              .select({ document: observationInvocations.document })
              .from(observationInvocations)
              .where(eq(observationInvocations.taskId, taskId))
              .orderBy(asc(observationInvocations.id))
              .limit(1001)
              .all()
            const items = rows
              .slice(0, 1000)
              .map((row) => AcceptedObservationInvocationSchema.parse(JSON.parse(row.document)))
            for (const item of items) accepted.set(item.invocationId, Promise.resolve(item))
            return {
              items,
              truncated: rows.length > 1000,
            }
          },
          local: createUsageLedgerStore(tx),
          platform: { records: (binding, page) => readPlatformObservationPage(tx, binding, page) },
          value: createInvocationValuation(
            {
              get: (id) => {
                let result = accepted.get(id)
                if (result === undefined) {
                  result = invocations.get(id)
                  accepted.set(id, result)
                }
                return result
              },
            },
            {
              priceAt: (...args) => {
                const key = JSON.stringify(args)
                let result = tariffs.get(key)
                if (result === undefined) {
                  result = prices.priceAt(...args)
                  tariffs.set(key, result)
                }
                return result
              },
            },
          ),
        })
      }),
  }
}

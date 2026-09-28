import { eq } from 'drizzle-orm'
import {
  AcceptObservationInvocationSchema,
  AcceptedObservationInvocationSchema,
  type AcceptObservationInvocation,
} from '@agent-workflow/shared'
import type { ProviderNeutralDatabase } from '@/db/query'
import { observationInvocations, observationPriceHeads } from '@/db/schema'
import { databaseSessionFor } from '@/platform/persistence/databaseTransaction'
import { sha256Hex } from '@/util/hash'
import { ObservationInvocationError } from '../domain/invocationError'
import type { ObservationInvocationStore } from '../ports/invocations'

function canonicalExecution(input: AcceptObservationInvocation): string {
  const a = input.authority
  return sha256Hex(
    JSON.stringify(
      a.kind === 'local'
        ? ['local', input.invocationId]
        : ['crewstation', a.sourceId, a.projectId, a.executionResourceId, a.executionGeneration],
    ),
  )
}
const decode = (document: string) => AcceptedObservationInvocationSchema.parse(JSON.parse(document))

export function createObservationInvocationStore(
  db: ProviderNeutralDatabase,
  now: () => number = Date.now,
): ObservationInvocationStore {
  const read = async (connection: ProviderNeutralDatabase, id: string) =>
    connection.select().from(observationInvocations).where(eq(observationInvocations.id, id)).get()
  return {
    async get(id) {
      const row = await read(db, id)
      return row ? decode(row.document) : undefined
    },
    async accept(raw) {
      const parsed = AcceptObservationInvocationSchema.safeParse(raw)
      if (!parsed.success)
        throw new ObservationInvocationError('invalid-invocation', 'Invocation metadata is invalid')
      const input = parsed.data,
        fingerprint = JSON.stringify(input)
      return databaseSessionFor(db).transaction(async (tx) => {
        const existing = await read(tx, input.invocationId)
        if (existing) {
          if (existing.fingerprint !== fingerprint)
            throw new ObservationInvocationError(
              'invocation-conflict',
              'Invocation acceptance changed',
            )
          return decode(existing.document)
        }
        const runtime = input.authority.kind === 'local' ? input.authority.runtime : null
        const priceBookRevision =
          runtime === null
            ? null
            : ((
                await tx
                  .select({ revision: observationPriceHeads.revision })
                  .from(observationPriceHeads)
                  .where(eq(observationPriceHeads.registrationId, runtime.registrationId))
                  .get()
              )?.revision ?? 0)
        const accepted = AcceptedObservationInvocationSchema.parse({
          ...input,
          acceptedAt: now(),
          priceBookRevision,
        })
        await tx
          .insert(observationInvocations)
          .values({
            id: input.invocationId,
            taskId: input.taskId,
            canonicalExecution: canonicalExecution(input),
            fingerprint,
            document: JSON.stringify(accepted),
          })
          .onConflictDoNothing()
          .run()
        const persisted = await read(tx, input.invocationId)
        if (!persisted)
          throw new ObservationInvocationError(
            'execution-already-mapped',
            'Execution already belongs to another invocation',
          )
        if (persisted.fingerprint !== fingerprint)
          throw new ObservationInvocationError(
            'invocation-conflict',
            'Invocation acceptance changed',
          )
        return decode(persisted.document)
      })
    },
  }
}

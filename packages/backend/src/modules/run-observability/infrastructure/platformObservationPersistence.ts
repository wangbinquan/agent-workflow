import { and, asc, eq, gt } from 'drizzle-orm'
import type { ProviderNeutralDatabase } from '@/db/query'
import { observationPlatformRecords, observationPlatformSources } from '@/db/schema'
import {
  databaseSessionFor,
  engineOf,
  type DatabaseTransaction,
} from '@/platform/persistence/databaseTransaction'
import { sha256Hex } from '@/util/hash'
import type { PlatformObservation } from '../domain/platformObservation'
import {
  hidePlatformAmount,
  initialPlatformSyncState,
  platformObservationKey,
  PlatformSyncError,
  type PlatformObservationBinding,
  type PlatformSyncState,
} from '../domain/platformSync'
import type { PlatformObservationStore } from '../ports/platformObservationStore'

const key = (...parts: readonly string[]) => sha256Hex(JSON.stringify(parts))
const sourceKey = (b: PlatformObservationBinding) => key(b.sourceId, b.projectId, b.taskId)
const decode = (document: string): PlatformObservation =>
  JSON.parse(document) as PlatformObservation

async function state(
  connection: ProviderNeutralDatabase,
  binding: PlatformObservationBinding,
): Promise<PlatformSyncState> {
  const row = await connection
    .select()
    .from(observationPlatformSources)
    .where(eq(observationPlatformSources.id, sourceKey(binding)))
    .get()
  if (!row) return initialPlatformSyncState(binding)
  const result = JSON.parse(row.document) as PlatformSyncState
  if (sourceKey(result.binding) !== sourceKey(binding))
    throw new PlatformSyncError('binding-conflict', 'Stored platform source identity changed')
  return result
}
async function record(
  tx: DatabaseTransaction,
  source: string,
  generation: string,
  itemKey: string,
) {
  const row = await tx
    .select({ document: observationPlatformRecords.document })
    .from(observationPlatformRecords)
    .where(eq(observationPlatformRecords.id, key(source, generation, itemKey)))
    .get()
  return row ? decode(row.document) : undefined
}
async function visible(
  tx: DatabaseTransaction,
  state: PlatformSyncState,
  item: PlatformObservation,
) {
  if (item.kind === 'usage') return item
  if (state.costVisibility === 'hidden') return hidePlatformAmount(item, 'not-authorized')
  if (!state.costsReady) return hidePlatformAmount(item, 'pending')
  const usage = await record(
    tx,
    sourceKey(state.binding),
    state.generation!,
    platformObservationKey(item, 'usage'),
  )
  return usage?.kind === 'usage' && usage.projection.projectionRevision === item.usageRevision
    ? item
    : hidePlatformAmount(item, 'pending')
}

/** Separate storage for CS canonical projections: native counters are never folded twice. */
export function createPlatformObservationStore(
  db: ProviderNeutralDatabase,
): PlatformObservationStore {
  return {
    state: (binding) => state(db, binding),
    change: (binding, work) =>
      databaseSessionFor(db).transaction(async (tx) => {
        const id = sourceKey(binding)
        await tx
          .insert(observationPlatformSources)
          .values({ id, document: JSON.stringify(initialPlatformSyncState(binding)) })
          .onConflictDoNothing()
          .run()
        await engineOf(tx).lockAggregateRoot(
          tx,
          observationPlatformSources,
          observationPlatformSources.id,
          id,
        )
        const current = await state(tx, binding)
        return work({
          state: current,
          get: (generation, itemKey) => record(tx, id, generation, itemKey),
          put: async (generation, item) => {
            const value = {
              id: key(id, generation, platformObservationKey(item)),
              sourceKey: id,
              generation,
              document: JSON.stringify(item),
            }
            await tx
              .insert(observationPlatformRecords)
              .values(value)
              .onConflictDoUpdate({ target: observationPlatformRecords.id, set: value })
              .run()
          },
          discard: async (generation) => {
            await tx
              .delete(observationPlatformRecords)
              .where(
                and(
                  eq(observationPlatformRecords.sourceKey, id),
                  eq(observationPlatformRecords.generation, generation),
                ),
              )
              .run()
          },
          save: async (next) => {
            if (sourceKey(next.binding) !== id || next.revision !== current.revision + 1)
              throw new PlatformSyncError(
                'binding-conflict',
                'Platform state transition changed its source or revision',
              )
            await tx
              .update(observationPlatformSources)
              .set({ document: JSON.stringify(next) })
              .where(eq(observationPlatformSources.id, id))
              .run()
          },
        })
      }),
    records: (binding, page) => {
      if (!Number.isInteger(page.limit) || page.limit < 1 || page.limit > 500)
        throw new RangeError('Platform observation page limit must be 1 through 500')
      return databaseSessionFor(db).snapshotRead(async (tx) => {
        // A consistent read also covers the first publication, when no source head exists.
        const id = sourceKey(binding)
        const current = await state(tx, binding)
        if (current.generation === null) return { state: current, items: [] }
        let after: string | undefined
        if (page.after !== undefined) {
          let cursor: unknown
          try {
            cursor = JSON.parse(page.after)
          } catch {
            throw new PlatformSyncError('page-conflict', 'Invalid platform query cursor')
          }
          if (
            !Array.isArray(cursor) ||
            cursor.length !== 4 ||
            cursor[0] !== id ||
            cursor[1] !== current.generation ||
            cursor[2] !== current.revision ||
            typeof cursor[3] !== 'string' ||
            !/^[a-f0-9]{64}$/.test(cursor[3])
          )
            throw new PlatformSyncError(
              'page-conflict',
              'Platform query snapshot changed; restart pagination',
            )
          after = cursor[3]
        }
        const rows = await tx
          .select()
          .from(observationPlatformRecords)
          .where(
            and(
              eq(observationPlatformRecords.sourceKey, id),
              eq(observationPlatformRecords.generation, current.generation),
              after === undefined ? undefined : gt(observationPlatformRecords.id, after),
            ),
          )
          .orderBy(asc(observationPlatformRecords.id))
          .limit(page.limit + 1)
          .all()
        const selected = rows.slice(0, page.limit),
          items: PlatformObservation[] = []
        for (const row of selected) items.push(await visible(tx, current, decode(row.document)))
        return {
          state: current,
          items,
          ...(rows.length > page.limit
            ? {
                nextCursor: JSON.stringify([
                  id,
                  current.generation,
                  current.revision,
                  selected.at(-1)!.id,
                ]),
              }
            : {}),
        }
      })
    },
  }
}

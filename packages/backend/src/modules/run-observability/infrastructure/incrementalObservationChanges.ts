import { and, asc, eq, inArray, lte, sql } from 'drizzle-orm'
import type { ProviderNeutralDatabase } from '@/db/query'
import {
  observationProjectionChanges,
  observationProjectionDependencies,
} from '@/db/observationProjection'
import { databaseSessionFor } from '@/platform/persistence/databaseTransaction'
import { sha256Hex } from '@/util/hash'
import { observationSourceRevisions } from '@/db/schema'
import type {
  OriginalObservationChange,
  OriginalObservationChangeRouter,
} from '../ports/incrementalObservationChanges'
import { enqueueIncrementalObservationWork } from './incrementalObservationWork'

export function canonicalObservationEntityKey(value: string): string {
  const parsed: unknown = JSON.parse(value)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new Error('Invalid original observation entity key')
  const object = parsed as Record<string, unknown>
  if (!Object.keys(object).length || Object.values(object).some((item) => typeof item !== 'string'))
    throw new Error('Invalid original observation entity key')
  return JSON.stringify(
    Object.fromEntries(
      Object.keys(object)
        .sort()
        .map((key) => [key, object[key]]),
    ),
  )
}
function route(value: string | null): OriginalObservationChange['nextRoute'] {
  if (value === null) return null
  const parsed: unknown = JSON.parse(value)
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed) ||
    Object.values(parsed).some((item) => item !== null && typeof item !== 'string')
  )
    throw new Error('Invalid original observation route')
  return parsed as OriginalObservationChange['nextRoute']
}
/** Pending rows, rather than MAX(id), are the durable commit boundary. Rows
 * committed after an earlier packet remain eligible regardless of their ID. */
export function incrementalObservationChangeQueue(
  db: ProviderNeutralDatabase,
  failed: (error: unknown) => void = () => undefined,
) {
  return {
    dispatch: (router: OriginalObservationChangeRouter, packetSize: number) =>
      databaseSessionFor(db).serializable(async (tx) => {
        if (!Number.isSafeInteger(packetSize) || packetSize < 1)
          throw new RangeError('Invalid observation dispatch packet')
        const rows = await tx
          .select()
          .from(observationProjectionChanges)
          .where(
            and(
              eq(observationProjectionChanges.completed, false),
              lte(observationProjectionChanges.retryAt, Date.now()),
            ),
          )
          .orderBy(
            asc(observationProjectionChanges.createdAt),
            asc(observationProjectionChanges.id),
          )
          .limit(packetSize)
          .all()
        const resolved: { change: OriginalObservationChange; components: string[] }[] = []
        for (const row of rows) {
          await tx.run(sql`SAVEPOINT observation_route_row`)
          try {
            const entityKey = canonicalObservationEntityKey(row.entityKey)
            const change: OriginalObservationChange = {
              ...row,
              entityKey,
              previousRoute: route(row.previousRoute),
              nextRoute: route(row.nextRoute),
            }
            const previousKey =
              change.previousRoute === null
                ? entityKey
                : canonicalObservationEntityKey(
                    JSON.stringify(
                      Object.fromEntries(
                        Object.keys(JSON.parse(entityKey) as object).map((column) => [
                          column,
                          change.previousRoute![column],
                        ]),
                      ),
                    ),
                  )
            const old = await tx
              .select({ component: observationProjectionDependencies.component })
              .from(observationProjectionDependencies)
              .where(
                and(
                  eq(observationProjectionDependencies.source, row.source),
                  inArray(observationProjectionDependencies.entityKey, [
                    ...new Set([entityKey, previousKey]),
                  ]),
                ),
              )
              .all()
            const next = await router.components(tx, change)
            if (next === null) {
              await tx
                .update(observationProjectionChanges)
                .set({ retryAt: Date.now() + 1000 })
                .where(eq(observationProjectionChanges.id, row.id))
                .run()
              continue
            }
            const components = [...new Set([...old.map((item) => item.component), ...next])].sort()
            // Empty is an explicit original-owner decision, never an unknown row.
            await tx
              .delete(observationProjectionDependencies)
              .where(
                and(
                  eq(observationProjectionDependencies.source, row.source),
                  inArray(observationProjectionDependencies.entityKey, [
                    ...new Set([entityKey, previousKey]),
                  ]),
                ),
              )
              .run()
            for (let at = 0; at < next.length; at += 150)
              await tx
                .insert(observationProjectionDependencies)
                .values(
                  next
                    .slice(at, at + 150)
                    .map((component) => ({ source: row.source, entityKey, component })),
                )
                .onConflictDoNothing()
                .run()
            resolved.push({ change, components })
          } catch (error) {
            await tx.run(sql`ROLLBACK TO SAVEPOINT observation_route_row`)
            await tx
              .update(observationProjectionChanges)
              .set({
                retryAt: Date.now() + Math.min(60000, Math.max(1000, Date.now() - row.createdAt)),
              })
              .where(eq(observationProjectionChanges.id, row.id))
              .run()
            failed(error)
          } finally {
            await tx.run(sql`RELEASE SAVEPOINT observation_route_row`)
          }
        }
        // Connected components are coalesced within this packet. Unrelated facts
        // never cause another component to be qualified or its fold to be read.
        const groups: { ids: string[]; components: Set<string> }[] = []
        for (const item of resolved) {
          if (!item.components.length) continue
          const joined = groups.filter((group) =>
            item.components.some((component) => group.components.has(component)),
          )
          const group = {
            ids: [item.change.id, ...joined.flatMap((entry) => entry.ids)],
            components: new Set([
              ...item.components,
              ...joined.flatMap((entry) => [...entry.components]),
            ]),
          }
          for (const old of joined) groups.splice(groups.indexOf(old), 1)
          groups.push(group)
        }
        for (const group of groups) {
          const ids = group.ids.sort(),
            revision = sha256Hex(JSON.stringify(ids))
          await enqueueIncrementalObservationWork(tx, {
            id: 'changes/' + revision,
            source: 'original-row-changes',
            revision,
            components: [...group.components].sort(),
          })
        }
        const acknowledged = new Map<string, string[]>()
        for (const item of resolved) {
          await tx
            .update(observationProjectionChanges)
            .set({ completed: true })
            .where(eq(observationProjectionChanges.id, item.change.id))
            .run()
          const ids = acknowledged.get(item.change.source) ?? []
          ids.push(item.change.id)
          acknowledged.set(item.change.source, ids)
        }
        // Clock and pending membership move together in this background-owned
        // transaction. A later pending count cannot reuse a retired epoch.
        for (const [source, ids] of acknowledged)
          await tx
            .update(observationSourceRevisions)
            .set({ revision: sha256Hex(JSON.stringify(['original-change-ack', ids.sort()])) })
            .where(eq(observationSourceRevisions.sourceId, source))
            .run()
        return resolved.length
      }),
  }
}

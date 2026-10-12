import { and, asc, eq, isNull } from 'drizzle-orm'
import type { ProviderNeutralDatabase } from '@/db/query'
import {
  observationProjectionBootstrap,
  observationProjectionChanges,
  observationProjectionComponents,
  observationProjectionHeads,
  observationProjectionVersions,
  observationProjectionWork,
} from '@/db/observationProjection'
import { databaseSessionFor, engineOf } from '@/platform/persistence/databaseTransaction'
import { sha256Hex } from '@/util/hash'
import { enqueueIncrementalObservationWork } from './incrementalObservationWork'

export interface ProjectionBootstrapChannel {
  readonly id: string
  page(
    after?: string,
  ): Promise<{
    readonly items: readonly {
      readonly identity: string
      readonly component: string
      readonly components: readonly string[]
    }[]
    readonly nextCursor: string | null
  }>
}
/** Seed original components once and checkpoint each actual source page in the
 * same transaction as its durable work. Components qualified by an earlier
 * connected seed are skipped. Restarting does not rebuild the whole database. */
export function incrementalObservationBootstrap(
  db: ProviderNeutralDatabase,
  generation: string,
  channels: readonly ProjectionBootstrapChannel[],
) {
  if (!channels.length || new Set(channels.map((channel) => channel.id)).size !== channels.length)
    throw new Error('Invalid original bootstrap channels')
  return async (signal: AbortSignal) => {
    signal.throwIfAborted()
    await db
      .insert(observationProjectionBootstrap)
      .values(channels.map((channel) => ({ generation, channel: channel.id })))
      .onConflictDoNothing()
      .run()
    const progress = await db
      .select()
      .from(observationProjectionBootstrap)
      .where(
        and(
          eq(observationProjectionBootstrap.generation, generation),
          eq(observationProjectionBootstrap.done, false),
        ),
      )
      .orderBy(asc(observationProjectionBootstrap.channel))
      .limit(1)
      .get()
    if (!progress)
      return databaseSessionFor(db).serializable(async (tx) => {
        const head = await tx
          .select()
          .from(observationProjectionHeads)
          .where(eq(observationProjectionHeads.id, 'incremental-20261012-v1'))
          .get()
        const version = head
          ? await tx
              .select()
              .from(observationProjectionVersions)
              .where(eq(observationProjectionVersions.revision, head.revision))
              .get()
          : undefined
        if (version?.bootstrapComplete) return 0
        if (
          await tx
            .select({ id: observationProjectionWork.id })
            .from(observationProjectionWork)
            .where(isNull(observationProjectionWork.appliedRevision))
            .limit(1)
            .get()
        )
          return 0
        if (
          await tx
            .select({ id: observationProjectionChanges.id })
            .from(observationProjectionChanges)
            .where(eq(observationProjectionChanges.completed, false))
            .limit(1)
            .get()
        )
          return 0
        const revision = head?.revision ?? '0'
        await enqueueIncrementalObservationWork(tx, {
          id: 'bootstrap-finish/' + sha256Hex(JSON.stringify([generation, revision])),
          source: 'original-bootstrap-finish',
          revision,
          components: [JSON.stringify(['coverage', generation])],
        })
        return 1
      })
    const channel = channels.find((channel) => channel.id === progress.channel)
    if (!channel) throw new Error('Original bootstrap channel disappeared')
    const page = await channel.page(progress.cursor ?? undefined)
    if (page.nextCursor !== null && page.nextCursor === progress.cursor)
      throw new Error('Original bootstrap EOF did not advance')
    return databaseSessionFor(db).serializable(async (tx) => {
      await engineOf(tx).lockAggregateRoot(
        tx,
        observationProjectionBootstrap,
        observationProjectionBootstrap.generation,
        generation,
      )
      const current = await tx
        .select()
        .from(observationProjectionBootstrap)
        .where(
          and(
            eq(observationProjectionBootstrap.generation, generation),
            eq(observationProjectionBootstrap.channel, channel.id),
          ),
        )
        .get()
      if (current?.done || current?.cursor !== progress.cursor) return 0
      for (const item of page.items) {
        if (
          await tx
            .select()
            .from(observationProjectionComponents)
            .where(eq(observationProjectionComponents.component, item.component))
            .get()
        )
          continue
        await enqueueIncrementalObservationWork(tx, {
          id:
            'bootstrap-component/' +
            sha256Hex(JSON.stringify([generation, channel.id, item.identity])),
          source: 'original-bootstrap-component',
          revision: generation,
          components: [...new Set(item.components)].sort(),
        })
      }
      await tx
        .update(observationProjectionBootstrap)
        .set({ cursor: page.nextCursor, done: page.nextCursor === null })
        .where(
          and(
            eq(observationProjectionBootstrap.generation, generation),
            eq(observationProjectionBootstrap.channel, channel.id),
          ),
        )
        .run()
      return 1
    })
  }
}

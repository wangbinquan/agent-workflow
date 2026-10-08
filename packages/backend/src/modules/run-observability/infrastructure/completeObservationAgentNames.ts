import { eq } from 'drizzle-orm'
import { agents } from '@/db/schema'
import type { ProviderNeutralDatabase } from '@/db/query'
import { sha256Hex } from '@/util/hash'
import { completeWorkingCache } from '../application/completeWorkingCache'
import type { CompleteWorkingRows } from '../ports/completeWorkingRows'

/** Names are resolved on the retained original snapshot, with bounded positive and negative caching. */
export function completeObservationAgentNames(input: {
  readonly db: ProviderNeutralDatabase
  readonly rows: CompleteWorkingRows
  readonly namespace: string
  readonly signal?: AbortSignal
  readonly originalAgentName?: (id: string) => Promise<string | null>
}) {
  const cache = completeWorkingCache<{ name: string | null }>(
    input.rows,
    input.namespace,
    input.signal,
  )
  return {
    async name(id: string | null) {
      if (id === null) return null
      const key = sha256Hex(id)
      let retained = await cache.get(key)
      if (retained === undefined) {
        const original = await input.db
          .select({ name: agents.name })
          .from(agents)
          .where(eq(agents.id, id))
          .get()
        retained = { name: original?.name ?? (await input.originalAgentName?.(id)) ?? null }
        await cache.put(key, retained)
      }
      return retained.name
    },
    flush: () => cache.flush(),
  }
}

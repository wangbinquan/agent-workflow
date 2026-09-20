import { eq } from 'drizzle-orm'
import type { ProviderNeutralDatabase } from '@/db/query'
import { runtimes } from '@/db/schema'
import type { RuntimeRegistryPersistence } from '../application/ports/runtimeRegistry'

/** Read on the exact transaction provided by the NodeRun owner; no transaction or writer here. */
export function createRuntimeSelectionPersistence(
  transaction: ProviderNeutralDatabase,
): Pick<RuntimeRegistryPersistence, 'getRuntime'> {
  return {
    async getRuntime(name) {
      const rows = await transaction.select().from(runtimes).where(eq(runtimes.name, name)).limit(1)
      return rows[0] ?? null
    },
  }
}

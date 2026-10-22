import { tablesOf } from '@/platform/persistence/sessionTables'
import { eq } from 'drizzle-orm'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import type { RuntimeRegistryPersistence } from '../application/ports/runtimeRegistry'

/** Read on the exact transaction provided by the NodeRun owner; no transaction or writer here. */
export function createRuntimeSelectionPersistence(
  transaction: PersistenceDb,
): Pick<RuntimeRegistryPersistence, 'getRuntime'> {
  return {
    async getRuntime(name) {
      const { runtimes } = tablesOf(transaction)
      const rows = await transaction.select().from(runtimes).where(eq(runtimes.name, name)).limit(1)
      return rows[0] ?? null
    },
  }
}

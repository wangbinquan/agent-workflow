import { capabilityTemplates, codeRoundStages, codeWorkItems, codeWorkRounds } from '@/db/schema'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import type { CodeCapabilityDemoSeedPersistence } from '../application/ports/demoSeedPersistence'

export function createPostgresqlCodeCapabilityDemoSeedPersistence(
  db: PostgresqlDatabaseClient,
): CodeCapabilityDemoSeedPersistence {
  return {
    async ensure(aggregate) {
      await db.transaction(async (tx) => {
        await tx.insert(capabilityTemplates).values(aggregate.template).onConflictDoNothing().run()
        if (aggregate.history === null) return
        await tx
          .insert(codeWorkItems)
          .values(aggregate.history.workItem)
          .onConflictDoNothing()
          .run()
        await tx.insert(codeWorkRounds).values(aggregate.history.round).onConflictDoNothing().run()
        if (aggregate.history.stages.length > 0) {
          await tx
            .insert(codeRoundStages)
            .values([...aggregate.history.stages])
            .onConflictDoNothing()
            .run()
        }
      })
    },
  }
}

import type { DbClient } from '@/db/client'
import { capabilityTemplates, codeRoundStages, codeWorkItems, codeWorkRounds } from '@/db/schema'
import { dbTxSync } from '@/db/txSync'
import type { CodeCapabilityDemoSeedPersistence } from '../application/ports/demoSeedPersistence'

export function createSqliteCodeCapabilityDemoSeedPersistence(
  db: DbClient,
): CodeCapabilityDemoSeedPersistence {
  return {
    async ensure(aggregate) {
      dbTxSync(db, (tx) => {
        tx.insert(capabilityTemplates).values(aggregate.template).onConflictDoNothing().run()
        if (aggregate.history === null) return
        tx.insert(codeWorkItems).values(aggregate.history.workItem).onConflictDoNothing().run()
        tx.insert(codeWorkRounds).values(aggregate.history.round).onConflictDoNothing().run()
        if (aggregate.history.stages.length > 0) {
          tx.insert(codeRoundStages)
            .values([...aggregate.history.stages])
            .onConflictDoNothing()
            .run()
        }
      })
    },
  }
}

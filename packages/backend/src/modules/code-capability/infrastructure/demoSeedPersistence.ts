// RFC-359 W4-B5 —— 代码能力演示种子持久化：一份实现，两个 provider 共用。

import { tablesOf } from '@/platform/persistence/sessionTables'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { databaseSessionFor } from '@/platform/persistence/databaseTransaction'
import type { CodeCapabilityDemoSeedPersistence } from '../application/ports/demoSeedPersistence'

export function createCodeCapabilityDemoSeedPersistence(
  db: PersistenceDb,
): CodeCapabilityDemoSeedPersistence {
  return {
    async ensure(aggregate) {
      await databaseSessionFor(db).transaction(async (tx) => {
        const { capabilityTemplates, codeWorkItems, codeWorkRounds, codeRoundStages } = tablesOf(tx)
        await tx.insert(capabilityTemplates).values(aggregate.template).onConflictDoNothing()
        if (aggregate.history === null) return
        await tx.insert(codeWorkItems).values(aggregate.history.workItem).onConflictDoNothing()
        await tx.insert(codeWorkRounds).values(aggregate.history.round).onConflictDoNothing()
        if (aggregate.history.stages.length > 0) {
          await tx
            .insert(codeRoundStages)
            .values([...aggregate.history.stages])
            .onConflictDoNothing()
        }
      })
    },
  }
}

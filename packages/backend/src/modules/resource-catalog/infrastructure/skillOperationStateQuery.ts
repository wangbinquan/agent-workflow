import { tablesOf } from '@/platform/persistence/sessionTables'
import { eq } from 'drizzle-orm'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
export function skillOperationStateQuery(db: PersistenceDb, opId: string) {
  const { skillOperations } = tablesOf(db)
  return db
    .select({ active: skillOperations.active, phase: skillOperations.phase })
    .from(skillOperations)
    .where(eq(skillOperations.opId, opId))
}

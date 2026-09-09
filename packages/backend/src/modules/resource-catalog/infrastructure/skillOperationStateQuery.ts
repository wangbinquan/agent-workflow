import { eq } from 'drizzle-orm'
import type { ProviderNeutralDatabaseForMode } from '@/db/query'
import { skillOperations } from '@/db/schema'

export function skillOperationStateQuery<TMode extends 'sync' | 'async'>(
  db: ProviderNeutralDatabaseForMode<TMode>,
  opId: string,
) {
  return db
    .select({ active: skillOperations.active, phase: skillOperations.phase })
    .from(skillOperations)
    .where(eq(skillOperations.opId, opId))
}

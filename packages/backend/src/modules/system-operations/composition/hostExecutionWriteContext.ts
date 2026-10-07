import type { ProviderNeutralDatabase } from '@/db/query'
import { createDrizzleHostExecutionWriteContext } from '../infrastructure/drizzleHostExecutionWriteContext'

/** Bootstrap owns the database binding; consumers receive named participants. */
export function composeHostExecutionWriteContext(db: ProviderNeutralDatabase) {
  return createDrizzleHostExecutionWriteContext(db)
}

// RFC-395 A4: the same byte ordering for textual source IDs on both engines.
import { sql, type SQLWrapper } from 'drizzle-orm'
import { engineForHandle } from './sessionTables'
import type { DatabaseProvider } from './databaseProviders'

// RFC-395 II-a A4: dialect spellings are exhaustive; added engines must supply a collation.
const BINARY_COLLATION: Record<DatabaseProvider, string> = { sqlite: '"BINARY"', postgresql: '"C"' }

export function binaryTextOrder(handle: object, column: SQLWrapper) {
  const collation = BINARY_COLLATION[engineForHandle(handle).provider]
  return sql`${column} COLLATE ${sql.raw(collation)}`
}

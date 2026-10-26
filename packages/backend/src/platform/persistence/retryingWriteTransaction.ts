import type { PersistenceDb, PersistenceTx } from './persistenceDb'
import { databaseSessionFor, databaseTransactionIsActive } from './databaseTransaction'
import { retryPostgresqlSerialization } from './postgresqlSerializationRetry'

/**
 * A replayable write whose invariants are protected by explicit locks / constraints.
 * PostgreSQL uses READ COMMITTED so reads after a lock wait see the previous writer;
 * SQLite keeps BEGIN IMMEDIATE. The caller must acquire its locks before reading.
 * Only the outermost transaction may retry: an inherited frame must unwind to its
 * owner, never replay a body inside an already aborted transaction.
 */
export async function retryingWriteTransaction<T>(
  db: PersistenceDb,
  body: (tx: PersistenceTx) => Promise<T>,
): Promise<T> {
  const session = databaseSessionFor(db)
  if (databaseTransactionIsActive(db)) return session.transaction(body)
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await session.transaction(body)
    } catch (error) {
      if (await retryPostgresqlSerialization(attempt, error)) continue
      throw error
    }
  }
}

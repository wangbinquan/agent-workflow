import { sql } from 'drizzle-orm'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import { retryPostgresqlSerialization } from '@/db/postgresqlSerializationRetry'

export type PostgresqlResourceCatalogTransaction = Parameters<
  Parameters<PostgresqlDatabaseClient['transaction']>[0]
>[0]

function property(value: object, key: PropertyKey): unknown {
  return Reflect.get(value, key)
}

export async function runPostgresqlResourceCatalogTransaction<T>(
  db: PostgresqlDatabaseClient,
  body: (transaction: PostgresqlResourceCatalogTransaction) => Promise<T>,
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await db.transaction(async (transaction) => {
        await transaction.run(sql.raw('SET TRANSACTION ISOLATION LEVEL SERIALIZABLE'))
        return body(transaction)
      })
    } catch (error) {
      if (await retryPostgresqlSerialization(attempt, error)) continue
      throw error
    }
  }
}

export function isPostgresqlUniqueViolation(
  error: unknown,
  constraintNames: readonly string[],
): boolean {
  let current = error
  for (let depth = 0; depth < 4 && typeof current === 'object' && current !== null; depth += 1) {
    const code = property(current, 'code')
    const constraint = property(current, 'constraint')
    if (
      code === '23505' &&
      (constraintNames.length === 0 ||
        (typeof constraint === 'string' && constraintNames.includes(constraint)))
    ) {
      return true
    }
    current = property(current, 'cause')
  }
  const message = error instanceof Error ? error.message : String(error)
  return (
    /duplicate key value|unique constraint/i.test(message) &&
    constraintNames.some((constraint) => message.includes(constraint))
  )
}

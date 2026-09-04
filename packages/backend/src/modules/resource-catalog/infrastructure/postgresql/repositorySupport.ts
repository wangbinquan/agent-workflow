import { sql } from 'drizzle-orm'
import { postgresqlUniqueViolationConstraint } from '@/platform/persistence/capabilities'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import { retryPostgresqlSerialization } from '@/db/postgresqlSerializationRetry'

export type PostgresqlResourceCatalogTransaction = Parameters<
  Parameters<PostgresqlDatabaseClient['transaction']>[0]
>[0]

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
  // RFC-359（对账 F-I-13）：此前只看 `code === '23505'`，而 Bun.SQL 把 SQLSTATE 放在 `errno`、
  // `code` 恒为 ERR_POSTGRES_SERVER_ERROR ⇒ 在真 PostgreSQL 上恒 false，并发同名拿 500 而非 409。
  // 判据收进能力矩阵一份，这里只做约束名匹配。
  const constraint = postgresqlUniqueViolationConstraint(error)
  if (constraint === undefined) return false
  return constraintNames.length === 0 || constraintNames.includes(constraint)
}

import { postgresqlUniqueViolationConstraint } from '@/platform/persistence/capabilities'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'

export type PostgresqlResourceCatalogTransaction = Parameters<
  Parameters<PostgresqlDatabaseClient['transaction']>[0]
>[0]

// RFC-359 W10 —— 这里此前还住着 `runPostgresqlResourceCatalogTransaction`：把
// `sql.raw('SET TRANSACTION ISOLATION LEVEL SERIALIZABLE')` + `retryPostgresqlSerialization`
// 重试环手抄了一遍的「可串行化事务」。`rfc359-w5-t20-dialect-completeness.test.ts` 的裸方言账本
// 曾把它记成一条「该改调中立原语」的债——**那条判断的前提是错的**：逐个 import 核过之后，
// 它在 `packages/backend/src` 下**一个生产调用方都没有**（全仓只有三份源码文本守卫按名字断言
// 它*不*出现，外加账本自己）。中立原语 `databaseSessionFor(db).serializable(...)` 早已是同一
// 能力的两侧渲染，而 resource-catalog 的 PG 适配器走的一直是 `db.transaction(...)` 直连，
// 从不经过这个 helper。所以正确动作不是「改调中立原语」而是**删掉**——留着它只是给后来人
// 多备一个可抄的分叉源。账本那一行随本次删除一并销账。
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

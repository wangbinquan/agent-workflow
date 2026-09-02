// RFC-349 —— SERIALIZABLE 冲突的重试策略只有这一份。
//
// PostgreSQL 在 SERIALIZABLE 下用 SSI 检测读写依赖环，冲突方收到 SQLSTATE 40001
// （`could not serialize access due to read/write dependencies among transactions`）
// 或 40P01（deadlock_detected）。这两个错误**按设计**由客户端重试消化——不重试就
// 等于把并发直接漏成 500。
//
// 两条实测教训写在这里，别再各自复制一份判据：
//
//  1. Bun.SQL 的 `PostgresError` 把 SQLSTATE 放在 **`errno`**，`code` 恒为
//     `ERR_POSTGRES_SERVER_ERROR`；而 Drizzle 又把驱动错误包进
//     `DrizzleQueryError`（`node_modules/drizzle-orm/errors.js`）并挂在 `cause`
//     上。只看最外层、只看 `code` 的判据一次都不会命中。
//  2. **立即重试会让冲突更严重**：一批同时冲突的事务会同时重来，再撞一次。
//     2026-09-02 本机 100 客户端全量取证实测：服务端记录 3210 次 40001，其中 429 次
//     （13.4%）耗尽「3 次、无退避」的预算后原样变成用户可见的 500。加满抖动的指数
//     退避 + 更大的预算就是为这条曲线设的。
//
// 退避是**满抖动**（AWS 建议的 full jitter）：`random() * min(2^attempt, 16) * 2ms`。
// 最坏累计 ≈ 46ms、期望 ≈ 23ms，远低于取证对单请求 1000ms 的硬门槛，也足以把同批
// 冲突方错开。

/** 单次逻辑操作总共尝试几次（含第一次）。 */
export const POSTGRESQL_SERIALIZATION_ATTEMPTS = 6

const BACKOFF_BASE_MS = 2
const BACKOFF_CEILING_MULTIPLIER = 16

/** 沿 `cause` 链找 40001 / 40P01，`code` 与 `errno` 两处都看；命中就返回那个 SQLSTATE。 */
export function postgresqlSerializationFailureCode(error: unknown): '40001' | '40P01' | undefined {
  let current: unknown = error
  for (let depth = 0; depth < 8 && current !== null && typeof current === 'object'; depth += 1) {
    const code = (current as { readonly code?: unknown }).code
    const sqlState = (current as { readonly errno?: unknown }).errno
    if (code === '40001' || code === '40P01') return code
    if (sqlState === '40001' || sqlState === '40P01') return sqlState
    current = (current as { readonly cause?: unknown }).cause
  }
  return undefined
}

export function isPostgresqlSerializationFailure(error: unknown): boolean {
  return postgresqlSerializationFailureCode(error) !== undefined
}

/** 满抖动退避的毫秒数；`attempt` 是**刚失败的那次**的序号（0 起）。 */
export function postgresqlSerializationBackoffMs(attempt: number, random = Math.random): number {
  const ceiling = Math.min(2 ** Math.max(0, attempt), BACKOFF_CEILING_MULTIPLIER) * BACKOFF_BASE_MS
  return random() * ceiling
}

/**
 * 冲突可重试就退避后返回 true，调用方 `continue` 即可；否则返回 false，调用方原样抛。
 * `attempt` 是刚失败的那次的序号（0 起）。
 */
export async function retryPostgresqlSerialization(
  attempt: number,
  error: unknown,
): Promise<boolean> {
  if (attempt >= POSTGRESQL_SERIALIZATION_ATTEMPTS - 1) return false
  if (!isPostgresqlSerializationFailure(error)) return false
  const delay = postgresqlSerializationBackoffMs(attempt)
  // `Bun.sleep`, not `setTimeout`: this is inline request latency, not a
  // background job, and the RFC-294 census counts every `setTimeout` as one.
  if (delay > 0) await Bun.sleep(delay)
  return true
}

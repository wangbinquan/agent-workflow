// SQLite permits only one writer at a time, including in WAL mode. The primary
// connection already waits up to five seconds (`PRAGMA busy_timeout = 5000`),
// but extended BUSY variants such as BUSY_SNAPSHOT can bypass that wait and a
// second process may release its write transaction just after the timeout.
// Retry only those concurrency codes, once, from a fresh statement/transaction.
// Constraint, I/O, corruption, and full-disk failures remain fail-fast.

export interface SqliteWriteRetryInfo {
  sqliteCode: string
  failedAttempt: number
  nextAttempt: number
  maxAttempts: number
  delayMs: number
}

export interface RetrySqliteWriteOptions {
  /** Total executions, including the first one. Defaults to two. */
  maxAttempts?: number
  /** Delay before the second attempt. Defaults to 100 ms. */
  baseDelayMs?: number
  onRetry?: (info: SqliteWriteRetryInfo) => void
  /** Injectable for deterministic tests. */
  sleep?: (delayMs: number) => Promise<void>
}

interface ErrorLike {
  code?: unknown
  message?: unknown
  cause?: unknown
}

function errorChain(error: unknown): ErrorLike[] {
  const chain: ErrorLike[] = []
  const seen = new Set<object>()
  let current: unknown = error
  while (current !== null && typeof current === 'object' && chain.length < 8) {
    if (seen.has(current)) break
    seen.add(current)
    const candidate = current as ErrorLike
    chain.push(candidate)
    current = candidate.cause
  }
  return chain
}

function sqliteCode(candidate: ErrorLike): string | undefined {
  return typeof candidate.code === 'string' && candidate.code.startsWith('SQLITE_')
    ? candidate.code
    : undefined
}

/** The first SQLite code in an Error.cause chain, when one is present. */
export function sqliteWriteErrorCode(error: unknown): string | undefined {
  for (const candidate of errorChain(error)) {
    const code = sqliteCode(candidate)
    if (code !== undefined) return code
  }
  return undefined
}

/** A retryable writer-concurrency code, including SQLite extended codes. */
export function retryableSqliteWriteErrorCode(error: unknown): string | undefined {
  for (const candidate of errorChain(error)) {
    const code = sqliteCode(candidate)
    if (code === undefined) continue
    if (
      code === 'SQLITE_BUSY' ||
      code.startsWith('SQLITE_BUSY_') ||
      code === 'SQLITE_LOCKED' ||
      code.startsWith('SQLITE_LOCKED_')
    ) {
      return code
    }
  }
  return undefined
}

/**
 * A diagnostic that prefers the coded SQLite cause. Drizzle wrapper
 * messages may contain the full SQL and bound values, so callers should mask
 * and cap this string before logging or persistence.
 */
export function sqliteWriteDiagnostic(error: unknown): string {
  for (const candidate of errorChain(error)) {
    const code = sqliteCode(candidate)
    if (code === undefined) continue
    const message =
      typeof candidate.message === 'string' && candidate.message.length > 0
        ? candidate.message
        : 'SQLite write failed'
    return `[${code}] ${message}`
  }
  if (error instanceof Error) return error.message
  return String(error)
}

export async function retrySqliteWrite<T>(
  write: () => T | Promise<T>,
  opts: RetrySqliteWriteOptions = {},
): Promise<T> {
  const maxAttempts = Math.max(1, Math.floor(opts.maxAttempts ?? 2))
  const baseDelayMs = Math.max(0, Math.floor(opts.baseDelayMs ?? 100))
  const sleep =
    opts.sleep ??
    ((delayMs: number) => new Promise<void>((resolve) => setTimeout(resolve, delayMs)))

  for (let attempt = 1; ; attempt++) {
    try {
      return await write()
    } catch (error) {
      const code = retryableSqliteWriteErrorCode(error)
      if (code === undefined || attempt >= maxAttempts) throw error

      const delayMs = baseDelayMs * 2 ** (attempt - 1)
      opts.onRetry?.({
        sqliteCode: code,
        failedAttempt: attempt,
        nextAttempt: attempt + 1,
        maxAttempts,
        delayMs,
      })
      await sleep(delayMs)
    }
  }
}

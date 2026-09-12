import { postgresqlUniqueViolationConstraint } from '@/platform/persistence/capabilities'

interface StructuredConstraintError {
  readonly code?: unknown
  readonly constraint?: unknown
  readonly table?: unknown
  readonly cause?: unknown
  readonly message?: unknown
}

function errorChain(error: unknown): ReadonlyArray<unknown> {
  const chain: unknown[] = []
  const seen = new Set<unknown>()
  let current: unknown = error
  while (current !== null && current !== undefined && !seen.has(current) && chain.length < 8) {
    chain.push(current)
    seen.add(current)
    current =
      typeof current === 'object' && current !== null
        ? (current as StructuredConstraintError).cause
        : undefined
  }
  return chain
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'object' && error !== null) {
    const message = (error as StructuredConstraintError).message
    if (typeof message === 'string') return message
  }
  return String(error)
}

/**
 * Provider-neutral conflict classifier for the legacy classic-resource
 * facades. SQLite and PostgreSQL expose different error metadata, but callers
 * receive the same owner/name conflict result.
 *
 * RFC-359 —— PostgreSQL 那半此前**恒 false**：这里只读 `code`，而 Bun 的驱动把 SQLSTATE 放在
 * **`errno`**（`code` 是它自己的 `ERR_POSTGRES_SERVER_ERROR`）。于是同名并发创建在 SQLite 上
 * 是干净的 409 `agent-name-in-use`，在 PostgreSQL 上是一个裸的 `DrizzleQueryError` 直接抛到
 * 路由层。判据改成复用 `postgresqlUniqueViolationConstraint`——那是本仓 23505 的**唯一**真值来源
 * （它的注释里记着同一个坑：「此前只看 `code`，在真 PG 上恒 false ⇒ 并发同名拿 500 而非 409」）。
 * 别在这里再手写一份 errno/code 匹配。
 */
export function isOwnerScopedNameConflict(
  error: unknown,
  input: { readonly table: string; readonly indexName: string },
): boolean {
  return errorChain(error).some((candidate) => {
    const structured =
      typeof candidate === 'object' && candidate !== null
        ? (candidate as StructuredConstraintError)
        : undefined
    const code = String(structured?.code ?? '')
    const constraint = String(structured?.constraint ?? '')
    const table = String(structured?.table ?? '')
    const message = errorMessage(candidate)
    const exactTarget =
      constraint === input.indexName ||
      (table === input.table && /\bname\b/i.test(message)) ||
      message.includes(input.indexName) ||
      message.includes(`${input.table}.name`)

    // PostgreSQL：SQLSTATE 在 `errno`，`code` 是 Bun 自己的标签——统一走那份唯一判据。
    const postgresqlConstraint = postgresqlUniqueViolationConstraint(candidate)
    if (postgresqlConstraint !== undefined) {
      return postgresqlConstraint === input.indexName || exactTarget
    }
    if (code === '23505') return exactTarget
    if (
      code === 'SQLITE_CONSTRAINT_UNIQUE' ||
      /UNIQUE constraint failed|SQLITE_CONSTRAINT_UNIQUE|constraint failed/i.test(message)
    ) {
      return exactTarget
    }
    return false
  })
}

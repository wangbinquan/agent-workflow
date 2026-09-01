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

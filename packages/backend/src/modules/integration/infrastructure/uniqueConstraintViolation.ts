/** Drizzle wraps driver failures; normalize provider-native uniqueness errors through causes. */
export function isUniqueConstraintViolation(error: unknown): boolean {
  const visited = new Set<unknown>()
  let current = error
  for (let depth = 0; depth < 8 && current !== null && current !== undefined; depth += 1) {
    if (visited.has(current)) return false
    visited.add(current)
    if (typeof current !== 'object') return false
    const record = current as {
      readonly code?: unknown
      readonly message?: unknown
      cause?: unknown
    }
    if (
      record.code === '23505' ||
      record.code === 'SQLITE_CONSTRAINT' ||
      record.code === 'SQLITE_CONSTRAINT_UNIQUE' ||
      (typeof record.message === 'string' &&
        /unique constraint|unique constraint failed|duplicate key/i.test(record.message))
    ) {
      return true
    }
    current = record.cause
  }
  return false
}

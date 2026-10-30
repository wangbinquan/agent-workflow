import type { Database } from 'bun:sqlite'
import { postgresqlStatementOperation } from './postgresqlSql'

const guarded = new WeakMap<Database, () => void>()

/** The writer and rollback use SQLite's same IMMEDIATE transaction lock. A failed
 * statement rolls its marker back even when its caller catches the error. */
export function guardSqliteGenerationWrites(
  database: Database,
  expectedGeneration?: string,
): () => void {
  const existing = guarded.get(database)
  if (existing) return existing
  const query = database.query.bind(database)
  const exec = database.exec.bind(database)
  const active = query(
    "SELECT generation_id FROM aw_meta_generations WHERE state = 'active'",
  ).all() as { generation_id: string }[]
  if (
    active.length !== 1 ||
    (expectedGeneration !== undefined && active[0]!.generation_id !== expectedGeneration)
  )
    throw new Error('sqlite-active-generation-mismatch')
  const generationId = active[0]!.generation_id
  let marked = false
  let pendingMark = false
  const reset = () => {
    marked = false
    pendingMark = false
  }
  guarded.set(database, reset)
  const observeCommit = () => {
    if (marked || !pendingMark || database.inTransaction) return
    // Cleared first: where `query` prepares through the overridden `prepare`
    // (Bun 1.3.x), this read returns through the read wrapper below.
    pendingMark = false
    const row = query(
      'SELECT first_live_write_at FROM aw_meta_first_write WHERE generation_id = ?',
    ).get(generationId) as { first_live_write_at: number | null } | null
    marked = row?.first_live_write_at != null
  }
  let depth = 0
  const fenced = <T>(body: () => T): T => {
    depth++
    const nested = database.inTransaction
    let begun = false
    try {
      exec(nested ? 'SAVEPOINT aw_generation_write' : 'BEGIN IMMEDIATE')
      begun = true
      if (
        !query(
          "SELECT 1 FROM aw_meta_generations WHERE generation_id = ? AND state = 'active'",
        ).get(generationId)
      )
        throw new Error('sqlite-generation-fence-rejected')
      if (!marked) {
        const marker = query(
          'SELECT first_live_write_at FROM aw_meta_first_write WHERE generation_id = ?',
        ).get(generationId) as { first_live_write_at: number | null } | null
        if (!marker) throw new Error('generation-first-write-marker-missing')
        if (marker.first_live_write_at === null)
          query(
            'UPDATE aw_meta_first_write SET first_live_write_at = ? WHERE generation_id = ? AND first_live_write_at IS NULL',
          ).run(Date.now(), generationId)
        pendingMark = true
      }
      const result = body()
      exec(nested ? 'RELEASE aw_generation_write' : 'COMMIT')
      return result
    } catch (error) {
      // A statement can end the transaction itself (RAISE(ROLLBACK), SQLITE_FULL);
      // rolling back again would replace its error with "no transaction is active".
      if (begun && database.inTransaction) {
        if (nested) {
          exec('ROLLBACK TO aw_generation_write')
          exec('RELEASE aw_generation_write')
        } else exec('ROLLBACK')
      }
      throw error
    } finally {
      depth--
    }
  }
  const write = <T>(body: () => T): T => {
    if (depth) return body()
    const result = fenced(body)
    // Outside the rollback path: nothing after COMMIT can try to undo it.
    observeCommit()
    return result
  }
  const writes = (statement: string) =>
    postgresqlStatementOperation(statement) === 'write' || /^\s*REPLACE\b/i.test(statement)
  const statements = new WeakSet<object>()
  for (const method of ['query', 'prepare'] as const) {
    const original = (database[method] as (...args: unknown[]) => object).bind(database)
    ;(database as unknown as Record<string, unknown>)[method] = (...args: unknown[]) => {
      const statement = original(...args)
      if (statements.has(statement)) return statement
      statements.add(statement)
      const mutation = writes(String(args[0]))
      for (const property of ['run', 'all', 'get', 'values', 'iterate'] as const) {
        const bound = (Reflect.get(statement, property) as (...values: unknown[]) => unknown).bind(
          statement,
        )
        Object.defineProperty(statement, property, {
          configurable: true,
          writable: true,
          value: (...values: unknown[]) => {
            if (property === 'iterate')
              return mutation
                ? write(() => Array.from(bound(...values) as Iterable<unknown>))[Symbol.iterator]()
                : bound(...values)
            if (mutation) return write(() => bound(...values))
            const result = bound(...values)
            observeCommit()
            return result
          },
        })
      }
      return statement
    }
  }
  database.exec = ((statement: string) => {
    if (statement.split(';').some(writes)) return write(() => exec(statement))
    const result = exec(statement)
    observeCommit()
    return result
  }) as typeof database.exec
  return reset
}

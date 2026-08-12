import { describe, expect, test } from 'bun:test'
import {
  retrySqliteWrite,
  sqliteWriteDiagnostic,
  type SqliteWriteRetryInfo,
} from '../src/db/sqliteWriteRetry'

function sqliteError(code: string, message: string, cause?: unknown): Error & { code: string } {
  const error = new Error(message, cause === undefined ? undefined : { cause }) as Error & {
    code: string
  }
  error.name = 'SQLiteError'
  error.code = code
  return error
}

describe('retrySqliteWrite', () => {
  test('retries one transient SQLITE_BUSY write and then returns the result', async () => {
    const busy = sqliteError('SQLITE_BUSY', 'database is locked')
    const retries: SqliteWriteRetryInfo[] = []
    const sleeps: number[] = []
    let attempts = 0

    const result = await retrySqliteWrite(
      () => {
        attempts++
        if (attempts === 1) throw busy
        return 'persisted'
      },
      {
        onRetry: (info) => retries.push(info),
        sleep: async (delayMs) => {
          sleeps.push(delayMs)
        },
      },
    )

    expect(result).toBe('persisted')
    expect(attempts).toBe(2)
    expect(sleeps).toEqual([100])
    expect(retries).toEqual([
      {
        sqliteCode: 'SQLITE_BUSY',
        failedAttempt: 1,
        nextAttempt: 2,
        maxAttempts: 2,
        delayMs: 100,
      },
    ])
  })

  test('recognizes extended SQLITE_LOCKED codes through a wrapper cause', async () => {
    const locked = sqliteError('SQLITE_LOCKED_SHAREDCACHE', 'database table is locked')
    const wrapped = new Error('Failed query: INSERT INTO secret VALUES (?)', { cause: locked })
    let attempts = 0

    const result = await retrySqliteWrite(
      () => {
        attempts++
        if (attempts === 1) throw wrapped
        return 42
      },
      { sleep: async () => undefined },
    )

    expect(result).toBe(42)
    expect(attempts).toBe(2)
    // The diagnostic must use the coded SQLite cause, not a Drizzle wrapper
    // whose message can contain the whole SQL statement and bound parameters.
    expect(sqliteWriteDiagnostic(wrapped)).toBe(
      '[SQLITE_LOCKED_SHAREDCACHE] database table is locked',
    )
  })

  test('does not retry a constraint failure', async () => {
    const constraint = sqliteError('SQLITE_CONSTRAINT_TRIGGER', 'forced insert failure')
    let attempts = 0

    let caught: unknown
    try {
      await retrySqliteWrite(
        () => {
          attempts++
          throw constraint
        },
        { sleep: async () => undefined },
      )
    } catch (error) {
      caught = error
    }

    expect(caught).toBe(constraint)
    expect(attempts).toBe(1)
  })

  test('stops after the bounded attempt count when SQLITE_BUSY persists', async () => {
    const busy = sqliteError('SQLITE_BUSY_SNAPSHOT', 'database is locked')
    let attempts = 0
    let caught: unknown

    try {
      await retrySqliteWrite(
        () => {
          attempts++
          throw busy
        },
        { sleep: async () => undefined },
      )
    } catch (error) {
      caught = error
    }

    expect(caught).toBe(busy)
    expect(attempts).toBe(2)
  })
})

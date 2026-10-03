import { Database } from 'bun:sqlite'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { randomUUID } from 'node:crypto'
import type { DbClient } from '@/db/client'
import * as schema from '@/db/schema'
import { databaseSessionFor } from './databaseTransaction'
import { assertPostgresqlBusinessStatement } from './postgresqlSql'
import { CREATE_REPORT_WORKING_TABLE, privateReportWorkspace } from './reportWorkspace'
import type { OriginalReportSnapshot, ReportSnapshotSession } from './reportSnapshotTypes'
function readonlySource(sqlite: Database, active: () => boolean, signal?: AbortSignal) {
  const check = () => {
    if (!active()) throw new Error('Report snapshot already closed')
    signal?.throwIfAborted()
  }
  const guarded = new Proxy(sqlite, {
    get(target, key, receiver) {
      if (key === 'prepare' || key === 'query')
        return (statement: string) => {
          check()
          if (assertPostgresqlBusinessStatement(statement) !== 'read')
            throw new Error('Report input only supports original reads')
          const prepared = target.query(statement)
          return new Proxy(prepared, {
            get(object, name, r) {
              const value = Reflect.get(object, name, r)
              return typeof value === 'function'
                ? (...args: unknown[]) => {
                    check()
                    return value.apply(object, args)
                  }
                : value
            },
          })
        }
      if (key === 'exec' || key === 'transaction' || key === 'close')
        return () => {
          throw new Error('Report input only supports original reads')
        }
      const value = Reflect.get(target, key, receiver)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  return drizzle(guarded, { schema })
}
function workspaceFor(sqlite: Database, active: () => boolean, signal?: AbortSignal) {
  return privateReportWorkspace(
    {
      all: async (statement, parameters) =>
        sqlite.query(statement).all(...(parameters as never[])) as Record<string, unknown>[],
      run: async (statement, parameters) => {
        sqlite.query(statement).run(...(parameters as never[]))
      },
    },
    active,
    signal,
  )
}
function originalIdentity(
  sqlite: Database,
  filename: string,
  generationId: string,
): Pick<OriginalReportSnapshot, 'snapshotId' | 'generationId' | 'asOf'> {
  // This actual main relation read freezes the WAL view before any source owner query.
  sqlite.query('SELECT name FROM main.sqlite_schema LIMIT 1').get()
  const databases = sqlite.query('PRAGMA database_list').all() as { name: string; file: string }[]
  if (
    filename &&
    filename !== ':memory:' &&
    databases.find((row) => row.name === 'main')?.file !== filename
  )
    throw new Error('Original report database file changed')
  const version = sqlite.query('PRAGMA data_version').get() as { data_version: number }
  return {
    generationId,
    asOf: Date.now(),
    snapshotId: JSON.stringify([
      filename || ':memory:',
      generationId,
      version.data_version,
      randomUUID(),
    ]),
  }
}
/** The file channel is opened only for the exact original live file supplied by bootstrap. */
export function originalSqliteFileReportSnapshot(input: {
  readonly filename: string
  readonly generationId: string
}): ReportSnapshotSession {
  if (!input.filename || input.filename === ':memory:' || !input.generationId)
    throw new Error('Original report file or generation missing')
  return {
    async run<T>(
      work: (snapshot: OriginalReportSnapshot) => Promise<T>,
      signal?: AbortSignal,
    ): Promise<T> {
      signal?.throwIfAborted()
      const sqlite = new Database(input.filename, { readonly: true, strict: true })
      let active = false
      try {
        const mode = sqlite.query('PRAGMA journal_mode').get() as { journal_mode: string }
        if (mode.journal_mode !== 'wal')
          throw new Error('Original report file requires the existing WAL mode')
        sqlite.exec(CREATE_REPORT_WORKING_TABLE)
        sqlite.exec('BEGIN DEFERRED')
        const identity = originalIdentity(sqlite, sqlite.filename, input.generationId)
        active = true
        const result = await work({
          ...identity,
          executor: readonlySource(sqlite, () => active, signal),
          workspace: workspaceFor(sqlite, () => active, signal),
        })
        signal?.throwIfAborted()
        sqlite.exec('COMMIT')
        return result
      } finally {
        active = false
        try {
          if (sqlite.inTransaction) sqlite.exec('ROLLBACK')
        } finally {
          sqlite.close()
        }
      }
    },
  }
}
/** In-memory deployments retain their original one-connection snapshot; no copied database fallback. */
export function originalSqliteReportSnapshot(input: {
  readonly db: DbClient
  readonly generationId: string
}): ReportSnapshotSession {
  const sqlite = input.db.$client
  if (sqlite.filename && sqlite.filename !== ':memory:')
    return originalSqliteFileReportSnapshot({
      filename: sqlite.filename,
      generationId: input.generationId,
    })
  return {
    async run<T>(
      work: (snapshot: OriginalReportSnapshot) => Promise<T>,
      signal?: AbortSignal,
    ): Promise<T> {
      signal?.throwIfAborted()
      return await databaseSessionFor(input.db).snapshotRead(async () => {
        let active = false
        sqlite.exec(CREATE_REPORT_WORKING_TABLE)
        try {
          active = true
          const identity = originalIdentity(sqlite, ':memory:', input.generationId)
          const value = await work({
            ...identity,
            executor: readonlySource(sqlite, () => active, signal),
            workspace: workspaceFor(sqlite, () => active, signal),
          })
          signal?.throwIfAborted()
          return value
        } finally {
          active = false
          sqlite.exec('DROP TABLE IF EXISTS temp.aw_report_workspace')
        }
      })
    },
  }
}

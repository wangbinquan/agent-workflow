// Offline target connections never construct a runtime business session.
import { Database } from 'bun:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { PostgresqlDatabaseRuntime } from '../../postgresqlRuntime'
import {
  postgresqlHistoryConnection,
  sqliteHistoryConnection,
  type HistoryConnection,
} from '../../schema/history/connection'
import type { ConversionTargetConnection } from '../run/types'
import { withNativeTransaction } from '../../nativeTransaction'
import { migrationPostgresqlRuntime } from '../freeze/postgresqlDatabases'

type ConversionTargetInput =
  | { readonly databasePath: string; readonly create: boolean }
  | { readonly runtime: PostgresqlDatabaseRuntime }

/** One serialized connection and transaction lifetime for both native engines. */
export function openConversionTarget(input: ConversionTargetInput): ConversionTargetConnection {
  let pending: Promise<unknown> = Promise.resolve()
  const queue = <T>(work: () => Promise<T>): Promise<T> => {
    const result = pending.then(work)
    pending = result.catch(() => undefined)
    return result
  }
  let provider: HistoryConnection['provider']
  let ready: Promise<{ connection: HistoryConnection; close(): void }>
  let begin: string
  let transactionSetup: readonly string[]
  if ('databasePath' in input) {
    if (input.create) mkdirSync(dirname(input.databasePath), { recursive: true })
    const database = new Database(input.databasePath, {
      create: input.create,
      readwrite: true,
      safeIntegers: true,
    })
    database.exec('PRAGMA journal_mode = WAL')
    database.exec('PRAGMA foreign_keys = OFF')
    provider = 'sqlite'
    begin = 'BEGIN IMMEDIATE'
    transactionSetup = []
    ready = Promise.resolve({
      connection: sqliteHistoryConnection(database),
      close: () => database.close(),
    })
  } else {
    provider = 'postgresql'
    begin = 'BEGIN'
    transactionSetup = [
      'SELECT pg_advisory_xact_lock(395, 3)',
      'SET LOCAL search_path TO agent_workflow, public',
    ]
    ready = migrationPostgresqlRuntime(input.runtime)
      .providerPool()
      .reserve()
      .then(async (connection) => {
        try {
          await connection.unsafe('SET search_path TO agent_workflow, public')
          return {
            connection: postgresqlHistoryConnection(connection),
            close: () => connection.release(),
          }
        } catch (error) {
          connection.release()
          throw error
        }
      })
  }
  return {
    provider,
    execute: (sql, values) => queue(async () => (await ready).connection.execute(sql, values)),
    transaction: (body) =>
      queue(async () => {
        const { connection } = await ready
        return withNativeTransaction(
          connection,
          async () => {
            for (const sql of transactionSetup) await connection.execute(sql)
            return body(connection)
          },
          begin,
        )
      }),
    close: () => queue(async () => (await ready).close()),
  }
}

/** Probe an existing target without creating it or loading a business session. */
export function sqliteTargetIsEmpty(path: string): boolean {
  const database = new Database(path, { readonly: true })
  try {
    return (
      database.query("SELECT name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'").all()
        .length === 0
    )
  } finally {
    database.close()
  }
}

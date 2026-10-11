import {
  openReadonlySqliteDatabase,
  type ReadonlySqliteDatabase,
} from '@/platform/persistence/sqlite/readonlySqliteDatabase'

interface OriginalNativeConnection {
  readonly generation: string
  readonly database: ReadonlySqliteDatabase
  readonly statements: Map<string, ReturnType<ReadonlySqliteDatabase['query']>>
}

/** Report-local physical reuse; every borrower still owns its own original BEGIN and TEMP state. */
export function createOpencodeReportConnections(
  path: string,
  openDatabase: (path: string) => ReadonlySqliteDatabase = openReadonlySqliteDatabase,
) {
  const active = new Set<ReadonlySqliteDatabase>()
  let idle: OriginalNativeConnection | undefined,
    closed = false,
    cleanupFailed = false,
    cleanupFailure: unknown
  const discard = ({ database, statements }: OriginalNativeConnection) => {
    statements.clear()
    try {
      database.close()
    } catch (error) {
      if (!cleanupFailed) {
        cleanupFailed = true
        cleanupFailure = error
      }
    }
  }
  return {
    borrow(generation: string, released: () => void): ReadonlySqliteDatabase {
      if (closed) throw new Error('Original report native connections closed')
      if (idle && idle.generation !== generation) {
        discard(idle)
        idle = undefined
      }
      const original = idle ?? { generation, database: openDatabase(path), statements: new Map() }
      idle = undefined
      let live = true,
        transaction = false,
        committed = false
      const prepared = <Row, Parameters extends readonly unknown[]>(sql: string) => {
        let statement = original.statements.get(sql) as
          | ReturnType<typeof original.database.query<Row, Parameters>>
          | undefined
        if (!statement) {
          statement = original.database.query<Row, Parameters>(sql)
          original.statements.set(sql, statement)
        }
        return statement
      }
      const lease: ReadonlySqliteDatabase = {
        query<Row, Parameters extends readonly unknown[]>(sql: string) {
          if (!live) throw new Error('Original native connection lease closed')
          const statement = prepared<Row, Parameters>(sql)
          if (sql !== 'BEGIN' && sql !== 'COMMIT' && sql !== 'ROLLBACK') return statement
          const completed = () => {
            transaction = sql === 'BEGIN'
            committed = sql === 'COMMIT'
          }
          return {
            get(...parameters: Parameters) {
              const row = statement.get(...parameters)
              completed()
              return row
            },
            all(...parameters: Parameters) {
              const rows = statement.all(...parameters)
              completed()
              return rows
            },
          }
        },
        close() {
          if (!live) return
          live = false
          active.delete(lease)
          let reusable = true
          try {
            const cleanup = committed ? 'DELETE FROM' : 'DROP TABLE IF EXISTS'
            if (transaction) prepared<unknown, []>('ROLLBACK').get()
            prepared<unknown, []>(`${cleanup} temp.native_pass_open_steps`).get()
            prepared<unknown, []>(`${cleanup} temp.native_pass_message_models`).get()
            prepared<unknown, []>(`${cleanup} temp.native_pass_queue`).get()
          } catch {
            // A failed cleanup may never lend stale root/model state to another reader.
            reusable = false
          } finally {
            if (!committed) original.statements.clear()
          }
          if (!reusable || closed || idle) discard(original)
          else idle = original
          released()
        },
      }
      active.add(lease)
      return lease
    },
    close() {
      if (closed) return
      closed = true
      for (const lease of [...active]) lease.close()
      if (idle) {
        discard(idle)
        idle = undefined
      }
      // Defer physical-close errors until the owner closes the factory, so the
      // original parse/root failure is not replaced inside a reader's catch.
      if (cleanupFailed) throw cleanupFailure
    },
  }
}

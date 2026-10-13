import { Database } from 'bun:sqlite'
import {
  SQLITE_TABLE_STORAGE_SQL,
  SQLITE_OBSERVATION_STORAGE_SQL,
  decodeDatabaseStorageCounters,
  type SqliteTableStorage,
  type SqliteStorageReply,
} from './sqliteStorageProtocol'

declare const self: Worker
/** Physical B-tree traversal and complete backlog counts never run on the HTTP/WS thread. */
self.onmessage = (event: MessageEvent<{ file: string; counters?: boolean }>) => {
  let db: Database | undefined
  let reply: SqliteStorageReply
  try {
    db = new Database(event.data.file, { readonly: true, create: false, strict: true })
    db.exec('PRAGMA query_only=ON')
    const at = performance.now(),
      cpu = process.cpuUsage()
    let result:
      | { tables: readonly SqliteTableStorage[] }
      | { counters: ReturnType<typeof decodeDatabaseStorageCounters> }
    if (event.data.counters) {
      // All counts belong to one original readonly snapshot, without a page
      // limit or a foreground scan of the entire durable source outbox.
      db.exec('BEGIN')
      const queue =
          db
            .query<
              { pending: string; oldest: number | null },
              []
            >(SQLITE_OBSERVATION_STORAGE_SQL[0])
            .get() ?? undefined,
        unfinished =
          db
            .query<
              { pending: string; oldest: number | null },
              []
            >(SQLITE_OBSERVATION_STORAGE_SQL[1])
            .get() ?? undefined,
        reports =
          db
            .query<{ active: string; retiring: string }, []>(SQLITE_OBSERVATION_STORAGE_SQL[2])
            .get() ?? undefined
      result = { counters: decodeDatabaseStorageCounters(queue, unfinished, reports) }
      db.exec('COMMIT')
    } else result = { tables: db.query(SQLITE_TABLE_STORAGE_SQL).all() as SqliteTableStorage[] }
    const used = process.cpuUsage(cpu)
    reply = {
      ok: true,
      ...result,
      ms: performance.now() - at,
      cpuMs: (used.user + used.system) / 1000,
    }
  } catch (error) {
    reply = { ok: false, error: error instanceof Error ? error.message : String(error) }
  } finally {
    db?.close()
  }
  postMessage(reply)
}

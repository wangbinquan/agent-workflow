import { Database } from 'bun:sqlite'
import {
  SQLITE_TABLE_STORAGE_SQL,
  type SqliteTableStorage,
  type SqliteStorageReply,
} from './sqliteStorageProtocol'

declare const self: Worker
/** Physical B-tree traversal never runs on the HTTP/WS thread. There is no same-thread fallback. */
self.onmessage = (event: MessageEvent<{ file: string }>) => {
  let db: Database | undefined
  let reply: SqliteStorageReply
  try {
    db = new Database(event.data.file, { readonly: true, create: false, strict: true })
    db.exec('PRAGMA query_only=ON')
    const at = performance.now(),
      cpu = process.cpuUsage()
    const tables = db.query(SQLITE_TABLE_STORAGE_SQL).all() as SqliteTableStorage[]
    const used = process.cpuUsage(cpu)
    reply = {
      ok: true,
      tables,
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

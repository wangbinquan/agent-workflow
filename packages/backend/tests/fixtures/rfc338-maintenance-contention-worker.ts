import { openDb, type DbClient } from '../../src/db/client'
import { pruneTokenAuditSlice, type TokenAuditPruneCursorV1 } from '../../src/services/tokenAudit'

declare const self: Worker

let db: DbClient | null = null

self.onmessage = async (
  event: MessageEvent<
    | { type: 'init'; dbPath: string; migrationsFolder: string }
    | { type: 'slice'; cursor: TokenAuditPruneCursorV1 }
  >,
) => {
  if (event.data.type === 'init') {
    db = openDb({
      path: event.data.dbPath,
      migrationsFolder: event.data.migrationsFolder,
      skipMigrations: true,
      skipIntegrityCheck: true,
      journalMode: 'preserve',
      busyTimeoutMs: 50,
      slowQueryMs: 0,
    })
    postMessage({ type: 'ready' })
    return
  }
  if (db === null) throw new Error('contention-worker-not-initialised')
  const started = performance.now()
  try {
    const result = await pruneTokenAuditSlice(db, 90, event.data.cursor, Date.now(), 10)
    postMessage({ type: 'result', ok: true, elapsedMs: performance.now() - started, result })
  } catch (error) {
    postMessage({
      type: 'result',
      ok: false,
      elapsedMs: performance.now() - started,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

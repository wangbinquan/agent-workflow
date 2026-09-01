// RFC-311 — off-thread `VACUUM INTO` for backups.
//
// The backup used to run VACUUM INTO on the daemon's single synchronous
// connection: reading + rewriting the whole multi-GB file froze EVERY
// HTTP/WS request for the duration (30-90s on the production DB — audit
// L3-1, the single biggest "everything is slow" spike). This worker opens
// its own READ-ONLY connection, so the copy runs on a separate thread while
// the daemon keeps serving; WAL isolates it from concurrent writers and the
// periodic checkpoint loop absorbs the WAL growth afterwards.

import { vacuumSqliteInto } from '@/platform/persistence/sqlite/systemBackupVacuum'

declare const self: Worker

self.onmessage = (event: MessageEvent<{ dbPath: string; dest: string }>) => {
  const { dbPath, dest } = event.data
  try {
    vacuumSqliteInto({ dbPath, dest })
    postMessage({ ok: true as const })
  } catch (error) {
    postMessage({
      ok: false as const,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

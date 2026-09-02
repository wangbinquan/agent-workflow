// RFC-311 — off-thread `VACUUM INTO` for backups.
//
// The backup used to run VACUUM INTO on the daemon's single synchronous
// connection: reading + rewriting the whole multi-GB file froze EVERY
// HTTP/WS request for the duration (30-90s on the production DB — audit
// L3-1, the single biggest "everything is slow" spike). This worker opens
// its own READ-ONLY connection, so the copy runs on a separate thread while
// the daemon keeps serving; WAL isolates it from concurrent writers and the
// periodic checkpoint loop absorbs the WAL growth afterwards.

import {
  quickCheckSqlite,
  vacuumSqliteInto,
} from '@/platform/persistence/sqlite/systemBackupVacuum'

declare const self: Worker

/**
 * RFC-349 —— 同一个 worker 也承担 `PRAGMA quick_check`。它同样要把整个多 GB 文件
 * 读一遍（本机 4.2GB 实测 4.4 秒），同样是同步的，同样不能留在主线程上。
 */
export type BackupVacuumWorkerRequest =
  | { readonly dbPath: string; readonly dest: string }
  | { readonly quickCheckPath: string }

self.onmessage = (event: MessageEvent<BackupVacuumWorkerRequest>) => {
  try {
    if ('quickCheckPath' in event.data) quickCheckSqlite({ dbPath: event.data.quickCheckPath })
    else vacuumSqliteInto({ dbPath: event.data.dbPath, dest: event.data.dest })
    postMessage({ ok: true as const })
  } catch (error) {
    postMessage({
      ok: false as const,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

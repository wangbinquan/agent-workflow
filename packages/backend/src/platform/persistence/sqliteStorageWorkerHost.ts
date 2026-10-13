import { createLogger } from '@/util/log'
import {
  SQLITE_TABLE_STORAGE_SQL,
  type SqliteStorageReply,
  type SqliteTableStorage,
} from './sqliteStorageProtocol'

declare const AW_COMPILED_BUILD: boolean | undefined
const entry =
  typeof AW_COMPILED_BUILD === 'boolean' && AW_COMPILED_BUILD
    ? './platform/persistence/sqliteStorageWorker.ts'
    : new URL('./sqliteStorageWorker.ts', import.meta.url).href

/** This measurement may be expensive; its own thread and cancellation keep the daemon responsive. */
export function readSqliteTableStorage(
  file: string,
  signal?: AbortSignal,
): Promise<readonly SqliteTableStorage[]> {
  signal?.throwIfAborted()
  const worker = new Worker(entry)
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (result: readonly SqliteTableStorage[] | Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', cancel)
      worker.terminate()
      if (result instanceof Error) reject(result)
      else resolve(result)
    }
    const cancel = () =>
      finish(
        signal?.reason instanceof Error
          ? signal.reason
          : new DOMException('Storage sampling cancelled', 'AbortError'),
      )
    const timer = setTimeout(
      () => finish(new Error('SQLite table storage measurement timed out')),
      300000,
    )
    worker.onmessage = (event: MessageEvent<SqliteStorageReply>) => {
      const result = event.data
      if (!result.ok) return finish(new Error(result.error))
      if (
        !Array.isArray(result.tables) ||
        result.tables.some(
          (row) =>
            typeof row.name !== 'string' ||
            !/^(0|[1-9]\d*)$/.test(row.bytes) ||
            !/^(0|[1-9]\d*)$/.test(row.indexBytes),
        )
      )
        return finish(new Error('SQLite table storage measurement returned invalid counters'))
      if (result.ms >= 50)
        createLogger('db-slow').warn(
          `${Math.round(result.ms)}ms (cpu ${Math.round(result.cpuMs)}ms): ${SQLITE_TABLE_STORAGE_SQL}`,
        )
      finish(result.tables)
    }
    worker.onerror = (event) => {
      event.preventDefault()
      finish(new Error(event.message || 'SQLite table storage Worker failed'))
    }
    worker.addEventListener('close', () =>
      finish(new Error('SQLite table storage Worker exited before returning its measurement')),
    )
    signal?.addEventListener('abort', cancel, { once: true })
    if (signal?.aborted) cancel()
    else worker.postMessage({ file })
  })
}

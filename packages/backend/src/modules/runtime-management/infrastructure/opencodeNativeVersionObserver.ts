import { randomUUID } from 'node:crypto'
import {
  openReadonlySqliteDatabase,
  type ReadonlySqliteDatabase,
} from '@/platform/persistence/sqlite/readonlySqliteDatabase'
import { sha256Hex } from '@/util/hash'
import { opencodeNativeStoreGeneration } from './opencodeNativeStoreGeneration'
import type { HistoricalNativeVersionObserver } from '../application/ports/historicalNativeVersion'
import { HISTORICAL_NATIVE_NUMERIC_PAGE_VERSION } from '../application/ports/historicalNativeVersion'

/** The connection never enters a root BEGIN and never writes the original source. */
export function createOpencodeNativeVersionObserver(
  path: string | null,
  open: (path: string) => ReadonlySqliteDatabase = openReadonlySqliteDatabase,
): HistoricalNativeVersionObserver {
  let connection:
      | {
          readonly db: ReadonlySqliteDatabase
          readonly generation: string
          readonly epoch: string
          version: string
          revision: string
        }
      | undefined,
    tail: Promise<void> = Promise.resolve()
  const discard = () => {
    const previous = connection
    connection = undefined
    previous?.db.close()
  }
  const serialize = <T>(operation: () => Promise<T>): Promise<T> => {
    const work = tail.then(operation)
    tail = work.then(
      () => {},
      () => {},
    )
    return work
  }
  return {
    sample: () =>
      serialize(async () => {
        if (path === null) return null
        try {
          const before = await opencodeNativeStoreGeneration(path)
          if (before === null) {
            discard()
            return null
          }
          if (connection?.generation !== before) discard()
          if (!connection) {
            const db = open(path)
            connection = {
              db,
              generation: before,
              epoch: randomUUID(),
              version: '',
              revision: randomUUID(),
            }
          }
          const row = connection.db.query<{ data_version: number }, []>('PRAGMA data_version').get()
          if (!row || !Number.isSafeInteger(row.data_version) || row.data_version < 1)
            throw new Error('Original native data_version unavailable')
          const after = await opencodeNativeStoreGeneration(path)
          if (after !== before) {
            discard()
            return null
          }
          const version = String(row.data_version)
          if (connection.version && connection.version !== version)
            connection.revision = randomUUID()
          connection.version = version
          return {
            nativeSource: sha256Hex(JSON.stringify(['opencode-native-db', path])),
            sourceGeneration: before,
            connectionEpoch: connection.epoch,
            revisionToken: connection.revision,
            parserVersion: HISTORICAL_NATIVE_NUMERIC_PAGE_VERSION,
          }
        } catch {
          // This derived optimization cannot turn an unreadable source into empty statistics.
          // The original reader still runs and records its original failure/coverage semantics.
          discard()
          return null
        }
      }),
    close: () =>
      serialize(async () => {
        discard()
      }),
  }
}

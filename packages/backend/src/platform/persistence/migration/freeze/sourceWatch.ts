// RFC-626 §4.1: what one upgrade process remembers about the old database between the times
// it opens it. The assembly of the automatic upgrade owns the object for the whole session;
// every source handle only borrows it and never closes it, because a connection that is
// closed and opened again reports a `data_version` that cannot be compared with the earlier
// one. Nothing here survives the process: after a restart the readers confirm the content
// identity once more and remember a new baseline.
import type { Database } from 'bun:sqlite'
import { statSync, type BigIntStats } from 'node:fs'
import { resolve } from 'node:path'
import { assertSameFileIdentity } from '@/platform/execution/local/fileTrust'
import type { JsonValue } from '../conversion/types'
import { openSqliteForRead } from '../../sqlite/openForRead'

export interface SourceBaseline {
  /** What the reader needs to adopt its identity without measuring the database again. */
  readonly identity: JsonValue
  /**
   * The cheap evidence the identity was confirmed at. SQLite: the version of the held
   * connection. PostgreSQL: a digest of the row count of every table and the value of every
   * sequence. Equal evidence means the identity still holds; anything else means "measure".
   */
  readonly evidence: string
}
export interface SourceWatch {
  /**
   * The version of the file at `path`: `PRAGMA data_version` of a read-only connection this
   * object keeps open on the file. It changes when another connection, in any process, commits
   * a change, and it does not change otherwise; reading it does not depend on the size of the
   * data.
   *
   * A connection that no longer reads, or that no longer reads the file the path names (the
   * database was replaced by another file), is closed and replaced by a new one. The versions
   * of a replacement are never equal to any version an earlier connection gave, so whoever
   * compares them with a remembered one measures the content again (§4.1: a check that does not
   * pass falls back to the content identity). Throws when not even a new connection can read
   * the file — callers treat that as "the source may have changed".
   */
  sqliteDataVersion(path: string): number
  /** The baseline last remembered under a key the reader chooses for its source, if any. */
  baseline(key: string): SourceBaseline | undefined
  remember(key: string, baseline: SourceBaseline): void
  forget(key: string): void
  close(): void
}
export interface SourceWatchOptions {
  /** Opens the read-only connection on a file. Tests hand in one whose connections they break. */
  readonly openForRead?: (path: string) => Database
}
/** A connection reports a 32-bit `data_version`; each replacement counts from a span above. */
const VERSION_SPAN = 2 ** 32
interface HeldConnection {
  readonly database: Database
  /** The file the path named just before the connection was opened. */
  readonly file: BigIntStats
  /** Added to every version this connection reports: earlier connections' versions are lower. */
  readonly offset: number
}
export function createSourceWatch(options: SourceWatchOptions = {}): SourceWatch {
  const openForRead = options.openForRead ?? openSqliteForRead
  const connections = new Map<string, HeldConnection>()
  /** How many connections each file has had; it numbers the version span of the next one. */
  const opened = new Map<string, number>()
  const baselines = new Map<string, SourceBaseline>()
  let closed = false
  const drop = (path: string, held: HeldConnection) => {
    connections.delete(path)
    try {
      held.database.close()
    } catch {
      // A connection that no longer reads may not close cleanly either; it is gone all the same.
    }
  }
  /**
   * Whether the path still names the file the connection was opened on. A filesystem that
   * reports no file index cannot tell either way; there the version alone answers, as before.
   */
  const stillNamed = (path: string, held: HeldConnection) => {
    let current: BigIntStats
    try {
      current = statSync(path, { bigint: true })
    } catch {
      return false
    }
    const verdict = assertSameFileIdentity(held.file, current, process.platform)
    return verdict.trusted || verdict.reason === 'platform-unsupported'
  }
  const read = (held: HeldConnection) => {
    const row = held.database.query('PRAGMA data_version').get() as {
      readonly data_version?: unknown
    } | null
    if (typeof row?.data_version !== 'number') throw new Error('source-watch-data-version')
    return held.offset + (row.data_version >>> 0)
  }
  return {
    sqliteDataVersion(path) {
      if (closed) throw new Error('source-watch-closed')
      // One connection per file, however the path is spelled: versions read from two
      // connections cannot be compared, and a baseline is only worth its connection.
      const file = resolve(path)
      const held = connections.get(file)
      if (held) {
        if (stillNamed(file, held))
          try {
            return read(held)
          } catch {
            // RFC-626 §4.1 / G3-2: e.g. macOS SQLite fails every read of a connection once the
            // file gained or lost a name. Replaced below instead of failing every later freeze.
          }
        drop(file, held)
      }
      // The file is described before it is opened: replaced in between, the connection reads
      // the newer file and the next reading finds the description stale — one reopen too many,
      // never a replacement missed.
      const described = statSync(file, { bigint: true })
      const generation = opened.get(file) ?? 0
      opened.set(file, generation + 1)
      const fresh: HeldConnection = {
        database: openForRead(file),
        file: described,
        offset: generation * VERSION_SPAN,
      }
      connections.set(file, fresh)
      try {
        return read(fresh)
      } catch (error) {
        drop(file, fresh)
        throw error
      }
    },
    baseline: (key) => baselines.get(key),
    remember(key, baseline) {
      baselines.set(key, baseline)
    },
    forget(key) {
      baselines.delete(key)
    },
    close() {
      closed = true
      baselines.clear()
      for (const [file, held] of [...connections]) drop(file, held)
    },
  }
}

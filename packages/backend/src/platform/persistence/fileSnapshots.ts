// RFC-539 — whole-file snapshots in flight on one database (a backup's VACUUM INTO, a migration safety backup's copy
// and quick_check). The WAL checkpoint on that database skips while one is in flight: `wal_checkpoint(TRUNCATE)`
// meeting the snapshot's long-lived reader blocks for the whole busy_timeout on the daemon's synchronous connection.
// Each database handle's context carries one (sessionTables.ts); the daemon session hands its database's tracker to
// the snapshot takers that open their own connection and to the maintenance checkpoint gate.

/** RFC-539: one database's file snapshots in flight. */
export interface FileSnapshotTracker {
  /** Whether a snapshot is in flight right now. */
  readonly inFlight: () => boolean
  /** Count `run` as one snapshot while it runs (released when it settles, failure included). */
  readonly track: <T>(run: () => Promise<T>) => Promise<T>
}

export function createFileSnapshotTracker(): FileSnapshotTracker {
  let active = 0
  return Object.freeze({
    inFlight: () => active > 0,
    async track<T>(run: () => Promise<T>): Promise<T> {
      active += 1
      try {
        return await run()
      } finally {
        active -= 1
      }
    },
  })
}

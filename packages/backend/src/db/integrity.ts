// RFC-213 — SQLite integrity check (PRAGMA quick_check).
//
// quick_check is ~an order of magnitude faster than integrity_check and still
// catches structural corruption (btree page errors, malformed records). Used
// by: restore (gate the INCOMING backup DB), doctor (read-only health), and the
// boot gate in db/client.ts (fail-closed).
//
// Design-gate note: a truncated/header-clobbered file throws at OPEN or the
// first PRAGMA (before quick_check runs); only a header-intact, page-corrupt
// file actually reaches quick_check and returns non-'ok' rows. Both paths must
// be treated as corrupt — hence the catch below folds an open/PRAGMA throw into
// `{ ok: false }` rather than letting it escape.

import { Database } from 'bun:sqlite'

export interface IntegrityResult {
  ok: boolean
  /** quick_check output rows (or the open/PRAGMA error message) when not ok. */
  errors: string[]
}

/**
 * Run `PRAGMA quick_check` against `dbPath`. Returns `{ ok:false }` (never
 * throws) for a corrupt / not-a-database file, so callers decide the policy
 * (restore refuses, boot fails closed, doctor reports).
 *
 * The default connection is read-only. A checkpointed backup copy may lack
 * WAL/SHM sidecars; its owner can allow SQLite to create those auxiliary files.
 * That check still only reads the database and never creates a missing DB.
 */
export function quickCheckDbFile(
  dbPath: string,
  options: { allowWalSidecarCreation?: boolean } = {},
): IntegrityResult {
  let db: Database | null = null
  try {
    db = new Database(
      dbPath,
      options.allowWalSidecarCreation ? { readwrite: true, create: false } : { readonly: true },
    )
    const rows = db.query('PRAGMA quick_check;').all() as { quick_check: string }[]
    const ok = rows.length === 1 && rows[0]?.quick_check === 'ok'
    return { ok, errors: ok ? [] : rows.map((r) => r.quick_check) }
  } catch (err) {
    return { ok: false, errors: [err instanceof Error ? err.message : String(err)] }
  } finally {
    db?.close()
  }
}

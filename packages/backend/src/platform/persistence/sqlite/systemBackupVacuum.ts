// RFC-311/RFC-349 — System Operations SQLite VACUUM INTO mechanism. The Worker entry
// delegates here so provider-specific SQL never leaks into a service surface.

import { Database } from 'bun:sqlite'

export function vacuumSqliteInto(input: { readonly dbPath: string; readonly dest: string }): void {
  const source = new Database(input.dbPath, { readonly: true })
  try {
    source.exec('PRAGMA busy_timeout = 30000;')
    source.exec(`VACUUM INTO '${input.dest.replaceAll("'", "''")}'`)
  } finally {
    source.close()
  }
}

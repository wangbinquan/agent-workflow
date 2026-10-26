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

/**
 * RFC-349 —— 备份完整性校验的 SQLite 机制。
 *
 * `PRAGMA quick_check` 要把整个文件读一遍：本机对 4.2GB 的库实测 **4.4 秒**，
 * 而 bun:sqlite 是同步的。放在 daemon 主线程上就是全站冻结这么久——RFC-311 §6.6
 * 消灭的正是这类停顿，那次只把 `VACUUM INTO` 挪到了 worker，校验留在了主线程。
 */
export function quickCheckSqlite(input: { readonly dbPath: string }): void {
  const database = new Database(input.dbPath, { readonly: true })
  try {
    const rows = database.query('PRAGMA quick_check').all() as { quick_check: string }[]
    if (rows.length !== 1 || rows[0]?.quick_check !== 'ok') {
      throw new Error('SQLite quick_check failed')
    }
  } finally {
    database.close()
  }
}

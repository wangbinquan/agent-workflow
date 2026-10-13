export const SQLITE_TABLE_STORAGE_SQL = `SELECT s.tbl_name AS name,cast(sum(d.pgsize) AS text) AS bytes,cast(sum(CASE WHEN s.type='index' THEN d.pgsize ELSE 0 END) AS text) AS indexBytes FROM dbstat('main',1) d JOIN sqlite_schema s ON s.name=d.name GROUP BY s.tbl_name ORDER BY s.tbl_name`
export interface SqliteTableStorage {
  readonly name: string
  readonly bytes: string
  readonly indexBytes: string
}
export type SqliteStorageReply =
  | {
      readonly ok: true
      readonly tables: readonly SqliteTableStorage[]
      readonly ms: number
      readonly cpuMs: number
    }
  | { readonly ok: false; readonly error: string }

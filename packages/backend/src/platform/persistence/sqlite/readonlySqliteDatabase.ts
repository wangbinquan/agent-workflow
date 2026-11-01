import { openSqliteForRead } from '@/platform/persistence/sqlite/openForRead'

export interface ReadonlySqliteStatement<Row, Parameters extends readonly unknown[]> {
  get(...parameters: Parameters): Row | null
  all(...parameters: Parameters): Row[]
}

/** Narrow read-only capability for provider-owned/native SQLite artifacts. */
export interface ReadonlySqliteDatabase {
  query<Row, Parameters extends readonly unknown[]>(
    sql: string,
  ): ReadonlySqliteStatement<Row, Parameters>
  close(): void
}

export function openReadonlySqliteDatabase(path: string): ReadonlySqliteDatabase {
  return openSqliteForRead(path) as unknown as ReadonlySqliteDatabase
}

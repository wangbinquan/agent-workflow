import { stat, statfs } from 'node:fs/promises'
import { sql } from 'drizzle-orm'
import type { ProviderNeutralDatabase } from '@/db/query'
import { readSqliteTableStorage } from './sqliteStorageWorkerHost'
export interface DatabaseStorageUsage {
  readonly databaseBytes: string
  readonly reusableBytes: string | null
  readonly freeBytes: string | null
  readonly tables: readonly { name: string; bytes: string; indexBytes: string }[] | null
}
/** Native engine observations. Remote PostgreSQL never borrows the application's disk space. */
export async function postgresqlStorageUsage(
  db: ProviderNeutralDatabase,
): Promise<DatabaseStorageUsage> {
  const size = await db.get<{ bytes: string }>(
    sql`SELECT pg_database_size(current_database())::text AS bytes`,
  )
  const tables = await db.all<{ name: string; bytes: string; indexBytes: string }>(
    sql`SELECT c.relname AS name,pg_total_relation_size(c.oid)::text AS bytes,pg_indexes_size(c.oid)::text AS "indexBytes" FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=current_schema() AND c.relkind='r' ORDER BY c.relname`,
  )
  return { databaseBytes: String(size?.bytes ?? '0'), reusableBytes: null, freeBytes: null, tables }
}
export async function sqliteStorageUsage(
  db: ProviderNeutralDatabase,
  signal?: AbortSignal,
): Promise<DatabaseStorageUsage> {
  signal?.throwIfAborted()
  const pages = await db.get<{ page_count: number }>(sql`PRAGMA page_count`),
    size = await db.get<{ page_size: number }>(sql`PRAGMA page_size`),
    unused = await db.get<{ freelist_count: number }>(sql`PRAGMA freelist_count`)
  const files = await db.all<{ name: string; file: string }>(sql`PRAGMA database_list`),
    file = files.find((x) => x.name === 'main')?.file
  let freeBytes: string | null = null,
    wal = 0n
  if (file) {
    try {
      const volume = await statfs(file, { bigint: true })
      freeBytes = String(volume.bavail * volume.bsize)
    } catch {
      /* No evidence is reported as unknown. */
    }
    try {
      wal = (await stat(file + '-wal', { bigint: true })).size
    } catch {
      /* No WAL is common after checkpoint. */
    }
  }
  let tables: DatabaseStorageUsage['tables'] = null
  try {
    if (file) tables = await readSqliteTableStorage(file, signal)
  } catch {
    signal?.throwIfAborted()
    /* Some SQLite builds do not expose dbstat; total and reusable size remain observed. */
  }
  return {
    databaseBytes: String(BigInt(pages?.page_count ?? 0) * BigInt(size?.page_size ?? 0) + wal),
    reusableBytes: String(BigInt(unused?.freelist_count ?? 0) * BigInt(size?.page_size ?? 0)),
    freeBytes,
    tables,
  }
}

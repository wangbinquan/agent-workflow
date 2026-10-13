import { stat, statfs } from 'node:fs/promises'
import { sql } from 'drizzle-orm'
import type { ProviderNeutralDatabase } from '@/db/query'
import { readSqliteTableStorage, readSqliteStorageCounters } from './sqliteStorageWorkerHost'
import {
  decodeDatabaseStorageCounters,
  type DatabaseStorageCounters,
} from './sqliteStorageProtocol'
import {
  observationProjectionChanges as changes,
  observationProjectionWork as work,
} from '@/db/observationProjection'
import {
  observationWorkRetention as workRetention,
  observationReportLeases as leases,
} from '@/db/observationStorage'
export type { DatabaseStorageCounters } from './sqliteStorageProtocol'
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
  const size = (
    await db.all<{ bytes: string }>(sql`SELECT pg_database_size(current_database())::text AS bytes`)
  )[0]
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
  const pages = (await db.all<{ page_count: number }>(sql`PRAGMA page_count`))[0],
    size = (await db.all<{ page_size: number }>(sql`PRAGMA page_size`))[0],
    unused = (await db.all<{ freelist_count: number }>(sql`PRAGMA freelist_count`))[0]
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

/** PostgreSQL awaits its native connection; the memory-only SQLite fixture
 * uses the same complete original queries without a nonexistent physical file. */
export async function postgresqlStorageCounters(
  db: ProviderNeutralDatabase,
  signal?: AbortSignal,
): Promise<DatabaseStorageCounters> {
  signal?.throwIfAborted()
  // A single statement also makes PostgreSQL counters share one original
  // snapshot: a concurrent source-to-work transfer cannot be counted twice.
  const row = (
    await db.all<{
      pending: string
      oldest: number | string | null
      workPending: string
      workOldest: number | string | null
      active: string
      retiring: string
    }>(sql`SELECT q.pending,q.oldest,w.pending AS "workPending",w.oldest AS "workOldest",r.active,r.retiring
    FROM (SELECT cast(count(*) AS text) AS pending,min(created_at) AS oldest FROM ${changes} WHERE completed=false) q
    CROSS JOIN (SELECT cast(count(*) AS text) AS pending,min(nullif(p.queued_at,0)) AS oldest FROM ${work} w LEFT JOIN ${workRetention} p ON p.id=w.id WHERE w.completed_revision IS NULL) w
    CROSS JOIN (SELECT cast(coalesce(sum(CASE WHEN retiring=false THEN 1 ELSE 0 END),0) AS text) AS active,cast(coalesce(sum(CASE WHEN retiring=true THEN 1 ELSE 0 END),0) AS text) AS retiring FROM ${leases}) r`)
  )[0]
  signal?.throwIfAborted()
  return decodeDatabaseStorageCounters(
    row,
    row ? { pending: row.workPending, oldest: row.workOldest } : undefined,
    row,
  )
}
export async function sqliteStorageCounters(
  db: ProviderNeutralDatabase,
  signal?: AbortSignal,
): Promise<DatabaseStorageCounters> {
  signal?.throwIfAborted()
  const files = await db.all<{ name: string; file: string }>(sql`PRAGMA database_list`),
    file = files.find((item) => item.name === 'main')?.file
  return file ? readSqliteStorageCounters(file, signal) : postgresqlStorageCounters(db, signal)
}

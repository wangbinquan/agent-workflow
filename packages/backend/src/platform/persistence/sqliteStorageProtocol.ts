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
  | {
      readonly ok: true
      readonly counters: DatabaseStorageCounters
      readonly ms: number
      readonly cpuMs: number
    }
  | { readonly ok: false; readonly error: string }

export const SQLITE_OBSERVATION_STORAGE_SQL = [
  `SELECT cast(count(*) AS text) AS pending,min(created_at) AS oldest FROM observation_projection_changes WHERE completed=false`,
  `SELECT cast(count(*) AS text) AS pending,min(nullif(p.queued_at,0)) AS oldest FROM observation_projection_work w LEFT JOIN observation_work_retention p ON p.id=w.id WHERE w.completed_revision IS NULL`,
  `SELECT cast(coalesce(sum(CASE WHEN retiring=false THEN 1 ELSE 0 END),0) AS text) AS active,cast(coalesce(sum(CASE WHEN retiring=true THEN 1 ELSE 0 END),0) AS text) AS retiring FROM observation_report_leases`,
] as const
export interface DatabaseStorageCounters {
  readonly pending: string
  readonly oldestPendingAt: number | null
  readonly activeReports: string
  readonly retiringReports: string
}
export function decodeDatabaseStorageCounters(
  queue: { pending: string; oldest: number | string | null } | undefined,
  unfinished: { pending: string; oldest: number | string | null } | undefined,
  reports: { active: string; retiring: string } | undefined,
): DatabaseStorageCounters {
  if (!queue || !unfinished || !reports) throw new Error('Original storage counter row missing')
  for (const value of [queue.pending, unfinished.pending, reports.active, reports.retiring])
    if (!/^(0|[1-9]\d*)$/.test(value)) throw new Error('Original storage counter invalid')
  const clocks = [queue.oldest, unfinished.oldest].filter((at) => at !== null).map(Number)
  if (clocks.some((at) => !Number.isSafeInteger(at) || at < 0))
    throw new Error('Original storage counter clock invalid')
  return {
    pending: String(BigInt(queue.pending) + BigInt(unfinished.pending)),
    oldestPendingAt: clocks.length ? Math.min(...clocks) : null,
    activeReports: reports.active,
    retiringReports: reports.retiring,
  }
}

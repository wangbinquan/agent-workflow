import { eq, sql, type SQL } from 'drizzle-orm'
import type { SQLiteTable } from 'drizzle-orm/sqlite-core'
import type { ProviderNeutralDatabase } from '@/db/query'
import {
  databaseSessionFor,
  type DatabaseTransaction,
} from '@/platform/persistence/databaseTransaction'
import {
  observationWorkRetention as workRetention,
  observationReportLeases as leases,
  observationScopeRefs as refs,
  observationStorageState as state,
} from '@/db/observationStorage'
import { observationMaintenanceOperations as maintenance } from '@/db/observationAnalysis'
import {
  observationReports as reports,
  observationReportRows,
  observationReportPages,
  observationReportCounts,
  observationReportReceipts,
  observationReportRetainedRevisions,
} from '@/db/observationReports'
import {
  observationProjectionHeads as heads,
  observationProjectionHistory as history,
  observationProjectionMemberships as members,
  observationProjectionVersions as versions,
  observationProjectionViews as views,
  observationProjectionWork as work,
  observationProjectionPrepared as prepared,
  observationProjectionWorkComponents as components,
  observationProjectionChanges as changes,
  observationProjectionQueryScopes as scopes,
  observationProjectionQueryScopeMembers as scopeMembers,
  observationProjectionDescriptors as descriptors,
  observationProjectionCurrent as current,
  observationProjectionIndexedVersions as indexed,
} from '@/db/observationProjection'
import { admitObservationStorage } from './observationStorageLifetime'
import { qualifiedObservationIndexChannel } from '../domain/qualifiedObservationIndexes'
import { jsonPathText } from '@/platform/persistence/jsonPathText'
const indexPrefix = qualifiedObservationIndexChannel + '/'
const indexRevision = sql`CASE WHEN substr(${indexed.revision},1,${indexPrefix.length})=${indexPrefix} THEN substr(${indexed.revision},${indexPrefix.length + 1}) ELSE ${indexed.revision} END`
const decimalLte = (value: SQL, ceiling: string) =>
  sql`(length(${value})<${ceiling.length} OR (length(${value})=${ceiling.length} AND ${value}<=${ceiling}))`
async function remove(
  tx: DatabaseTransaction,
  table: SQLiteTable,
  keys: readonly string[],
  condition: SQL,
) {
  const columns = sql.join(
    keys.map((k) => sql`${sql.identifier(k)}`),
    sql`, `,
  )
  const rows = await tx.all(
    sql`DELETE FROM ${table} WHERE (${columns}) IN (SELECT ${columns} FROM ${table} WHERE ${condition} LIMIT 500) RETURNING ${sql.identifier(keys[0]!)}`,
  )
  return rows.length
}
/** Scan one ordered key page, including currently protected rows, so a large live prefix cannot stall GC. */
async function sweep(
  tx: DatabaseTransaction,
  table: SQLiteTable,
  keys: readonly string[],
  name: string,
  condition: SQL,
  onScanned?: (rows: number) => void,
) {
  const saved = await tx
      .select()
      .from(state)
      .where(eq(state.key, 'cursor/' + name))
      .get(),
    cursor = saved ? (JSON.parse(saved.document) as string[]) : null,
    columns = sql.join(
      keys.map((k) => sql`${sql.identifier(k)}`),
      sql`, `,
    )
  const start = cursor
    ? sql`(${columns})>(${sql.join(
        cursor.map((x) => sql`${x}`),
        sql`, `,
      )})`
    : sql`true`
  const rows = await tx.all<Record<string, string>>(
    sql`SELECT ${columns} FROM ${table} WHERE ${start} ORDER BY ${columns} LIMIT 500`,
  )
  onScanned?.(rows.length)
  const end = rows.length ? keys.map((k) => String(rows.at(-1)![k])) : null
  let removed = 0
  if (end) {
    const upper = sql`(${columns})<=(${sql.join(
      end.map((x) => sql`${x}`),
      sql`, `,
    )})`
    removed = await remove(tx, table, keys, sql`${start} AND ${upper} AND ${condition}`)
  }
  const document = JSON.stringify(end)
  await tx
    .insert(state)
    .values({ key: 'cursor/' + name, document })
    .onConflictDoUpdate({ target: state.key, set: { document } })
    .run()
  return removed
}
/** Every target is a closed derived-table allowlist. Scheduling packets never bound source population. */
export async function collectObservationStorage(
  db: ProviderNeutralDatabase,
  onScanned?: (rows: number) => void,
) {
  let scanned = 0
  const removed = await databaseSessionFor(db).transaction(async (tx) => {
    const trackedSweep = (
      table: SQLiteTable,
      keys: readonly string[],
      name: string,
      condition: SQL,
    ) =>
      sweep(tx, table, keys, name, condition, (rows) => {
        scanned += rows
      })
    await admitObservationStorage(tx)
    const expired = sql`retiring=false AND expires_at<${Date.now()} AND NOT EXISTS(SELECT 1 FROM ${maintenance} m WHERE ${jsonPathText(tx, sql`m.document`, ['request', 'reportId'])}=${leases.id} AND m.state IN ('preparing','preview','running')) AND NOT EXISTS(SELECT 1 FROM ${reports} r WHERE r.id=${leases.id} AND r.state='building' AND r.lease_until>${Date.now()})`
    await tx.run(
      sql`UPDATE ${leases} SET retiring=true,request_key=NULL WHERE id IN(SELECT id FROM ${leases} WHERE ${expired} ORDER BY expires_at,id LIMIT 100)`,
    )
    await tx.run(
      sql`UPDATE ${reports} SET request_key='retired/'||id WHERE id IN(SELECT id FROM ${leases} WHERE retiring=true) AND request_key<>'retired/'||id`,
    )
    let removed = 0
    const retired = sql`report_id IN (SELECT id FROM ${leases} WHERE retiring=true)`
    for (const [table, keys] of [
      [observationReportRows, ['report_id', 'ordinal']],
      [observationReportPages, ['report_id', 'ordinal']],
      [observationReportCounts, ['report_id', 'section', 'parent']],
      [observationReportReceipts, ['report_id', 'key']],
      [observationReportRetainedRevisions, ['report_id']],
    ] as const)
      removed += await remove(tx, table, keys, retired)
    removed += await remove(
      tx,
      refs,
      ['view_id', 'scope'],
      sql`view_id IN(SELECT id FROM ${leases} WHERE retiring=true)`,
    )
    removed += await remove(
      tx,
      views,
      ['id'],
      sql`id IN(SELECT id FROM ${leases} WHERE retiring=true) AND NOT EXISTS(SELECT 1 FROM ${refs} r WHERE r.view_id=${views.id})`,
    )
    const empty = sql`id IN(SELECT id FROM ${leases} WHERE retiring=true) AND NOT EXISTS(SELECT 1 FROM ${observationReportRows} r WHERE r.report_id=${reports.id}) AND NOT EXISTS(SELECT 1 FROM ${observationReportPages} r WHERE r.report_id=${reports.id}) AND NOT EXISTS(SELECT 1 FROM ${observationReportCounts} r WHERE r.report_id=${reports.id}) AND NOT EXISTS(SELECT 1 FROM ${observationReportReceipts} r WHERE r.report_id=${reports.id}) AND NOT EXISTS(SELECT 1 FROM ${observationReportRetainedRevisions} r WHERE r.report_id=${reports.id})`
    removed += await remove(tx, reports, ['id'], empty)
    removed += await remove(
      tx,
      leases,
      ['id'],
      sql`retiring=true AND NOT EXISTS(SELECT 1 FROM ${views} v WHERE v.id=${leases.id}) AND NOT EXISTS(SELECT 1 FROM ${reports} r WHERE r.id=${leases.id})`,
    )
    removed += await trackedSweep(
      scopeMembers,
      ['scope', 'kind', 'identity'],
      'scope-members',
      sql`NOT EXISTS(SELECT 1 FROM ${refs} r WHERE r.scope=${scopeMembers.scope})`,
    )
    removed += await trackedSweep(
      scopes,
      ['id'],
      'scopes',
      sql`NOT EXISTS(SELECT 1 FROM ${refs} r WHERE r.scope=${scopes.id}) AND NOT EXISTS(SELECT 1 FROM ${scopeMembers} m WHERE m.scope=${scopes.id})`,
    )
    const floorRows = await tx.all<{ revision: string }>(
      sql`SELECT revision FROM (SELECT revision FROM ${heads} WHERE id='incremental-20261012-v1' UNION ALL SELECT revision FROM ${leases} WHERE retiring=false AND revision IS NOT NULL UNION ALL SELECT p.revision FROM ${workRetention} p JOIN ${work} w ON w.id=p.id WHERE w.completed_revision IS NULL AND w.applied_revision IS NULL AND p.revision IS NOT NULL) protected ORDER BY length(revision),revision LIMIT 1`,
    )
    const floor = floorRows[0]?.revision
    if (floor !== undefined) {
      // A [3,12) row remains visible at 7. Only closed intervals ending at/before the floor expire.
      removed += await trackedSweep(
        history,
        ['kind', 'key', 'from_revision'],
        'history',
        sql`to_revision IS NOT NULL AND ${decimalLte(sql`to_revision`, floor)}`,
      )
      removed += await trackedSweep(
        members,
        ['aggregate', 'key', 'from_revision'],
        'members',
        sql`to_revision IS NOT NULL AND ${decimalLte(sql`to_revision`, floor)}`,
      )
      removed += await trackedSweep(
        versions,
        ['revision'],
        'versions',
        sql`revision<>${floor} AND ${decimalLte(sql`revision`, floor)}`,
      )
      removed += await trackedSweep(
        indexed,
        ['revision'],
        'indexed',
        // Both legacy decimal receipts and current algorithm-qualified receipts
        // live exactly as long as their original immutable version.
        sql`NOT EXISTS(SELECT 1 FROM ${versions} v WHERE v.revision=${indexRevision})`,
      )
    }
    removed += await trackedSweep(
      descriptors,
      ['key'],
      'descriptors',
      sql`NOT EXISTS(SELECT 1 FROM ${history} h WHERE h.kind IN ('contribution','aggregate') AND h.key=${descriptors.key}) AND NOT EXISTS(SELECT 1 FROM ${current} c WHERE c.kind IN ('contribution','aggregate') AND c.key=${descriptors.key})`,
    )
    // The original producer row was acknowledged only after durable work registration. Its notification is disposable.
    removed += await remove(tx, changes, ['id'], sql`completed=true`)
    removed += await trackedSweep(
      prepared,
      ['work_id', 'key'],
      'prepared',
      sql`EXISTS(SELECT 1 FROM ${work} w WHERE w.id=${prepared.workId} AND w.completed_revision IS NOT NULL AND w.applied_revision IS NOT NULL)`,
    )
    removed += await trackedSweep(
      components,
      ['work_id', 'component'],
      'components',
      sql`EXISTS(SELECT 1 FROM ${work} w WHERE w.id=${components.workId} AND w.completed_revision IS NOT NULL AND w.applied_revision IS NOT NULL)`,
    )
    removed += await trackedSweep(
      work,
      ['id'],
      'work',
      sql`id LIKE 'changes/%' AND completed_revision IS NOT NULL AND applied_revision IS NOT NULL AND NOT EXISTS(SELECT 1 FROM ${prepared} p WHERE p.work_id=${work.id}) AND NOT EXISTS(SELECT 1 FROM ${components} c WHERE c.work_id=${work.id})`,
    )
    removed += await trackedSweep(
      workRetention,
      ['id'],
      'work-retention',
      sql`NOT EXISTS(SELECT 1 FROM ${work} w WHERE w.id=${workRetention.id})`,
    )
    const prior = await tx.select().from(state).where(eq(state.key, 'gc')).get(),
      old = prior ? (JSON.parse(prior.document) as { reclaimed?: string }) : {}
    await tx
      .insert(state)
      .values({
        key: 'gc',
        document: JSON.stringify({
          lastSuccess: Date.now(),
          lastError: null,
          reclaimed: String(BigInt(old.reclaimed ?? '0') + BigInt(removed)),
        }),
      })
      .onConflictDoUpdate({
        target: state.key,
        set: {
          document: JSON.stringify({
            lastSuccess: Date.now(),
            lastError: null,
            reclaimed: String(BigInt(old.reclaimed ?? '0') + BigInt(removed)),
          }),
        },
      })
      .run()
    return removed
  })
  onScanned?.(scanned)
  return removed
}

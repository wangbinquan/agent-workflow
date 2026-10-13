import { eq, desc, sql } from 'drizzle-orm'
import { ObservationStorageSchema, type ObservationStorage } from '@agent-workflow/shared'
import type { ProviderNeutralDatabase } from '@/db/query'
import { engineOf } from '@/platform/persistence/databaseTransaction'
import {
  observationWorkRetention as workRetention,
  observationReportLeases as leases,
  observationStorageState as state,
  observationStorageSamples as samples,
} from '@/db/observationStorage'
import {
  observationProjectionChanges as changes,
  observationProjectionWork as work,
} from '@/db/observationProjection'
const derived = (name: string) =>
  /^(observation_projection_|observation_work_retention|observation_calculation_|observation_report|observation_scope_|observation_storage_)/.test(
    name,
  )
const observed = (name: string) =>
  /^(observation_|invocation_usage|runtime_usage|native_observation|system_agent_observation)/.test(
    name,
  )
/** Page reads use the latest sample; a daily row is updated at most once an hour. */
export function observationStorageStatus(db: ProviderNeutralDatabase, now = Date.now) {
  const measurements = new Set<AbortController>()
  let samplingStopped = false
  async function sample() {
    if (samplingStopped) return
    const at = now(),
      last = await db.select().from(samples).orderBy(desc(samples.day)).get()
    if (last && at - last.sampledAt < 3600000) return
    if (samplingStopped) return
    const control = new AbortController()
    measurements.add(control)
    const measured = await engineOf(db)
        .storageUsage(db, control.signal)
        .finally(() => measurements.delete(control)),
      day = new Date(at).toISOString().slice(0, 10),
      previous = await db
        .select()
        .from(samples)
        .where(sql`${samples.day}<${day}`)
        .orderBy(desc(samples.day))
        .get(),
      old = previous ? (JSON.parse(previous.document) as { databaseBytes: string }) : null
    control.signal.throwIfAborted()
    if (samplingStopped) return
    const diff = old ? BigInt(measured.databaseBytes) - BigInt(old.databaseBytes) : null,
      growth =
        diff === null
          ? null
          : String(
              ((diff > 0n ? diff : 0n) * 86400000n) / BigInt(Math.max(1, at - previous!.sampledAt)),
            ),
      sum = (select: (name: string) => boolean) =>
        measured.tables === null
          ? null
          : String(
              measured.tables
                .filter((row) => select(row.name))
                .reduce((n, row) => n + BigInt(row.bytes), 0n),
            )
    const document = {
      databaseBytes: measured.databaseBytes,
      reusableBytes: measured.reusableBytes,
      freeBytes: measured.freeBytes,
      factsBytes: sum((name) => observed(name) && !derived(name)),
      derivedBytes: sum(derived),
      indexBytes:
        measured.tables === null
          ? null
          : String(
              measured.tables
                .filter((row) => observed(row.name))
                .reduce((n, row) => n + BigInt(row.indexBytes), 0n),
            ),
      growthBytesPerDay: growth,
      daysRemaining:
        measured.freeBytes !== null && growth !== null && BigInt(growth) > 0n
          ? Number((BigInt(measured.freeBytes) * 100n) / BigInt(growth)) / 100
          : null,
    }
    await db
      .insert(samples)
      .values({ day, sampledAt: at, document: JSON.stringify(document) })
      .onConflictDoUpdate({
        target: samples.day,
        set: { sampledAt: at, document: JSON.stringify(document) },
      })
      .run()
  }
  async function read(): Promise<ObservationStorage> {
    const latest = await db.select().from(samples).orderBy(desc(samples.day)).get(),
      gc = await db.select().from(state).where(eq(state.key, 'gc')).get(),
      queue = await db.get<{ pending: string; oldest: number | null }>(
        sql`SELECT cast(count(*) AS text) AS pending,min(created_at) AS oldest FROM ${changes} WHERE completed=false`,
      ),
      unfinished = await db.get<{ pending: string; oldest: number | null }>(
        sql`SELECT cast(count(*) AS text) AS pending,min(nullif(p.queued_at,0)) AS oldest FROM ${work} w LEFT JOIN ${workRetention} p ON p.id=w.id WHERE w.completed_revision IS NULL`,
      ),
      reports = await db.get<{ active: string; retiring: string }>(
        sql`SELECT cast(coalesce(sum(CASE WHEN retiring=false THEN 1 ELSE 0 END),0) AS text) AS active,cast(coalesce(sum(CASE WHEN retiring=true THEN 1 ELSE 0 END),0) AS text) AS retiring FROM ${leases}`,
      )
    return ObservationStorageSchema.parse({
      sampledAt: latest?.sampledAt ?? null,
      databaseBytes: null,
      reusableBytes: null,
      freeBytes: null,
      factsBytes: null,
      derivedBytes: null,
      indexBytes: null,
      growthBytesPerDay: null,
      daysRemaining: null,
      ...(latest ? JSON.parse(latest.document) : {}),
      pending: String(BigInt(queue?.pending ?? '0') + BigInt(unfinished?.pending ?? '0')),
      oldestPendingAt: [queue?.oldest, unfinished?.oldest].filter(
        (v): v is number => v !== null && v !== undefined,
      ).length
        ? Math.min(
            ...[queue?.oldest, unfinished?.oldest]
              .filter((v): v is number => v !== null && v !== undefined)
              .map(Number),
          )
        : null,
      activeReports: String(reports?.active ?? '0'),
      retiringReports: String(reports?.retiring ?? '0'),
      lastSuccess: null,
      lastError: null,
      reclaimed: '0',
      ...(gc ? JSON.parse(gc.document) : {}),
      retentionDays: 7,
    })
  }
  async function failed(error: unknown) {
    const row = await db.select().from(state).where(eq(state.key, 'gc')).get(),
      value = {
        ...(row ? JSON.parse(row.document) : {}),
        lastError: error instanceof Error ? error.message : String(error),
      }
    await db
      .insert(state)
      .values({ key: 'gc', document: JSON.stringify(value) })
      .onConflictDoUpdate({ target: state.key, set: { document: JSON.stringify(value) } })
      .run()
  }
  return {
    sample,
    read,
    failed,
    cancelSample() {
      samplingStopped = true
      for (const control of measurements)
        control.abort(new DOMException('Storage sampling stopped', 'AbortError'))
    },
    resumeSample() {
      samplingStopped = false
    },
  }
}

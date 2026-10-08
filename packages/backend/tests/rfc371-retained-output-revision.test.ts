import { createCompleteTaskObservationFacts } from '@/modules/task-execution/composition/taskObservationFacts'
// RFC-371 locks qualification to real native mutations, not a cached manifest or unchanged row count.
import { expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import { buildActor } from '@/auth/actor'
import {
  observationReports,
  observationReportPages,
  observationReportRows,
  observationReportCounts,
  observationReportReceipts,
  observationReportRetainedRevisions,
  users,
} from '@/db/schema'
import { completeObservationReportCache } from '@/modules/run-observability/infrastructure/completeObservationReportStore'
import { completeObservationActorScope } from '@/modules/run-observability/infrastructure/completeObservationReportDocuments'
import type {
  CompleteObservationManifest,
  CompleteObservationStoredReport,
} from '@/modules/run-observability/ports/completeObservationReport'
import type { ProviderHarness } from './helpers/eachProvider'
import { describeEachProvider } from './helpers/eachProvider'
import { seedCompleteTask, COMPLETE_NOW } from './helpers/rfc371CompleteTaskFixture'

const actor = buildActor({
  source: 'session',
  user: {
    id: 'complete-task-reader',
    username: 'complete-task-reader',
    displayName: 'Complete reader',
    role: 'admin',
    status: 'active',
  },
})
const query = { from: COMPLETE_NOW, to: COMPLETE_NOW + 60_000, timezone: 'UTC' }
const generation = 'retained-revision-fixture'
const scope = completeObservationActorScope(actor)
const changed = 'retained output differs from its original seal'

async function seal(harness: ProviderHarness, pending: CompleteObservationStoredReport) {
  const id = pending.id
  await harness.db
    .insert(observationReportPages)
    .values({ reportId: id, ordinal: '0', previousDigest: '0', digest: 'fixture', itemsCount: 1 })
    .run()
  await harness.db
    .insert(observationReportRows)
    .values({
      reportId: id,
      ordinal: '0',
      section: 'tasks',
      parent: '',
      key: 'complete-original-task',
      document: '{"task":{"id":"complete-original-task"}}',
    })
    .run()
  await harness.db
    .insert(observationReportCounts)
    .values({ reportId: id, section: 'tasks', parent: '', total: '1', actual: '1', declared: true })
    .run()
  await harness.db
    .insert(observationReportReceipts)
    .values({ reportId: id, key: 'fixture', document: '{}' })
    .run()
  const manifest: CompleteObservationManifest = {
    reportId: id,
    owner: pending.owner,
    requestKey: pending.requestKey,
    pages: '1',
    rows: '1',
    counts: '1',
    receipts: '1',
    digest: '0'.repeat(64),
    header: {
      reportId: id,
      projectionVersion: 2,
      generation,
      snapshotId: 'fixture',
      asOf: COMPLETE_NOW,
      sourceRevision: 'fixture',
      actorScope: scope,
      authorizationRevision: '0',
      filters: query,
      taskId: null,
    },
    summary: {
      metrics: { state: 'not-applicable' },
      inventory: {
        tasks: '1',
        attempts: '0',
        invocations: '0',
        numericRecords: '0',
        nativeCaptures: '0',
      },
      statuses: {},
      timing: { p50Ms: null, p95Ms: null, wallMs: '0', runningMs: '0', unknown: '0' },
      rootTask: null,
    },
  }
  await harness.db
    .update(observationReports)
    .set({
      state: 'ready',
      manifest: JSON.stringify(manifest),
      report: JSON.stringify({
        state: 'ready',
        header: manifest.header,
        summary: manifest.summary,
        counts: { tasks: '1' },
      }),
    })
    .where(eq(observationReports.id, id))
    .run()
}
async function fixture(harness: ProviderHarness) {
  const cache = completeObservationReportCache(
    harness.db,
    generation,
    createCompleteTaskObservationFacts,
  )
  const key = randomUUID()
  const pending = await cache.ensure(
    { actor, query, refreshKey: key },
    key,
    scope,
    randomUUID(),
    randomUUID(),
  )
  await seal(harness, pending)
  const report = (await cache.get(pending.id))!
  return { cache, report }
}
const revision = async (harness: ProviderHarness, id: string) =>
  (
    await harness.db
      .select()
      .from(observationReportRetainedRevisions)
      .where(eq(observationReportRetainedRevisions.reportId, id))
      .get()
  )?.revision
const tables = [
  observationReportPages,
  observationReportRows,
  observationReportCounts,
  observationReportReceipts,
] as const

describeEachProvider('RFC-371 native retained revision and complete warm reads', (harness) => {
  // CI 37429382608: a normal publication between status reads must not become HTTP 425.
  test('a real building status may finish before qualification without hiding changed retained output', async () => {
    await seedCompleteTask(harness, 1, 1)
    const cache = completeObservationReportCache(
      harness.db,
      generation,
      createCompleteTaskObservationFacts,
    )
    const key = randomUUID()
    const pending = await cache.ensure(
      { actor, query, refreshKey: key },
      key,
      scope,
      randomUUID(),
      randomUUID(),
    )
    expect(pending.report.state).toBe('building')
    await seal(harness, pending)
    expect((await cache.get(pending.id))!.report.state).toBe('ready')
    await expect(cache.assertReadable(actor, pending)).resolves.toBeUndefined()
    await harness.db
      .update(observationReportRows)
      .set({ document: '{"changed":true}' })
      .where(eq(observationReportRows.reportId, pending.id))
      .run()
    await expect(cache.assertReadable(actor, pending)).rejects.toThrow(changed)
    expect((await cache.get(pending.id))!.report.state).toBe('ready')
  })

  test('500 real building receipt writes keep no revision; the PostgreSQL statement trigger runs once per batch', async () => {
    await seedCompleteTask(harness, 1, 1)
    const { cache, report } = await fixture(harness)
    await harness.db
      .update(observationReports)
      .set({ state: 'building' })
      .where(eq(observationReports.id, report.id))
      .run()
    await harness.db
      .insert(observationReportReceipts)
      .values(
        Array.from({ length: 500 }, (_, n) => ({
          reportId: report.id,
          key: 'batch/' + String(n).padStart(3, '0'),
          document: '{}',
        })),
      )
      .run()
    expect(await revision(harness, report.id)).toBeUndefined()
    await harness.db
      .update(observationReports)
      .set({ state: 'ready', manifest: JSON.stringify({ ...report.manifest, receipts: '501' }) })
      .where(eq(observationReports.id, report.id))
      .run()
    const published = (await cache.get(report.id))!
    await cache.assertReadable(actor, published)
    const binding = harness.applicationBinding
    if (binding.provider === 'postgresql') {
      const result = await binding.runtime
        .providerPool()
        .unsafe(
          'EXPLAIN (ANALYZE, FORMAT JSON) UPDATE agent_workflow.observation_report_receipts SET document = $1 WHERE report_id = $2',
          ['{"changed":true}', report.id],
        )
      const plan = result[0]?.['QUERY PLAN'] as {
        Triggers: { 'Trigger Name': string; Calls: number }[]
      }[]
      expect(
        plan[0]!.Triggers.find(
          (item) => item['Trigger Name'] === 'observation_report_receipts_retained_update',
        )?.Calls,
      ).toBe(1)
    } else {
      await harness.db
        .update(observationReportReceipts)
        .set({ document: '{"changed":true}' })
        .where(eq(observationReportReceipts.reportId, report.id))
        .run()
    }
    expect(await revision(harness, report.id)).toBeDefined()
    await expect(cache.assertReadable(actor, published)).rejects.toThrow(changed)
  })

  test('actual PostgreSQL mutation waits behind publish and observes the locked current parent state', async () => {
    const binding = harness.applicationBinding
    if (binding.provider !== 'postgresql') return
    await seedCompleteTask(harness, 1, 1)
    const { cache, report } = await fixture(harness)
    await cache.assertReadable(actor, report)
    await harness.db
      .update(observationReports)
      .set({ state: 'building' })
      .where(eq(observationReports.id, report.id))
      .run()
    const pool = binding.runtime.providerPool()
    const publisher = await pool.reserve(),
      writer = await pool.reserve()
    let mutation: PromiseLike<unknown> | undefined
    try {
      const pid = (await writer.unsafe('SELECT pg_backend_pid() AS pid'))[0]?.pid
      await publisher.unsafe('BEGIN')
      await publisher.unsafe(
        "UPDATE agent_workflow.observation_reports SET state = 'ready' WHERE id = $1",
        [report.id],
      )
      mutation = writer
        .unsafe(
          'UPDATE agent_workflow.observation_report_rows SET document = $1 WHERE report_id = $2',
          ['{"changed":true}', report.id],
        )
        .then((value) => value)
      const deadline = performance.now() + 3000
      let blocked = false
      while (performance.now() < deadline) {
        const state = await pool.unsafe(
          'SELECT cardinality(pg_blocking_pids($1::integer)) > 0 AS blocked',
          [pid],
        )
        if (state[0]?.blocked === true) {
          blocked = true
          break
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 25))
      }
      expect(blocked).toBe(true)
      await publisher.unsafe('COMMIT')
      await mutation
      expect(await revision(harness, report.id)).toBeDefined()
      await expect(cache.assertReadable(actor, report)).rejects.toThrow(changed)
    } finally {
      await publisher.unsafe('ROLLBACK')
      await Promise.resolve(mutation).catch(() => undefined)
      writer.release()
      publisher.release()
    }
  }, 20_000)

  test('warm reads skip only full physical qualification; original Task population and actor still execute', async () => {
    await seedCompleteTask(harness, 1, 1)
    const { cache, report } = await fixture(harness)
    const recording = harness.recordStatements()
    try {
      await cache.assertReadable(actor, report)
      const cold = recording.selects().length
      await cache.assertReadable(actor, report)
      const page = await cache.page(report, {
        section: 'tasks',
        parent: null,
        after: null,
        limit: 100,
      })
      expect(page.items).toEqual([{ task: { id: 'complete-original-task' } }])
      expect(page.total).toBe('1')
      expect(page.nextCursor).toBeNull()
      const warm = recording.selects().slice(cold)
      expect(
        warm.some(
          (entry) =>
            /count\(\*\)/i.test(entry.sql) &&
            /observation_report_/i.test(entry.sql) &&
            !/\bjoin\b/i.test(entry.sql),
        ),
      ).toBe(false)
      expect(
        warm.filter((entry) =>
          /^select\s+(?:tasks\.)?id\s+from\s+(?:agent_workflow\.)?tasks\s+where\s+(?:agent_workflow\.)?tasks\.id\s+in\s*\(/i.test(
            entry.sql.replace(/["`]/g, ''),
          ),
        ).length,
      ).toBe(2)
      expect(
        warm.filter((entry) =>
          /^select\s+(?:system_agent_observation_groups\.)?id\s+from\s+(?:agent_workflow\.)?system_agent_observation_groups\s+where\s+(?:agent_workflow\.)?system_agent_observation_groups\.id\s+in\s*\(/i.test(
            entry.sql.replace(/["`]/g, ''),
          ),
        ).length,
      ).toBe(2)
      expect(warm.some((entry) => /observation_report_receipts/i.test(entry.sql))).toBe(true)
      const restarted = completeObservationReportCache(
        harness.db,
        generation,
        createCompleteTaskObservationFacts,
      )
      const beforeRestart = recording.selects().length
      await restarted.assertReadable(actor, report)
      expect(
        recording
          .selects()
          .slice(beforeRestart)
          .some(
            (entry) =>
              /count\(\*\)/i.test(entry.sql) && /observation_report_pages/i.test(entry.sql),
          ),
      ).toBe(true)
      await harness.db
        .update(users)
        .set({ status: 'disabled' })
        .where(eq(users.id, actor.user.id))
        .run()
      await expect(cache.assertReadable(actor, report)).rejects.toThrow(
        'Original observation actor changed',
      )
    } finally {
      recording.stop()
    }
  })

  for (const [index, table] of tables.entries())
    for (const event of ['insert', 'update', 'delete'] as const)
      test(`real ${event} on derived relation ${index} invalidates warm status and page without changing persistent ready`, async () => {
        await seedCompleteTask(harness, 1, 1)
        const { cache, report } = await fixture(harness)
        await cache.assertReadable(actor, report)
        if (event === 'delete')
          await harness.db.delete(table).where(eq(table.reportId, report.id)).run()
        else if (index === 0) {
          if (event === 'insert')
            await harness.db
              .insert(observationReportPages)
              .values({
                reportId: report.id,
                ordinal: '1',
                previousDigest: 'fixture',
                digest: 'new',
                itemsCount: 1,
              })
              .run()
          else
            await harness.db
              .update(observationReportPages)
              .set({ itemsCount: 2 })
              .where(eq(observationReportPages.reportId, report.id))
              .run()
        } else if (index === 1) {
          if (event === 'insert')
            await harness.db
              .insert(observationReportRows)
              .values({
                reportId: report.id,
                ordinal: '1',
                section: 'tasks',
                parent: '',
                key: 'extra',
                document: '{}',
              })
              .run()
          else
            await harness.db
              .update(observationReportRows)
              .set({ document: '{"changed":true}' })
              .where(eq(observationReportRows.reportId, report.id))
              .run()
        } else if (index === 2) {
          if (event === 'insert')
            await harness.db
              .insert(observationReportCounts)
              .values({
                reportId: report.id,
                section: 'agents',
                parent: '',
                total: '0',
                actual: '0',
                declared: true,
              })
              .run()
          else
            await harness.db
              .update(observationReportCounts)
              .set({ actual: '2' })
              .where(eq(observationReportCounts.reportId, report.id))
              .run()
        } else {
          if (event === 'insert')
            await harness.db
              .insert(observationReportReceipts)
              .values({ reportId: report.id, key: 'extra', document: '{}' })
              .run()
          else
            await harness.db
              .update(observationReportReceipts)
              .set({ document: '{"changed":true}' })
              .where(eq(observationReportReceipts.reportId, report.id))
              .run()
        }
        await expect(revision(harness, report.id)).resolves.toMatch(/^[a-f0-9-]+$/)
        await expect(cache.assertReadable(actor, report)).rejects.toThrow(changed)
        await expect(
          cache.page(report, { section: 'tasks', parent: null, after: null, limit: 100 }),
        ).rejects.toThrow(changed)
        expect((await cache.get(report.id))!.report.state).toBe('ready')
        await expect(
          completeObservationReportCache(
            harness.db,
            generation,
            createCompleteTaskObservationFacts,
          ).assertReadable(actor, report),
        ).rejects.toThrow(changed)
        const rebuilt = await cache.ensure(
          report.request,
          report.requestKey,
          scope,
          'new-owner',
          randomUUID(),
        )
        expect(rebuilt.owner).toBe('new-owner')
        expect(rebuilt.report.state).toBe('building')
        expect(await revision(harness, report.id)).toBeUndefined()
        for (const original of tables)
          expect(
            await harness.db.select().from(original).where(eq(original.reportId, report.id)).all(),
          ).toEqual([])
        await seal(harness, rebuilt)
        await cache.assertReadable(actor, (await cache.get(report.id))!)
      })

  test('native rollback, unrelated reports and building writes preserve the qualified original', async () => {
    await seedCompleteTask(harness, 1, 1)
    const { cache, report } = await fixture(harness)
    await cache.assertReadable(actor, report)
    await expect(
      harness.session.transaction(async (tx) => {
        await tx
          .update(observationReportRows)
          .set({ document: '{}' })
          .where(eq(observationReportRows.reportId, report.id))
          .run()
        throw new Error('rollback native mutation')
      }),
    ).rejects.toThrow('rollback native mutation')
    expect(await revision(harness, report.id)).toBeUndefined()
    await cache.assertReadable(actor, report)
    const other = await fixture(harness)
    await other.cache.assertReadable(actor, other.report)
    await harness.db
      .update(observationReportRows)
      .set({ document: '{}' })
      .where(eq(observationReportRows.reportId, other.report.id))
      .run()
    await cache.assertReadable(actor, report)
    expect(await revision(harness, other.report.id)).toBeDefined()
    const building = await other.cache.ensure(
      other.report.request,
      other.report.requestKey,
      scope,
      'new-owner',
      randomUUID(),
    )
    await seal(harness, building)
    expect(await revision(harness, building.id)).toBeUndefined()
    await other.cache.assertReadable(actor, (await other.cache.get(building.id))!)
  })

  test('a real report_id move invalidates both parents, and a cascade cannot recreate either parent', async () => {
    await seedCompleteTask(harness, 1, 1)
    const first = await fixture(harness),
      second = await fixture(harness)
    await first.cache.assertReadable(actor, first.report)
    await second.cache.assertReadable(actor, second.report)
    await harness.db
      .update(observationReportRows)
      .set({ reportId: second.report.id, ordinal: 'moved', key: 'moved' })
      .where(
        and(
          eq(observationReportRows.reportId, first.report.id),
          eq(observationReportRows.ordinal, '0'),
        ),
      )
      .run()
    for (const { cache, report } of [first, second]) {
      expect(await revision(harness, report.id)).toBeDefined()
      await expect(cache.assertReadable(actor, report)).rejects.toThrow(changed)
    }
    await harness.db
      .delete(observationReports)
      .where(eq(observationReports.id, second.report.id))
      .run()
    expect(await revision(harness, second.report.id)).toBeUndefined()
    expect(await second.cache.get(second.report.id)).toBeUndefined()
    expect(await revision(harness, first.report.id)).toBeDefined()
  })

  test('restoring original bytes cannot clear a mutation; explicit claim rebuilds with a new owner', async () => {
    await seedCompleteTask(harness, 1, 1)
    const { cache, report } = await fixture(harness)
    await cache.assertReadable(actor, report)
    const original = (await harness.db
      .select()
      .from(observationReportRows)
      .where(eq(observationReportRows.reportId, report.id))
      .get())!
    await harness.db
      .update(observationReportRows)
      .set({ document: '{}' })
      .where(eq(observationReportRows.reportId, report.id))
      .run()
    await harness.db
      .update(observationReportRows)
      .set({ document: original.document })
      .where(eq(observationReportRows.reportId, report.id))
      .run()
    await expect(cache.assertReadable(actor, report)).rejects.toThrow(changed)
    const recovered = await cache.claim(report.id, 'claimed-owner')
    expect(recovered.owner).toBe('claimed-owner')
    expect(recovered.report.state).toBe('building')
    expect(await revision(harness, report.id)).toBeUndefined()
  })

  test('the current snapshot parent, owner and manifest cannot be replaced by an earlier cache.get argument', async () => {
    await seedCompleteTask(harness, 1, 1)
    const { cache, report } = await fixture(harness)
    await cache.assertReadable(actor, report)
    await harness.db
      .update(observationReports)
      .set({ owner: 'replacement-owner' })
      .where(eq(observationReports.id, report.id))
      .run()
    await expect(cache.assertReadable(actor, report)).rejects.toThrow(changed)
    await harness.db
      .update(observationReports)
      .set({ owner: report.owner, manifest: JSON.stringify({ ...report.manifest, rows: '999' }) })
      .where(eq(observationReports.id, report.id))
      .run()
    await expect(cache.assertReadable(actor, (await cache.get(report.id))!)).rejects.toThrow(
      changed,
    )
  })
})

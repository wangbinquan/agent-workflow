// RFC-371 report-load-performance: a complete transfer page must not issue one database
// round trip per group. Batch writes still preserve replay, full counts and atomic rejection.
import { expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { buildActor } from '@/auth/actor'
import {
  observationReports,
  observationReportCounts,
  observationReportRows,
  observationReportPages,
  observationReportReceipts,
} from '@/db/schema'
import { createCompleteTaskObservationFacts } from '@/modules/task-execution/composition/taskObservationFacts'
import { completeObservationReportCache } from '@/modules/run-observability/infrastructure/completeObservationReportStore'
import { completeObservationActorScope } from '@/modules/run-observability/infrastructure/completeObservationReportDocuments'
import {
  completeReportInitialDigest,
  completeReportTransferPage,
} from '@/modules/run-observability/domain/completeReportEnvelope'
import type { CompleteObservationTransferItem } from '@/modules/run-observability/ports/completeObservationReport'
import { sha256Hex } from '@/util/hash'
import { describeEachProvider, type ProviderHarness } from './helpers/eachProvider'
import { COMPLETE_NOW, seedCompleteTask } from './helpers/rfc371CompleteTaskFixture'

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
async function staging(harness: ProviderHarness) {
  await seedCompleteTask(harness, 0, 0)
  const cache = completeObservationReportCache(
    harness.db,
    'batch-count-fixture',
    createCompleteTaskObservationFacts,
    () => COMPLETE_NOW,
  )
  const report = await cache.ensure(
    {
      actor,
      query: { from: COMPLETE_NOW, to: COMPLETE_NOW + 60_000, timezone: 'UTC' },
      refreshKey: randomUUID(),
    },
    randomUUID(),
    completeObservationActorScope(actor),
    randomUUID(),
    randomUUID(),
  )
  let ordinal = 0n,
    digest = completeReportInitialDigest
  return {
    id: report.id,
    page(items: readonly CompleteObservationTransferItem[]) {
      return completeReportTransferPage(report.id, String(ordinal), digest, items, sha256Hex)
    },
    async stage(items: readonly CompleteObservationTransferItem[]) {
      const page = this.page(items)
      await cache.stage(report.id, report.owner, page)
      ordinal++
      digest = page.digest
      return page
    },
    replay: (page: ReturnType<typeof completeReportTransferPage>) =>
      cache.stage(report.id, report.owner, page),
  }
}
const row = (parent: string, key: string): CompleteObservationTransferItem => ({
  kind: 'row',
  row: { section: 'attempts', parent, key, document: { key } },
})
const count = (parent: string, total: string): CompleteObservationTransferItem => ({
  kind: 'count',
  count: { section: 'attempts', parent, total },
})

describeEachProvider('RFC-371 complete report batched staging', (harness) => {
  test('all 500 groups survive multiple pages, declarations, zero groups and immutable replay with bounded database round trips', async () => {
    const report = await staging(harness)
    const groups = Array.from({ length: 500 }, (_, index) => 'group-' + index)
    const recording = harness.recordStatements()
    let page: ReturnType<typeof completeReportTransferPage>
    try {
      page = await report.stage(groups.map((parent) => row(parent, 'first')))
    } finally {
      recording.stop()
    }
    const countStatements = recording.statements.filter((entry) =>
      /\bobservation_report_counts\b/.test(entry.sql),
    )
    expect(countStatements.length).toBeLessThanOrEqual(3)
    expect(
      recording.selects().filter((entry) => /\bobservation_report_counts\b/.test(entry.sql)),
    ).toHaveLength(1)
    const lookup = recording
      .selects()
      .find((entry) => /\bobservation_report_counts\b/.test(entry.sql))!
    const plan = await harness.explain(lookup)
    if (harness.capabilities.isolation === 'exclusive')
      expect(plan).toContain('report_id=? AND section=? AND parent=?')
    await report.replay(page!)
    await report.stage(groups.map((parent) => count(parent, '2')))
    await report.stage(groups.map((parent) => row(parent, 'last')))
    await report.stage([count('empty', '0')])
    const actual = await harness.db
      .select()
      .from(observationReportCounts)
      .where(eq(observationReportCounts.reportId, report.id))
      .all()
    expect(actual).toHaveLength(501)
    const byParent = new Map(actual.map((value) => [value.parent, value]))
    for (const parent of groups) {
      expect(byParent.get(parent)).toMatchObject({
        section: 'attempts',
        total: '2',
        actual: '2',
        declared: true,
      })
    }
    expect(byParent.get('empty')).toMatchObject({ total: '0', actual: '0', declared: true })
    const rows = await harness.db
      .select()
      .from(observationReportRows)
      .where(eq(observationReportRows.reportId, report.id))
      .all()
    expect(rows).toHaveLength(1000)
    expect(rows.some((value) => value.parent === groups[0] && value.key === 'first')).toBe(true)
    expect(rows.some((value) => value.parent === groups[499] && value.key === 'last')).toBe(true)
    const root = await harness.db
      .select()
      .from(observationReports)
      .where(eq(observationReports.id, report.id))
      .get()
    expect(JSON.parse(root!.progress)).toMatchObject({
      pages: '4',
      rows: '1000',
      counts: '501',
      receipts: '0',
    })
  }, 60_000)

  test('mixed declarations and rows preserve arbitrary precision and undeclared groups', async () => {
    const report = await staging(harness)
    await report.stage([row('previous', 'a')])
    const huge = '9007199254740993000000000000000'
    await harness.db
      .update(observationReportCounts)
      .set({ actual: huge })
      .where(eq(observationReportCounts.reportId, report.id))
      .run()
    await report.stage([
      row('previous', 'b'),
      count('previous', String(BigInt(huge) + 2n)),
      row('previous', 'c'),
      count('new', '1'),
      row('new', 'a'),
      row('undeclared', 'a'),
    ])
    const groups = await harness.db
      .select()
      .from(observationReportCounts)
      .where(eq(observationReportCounts.reportId, report.id))
      .all()
    expect(groups).toHaveLength(3)
    expect(groups.find((value) => value.parent === 'previous')).toMatchObject({
      total: String(BigInt(huge) + 2n),
      actual: String(BigInt(huge) + 2n),
      declared: true,
    })
    expect(groups.find((value) => value.parent === 'new')).toMatchObject({
      total: '1',
      actual: '1',
      declared: true,
    })
    expect(groups.find((value) => value.parent === 'undeclared')).toMatchObject({
      total: '0',
      actual: '1',
      declared: false,
    })
  })

  test.each(['same-page', 'prior-page'] as const)(
    'a %s duplicate declaration rejects the whole page and leaves progress, rows and receipts intact',
    async (mode) => {
      const report = await staging(harness)
      if (mode === 'prior-page') await report.stage([count('duplicate', '0')])
      const original = await harness.db
        .select()
        .from(observationReports)
        .where(eq(observationReports.id, report.id))
        .get()
      const originalCounts = await harness.db
        .select()
        .from(observationReportCounts)
        .where(eq(observationReportCounts.reportId, report.id))
        .all()
      const items: CompleteObservationTransferItem[] = [
        count('fresh', '1'),
        row('fresh', 'a'),
        { kind: 'receipt', key: 'receipt', document: { eof: true } },
        count('duplicate', '0'),
        ...(mode === 'same-page' ? [count('duplicate', '0')] : []),
      ]
      await expect(report.stage(items)).rejects.toThrow('Original report count identity duplicated')
      const root = await harness.db
        .select()
        .from(observationReports)
        .where(eq(observationReports.id, report.id))
        .get()
      expect(root).toEqual(original)
      expect(
        await harness.db
          .select()
          .from(observationReportCounts)
          .where(eq(observationReportCounts.reportId, report.id))
          .all(),
      ).toEqual(originalCounts)
      expect(
        await harness.db
          .select()
          .from(observationReportRows)
          .where(eq(observationReportRows.reportId, report.id))
          .all(),
      ).toHaveLength(0)
      expect(
        await harness.db
          .select()
          .from(observationReportReceipts)
          .where(eq(observationReportReceipts.reportId, report.id))
          .all(),
      ).toHaveLength(0)
      expect(
        await harness.db
          .select()
          .from(observationReportPages)
          .where(eq(observationReportPages.reportId, report.id))
          .all(),
      ).toHaveLength(mode === 'prior-page' ? 1 : 0)
    },
  )

  test('both 500-group updates use exact indexed identities without per-group CASE scans and retain all rows and replay', async () => {
    const report = await staging(harness)
    const groups = Array.from({ length: 500 }, (_, index) => 'updated-group-' + index)
    await report.stage(groups.map((parent) => row(parent, 'first')))
    const recording = harness.recordStatements()
    let declaredPage: ReturnType<typeof completeReportTransferPage>,
      lastPage: ReturnType<typeof completeReportTransferPage>
    try {
      declaredPage = await report.stage(groups.map((parent) => count(parent, '2')))
      lastPage = await report.stage(groups.map((parent) => row(parent, 'last')))
    } finally {
      recording.stop()
    }
    const updates = recording.statements.filter(
      (entry) => /\bobservation_report_counts\b/.test(entry.sql) && /\bupdate\b/i.test(entry.sql),
    )
    expect(updates).toHaveLength(2)
    for (const update of updates) {
      expect(update.sql).not.toMatch(/\bcase\b/i)
      expect(update.sql).toMatch(/\bwith\b.*\bvalues\b/is)
      expect(update.sql).toMatch(/\bfrom\s+changed\b/i)
      const plan = await harness.explain(update)
      if (harness.capabilities.isolation === 'exclusive')
        expect(plan).toContain('report_id=? AND section=? AND parent=?')
    }
    await report.replay(declaredPage!)
    await report.replay(lastPage!)
    const actual = await harness.db
      .select()
      .from(observationReportCounts)
      .where(eq(observationReportCounts.reportId, report.id))
      .all()
    expect(actual).toHaveLength(500)
    const byParent = new Map(actual.map((group) => [group.parent, group]))
    for (const parent of groups)
      expect(byParent.get(parent)).toMatchObject({
        section: 'attempts',
        total: '2',
        actual: '2',
        declared: true,
      })
    expect(
      await harness.db
        .select()
        .from(observationReportRows)
        .where(eq(observationReportRows.reportId, report.id))
        .all(),
    ).toHaveLength(1000)
    const root = await harness.db
      .select()
      .from(observationReports)
      .where(eq(observationReports.id, report.id))
      .get()
    expect(JSON.parse(root!.progress)).toMatchObject({
      pages: '3',
      rows: '1000',
      counts: '500',
      receipts: '0',
    })
  }, 60_000)
})

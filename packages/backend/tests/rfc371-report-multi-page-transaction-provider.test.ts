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
const row = (key: string): CompleteObservationTransferItem => ({
  kind: 'row',
  row: { section: 'attempts', parent: 'shared', key, document: { key } },
})
const count = (parent: string, total: string): CompleteObservationTransferItem => ({
  kind: 'count',
  count: { section: 'attempts', parent, total },
})
async function staging(harness: ProviderHarness) {
  await seedCompleteTask(harness, 0, 0)
  const cache = completeObservationReportCache(
    harness.db,
    'multi-page-original-generation',
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
  return {
    cache,
    report,
    pages(items: readonly (readonly CompleteObservationTransferItem[])[]) {
      let digest = completeReportInitialDigest
      return items.map((items, ordinal) => {
        const page = completeReportTransferPage(
          report.id,
          String(ordinal),
          digest,
          items,
          sha256Hex,
        )
        digest = page.digest
        return page
      })
    },
    async progress() {
      const stored = await harness.db
        .select()
        .from(observationReports)
        .where(eq(observationReports.id, report.id))
        .get()
      return JSON.parse(stored!.progress)
    },
  }
}

describeEachProvider('RFC-371 multiple original pages in one transaction', (harness) => {
  test('partial and whole replay retain all later pages, exact BigInt counts and receipts', async () => {
    const fixture = await staging(harness)
    const { cache, report } = fixture
    const huge = '900719925474099312345678901234567890'
    const pages = fixture.pages([
      [count('shared', '7'), count('empty', '0'), count('huge', huge)],
      ...Array.from({ length: 7 }, (_, n) => [row('original-' + n)]),
      [{ kind: 'receipt', key: 'original-receipt', document: { eof: true } }],
    ])
    await cache.stageBatch(report.id, report.owner, pages.slice(0, 2))
    await cache.stageBatch(report.id, report.owner, pages)
    const retained = await fixture.progress()
    expect(retained).toEqual({
      pages: '9',
      rows: '7',
      counts: '3',
      receipts: '1',
      digest: pages[8]!.digest,
    })
    await cache.stageBatch(report.id, report.owner, pages)
    expect(await fixture.progress()).toEqual(retained)
    const groups = await harness.db
      .select()
      .from(observationReportCounts)
      .where(eq(observationReportCounts.reportId, report.id))
      .all()
    expect(
      groups.map((group) => [group.parent, group.total, group.actual, group.declared]).sort(),
    ).toEqual([
      ['empty', '0', '0', true],
      ['huge', huge, '0', true],
      ['shared', '7', '7', true],
    ])
    const rows = await harness.db
      .select()
      .from(observationReportRows)
      .where(eq(observationReportRows.reportId, report.id))
      .all()
    expect(rows.map((row) => row.key).sort()).toEqual(
      Array.from({ length: 7 }, (_, n) => 'original-' + n),
    )
    expect(
      await harness.db
        .select()
        .from(observationReportPages)
        .where(eq(observationReportPages.reportId, report.id))
        .all(),
    ).toHaveLength(9)
    expect(
      await harness.db
        .select()
        .from(observationReportReceipts)
        .where(eq(observationReportReceipts.reportId, report.id))
        .all(),
    ).toMatchObject([{ key: 'original-receipt', document: JSON.stringify({ eof: true }) }])
  })

  test('a late duplicate declaration rolls back every new page in the batch and allows a correct retry', async () => {
    const fixture = await staging(harness)
    const { cache, report } = fixture
    const invalid = fixture.pages([
      [count('shared', '2')],
      [row('first')],
      [row('last')],
      [count('shared', '2')],
    ])
    await cache.stageBatch(report.id, report.owner, invalid.slice(0, 2))
    const prefix = await fixture.progress()
    await expect(cache.stageBatch(report.id, report.owner, invalid.slice(2))).rejects.toThrow(
      'Original report count identity duplicated',
    )
    expect(await fixture.progress()).toEqual(prefix)
    expect(
      await harness.db
        .select()
        .from(observationReportRows)
        .where(eq(observationReportRows.reportId, report.id))
        .all(),
    ).toMatchObject([{ key: 'first' }])
    expect(
      await harness.db
        .select()
        .from(observationReportPages)
        .where(eq(observationReportPages.reportId, report.id))
        .all(),
    ).toHaveLength(2)
    const groups = await harness.db
      .select()
      .from(observationReportCounts)
      .where(eq(observationReportCounts.reportId, report.id))
      .all()
    expect(groups).toMatchObject([{ parent: 'shared', total: '2', actual: '1', declared: true }])
    const correct = fixture.pages([
      [count('shared', '2')],
      [row('first')],
      [row('last')],
      [{ kind: 'receipt', key: 'after-retry', document: { eof: true } }],
    ])
    await cache.stageBatch(report.id, report.owner, correct.slice(2))
    expect(await fixture.progress()).toEqual({
      pages: '4',
      rows: '2',
      counts: '1',
      receipts: '1',
      digest: correct[3]!.digest,
    })
  })
})

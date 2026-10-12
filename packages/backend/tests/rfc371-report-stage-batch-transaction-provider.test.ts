// RFC-371 report staging: eight complete pages previously repeated the same owned-report
// read/progress write. Keep every original page and group while batching database I/O.
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
import { completeOrdinalKey } from '@/modules/run-observability/domain/completeOrdinal'
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
const row = (
  parent: string,
  key: string,
  section: 'attempts' | 'invocations' = 'attempts',
): CompleteObservationTransferItem => ({
  kind: 'row',
  row: { section, parent, key, document: { key } },
})
const count = (parent: string, total: string): CompleteObservationTransferItem => ({
  kind: 'count',
  count: { section: 'attempts', parent, total },
})
const receipt = (key: string): CompleteObservationTransferItem => ({
  kind: 'receipt',
  key,
  document: { key, eof: true },
})

async function fixture(harness: ProviderHarness) {
  await seedCompleteTask(harness, 0, 0)
  const cache = completeObservationReportCache(
    harness.db,
    'original-batch-transaction',
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
    async stored() {
      const root = await harness.db
        .select()
        .from(observationReports)
        .where(eq(observationReports.id, report.id))
        .get()
      const counts = await harness.db
        .select()
        .from(observationReportCounts)
        .where(eq(observationReportCounts.reportId, report.id))
        .all()
      const rows = await harness.db
        .select()
        .from(observationReportRows)
        .where(eq(observationReportRows.reportId, report.id))
        .all()
      const pages = await harness.db
        .select()
        .from(observationReportPages)
        .where(eq(observationReportPages.reportId, report.id))
        .all()
      const receipts = await harness.db
        .select()
        .from(observationReportReceipts)
        .where(eq(observationReportReceipts.reportId, report.id))
        .all()
      return { root, progress: JSON.parse(root!.progress), counts, rows, pages, receipts }
    },
  }
}

describeEachProvider('RFC-371 original whole-batch transaction', (harness) => {
  test('eight pages and in-batch replay retain all row ordinals and receipts with one owned read and one progress write', async () => {
    const f = await fixture(harness)
    const items: CompleteObservationTransferItem[][] = Array.from({ length: 6 }, (_, page) => [
      ...Array.from({ length: 200 }, (_, index) => row('shared', `row-${page}-${index}`)),
      receipt('receipt-' + page),
    ])
    items[0]!.unshift(count('shared', '1200'), count('empty', '0'), {
      kind: 'count',
      count: { section: 'invocations', parent: 'shared', total: '250' },
    })
    items.push([
      ...Array.from({ length: 250 }, (_, index) => row('shared', 'call-' + index, 'invocations')),
      receipt('receipt-6'),
    ])
    items.push(Array.from({ length: 230 }, (_, index) => receipt('tail-receipt-' + index)))
    const pages = f.pages(items)
    const recording = harness.recordStatements()
    try {
      await f.cache.stageBatch(f.report.id, f.report.owner, [
        pages[0]!,
        pages[0]!,
        ...pages.slice(1),
        pages[7]!,
      ])
    } finally {
      recording.stop()
    }
    const reportReads = recording
      .selects()
      .filter((entry) => /\bfrom\s+"?observation_reports"?\b/i.test(entry.sql))
    expect(reportReads.filter((entry) => !/\bfor\s+update\b/i.test(entry.sql))).toHaveLength(1)
    expect(reportReads.filter((entry) => /\bfor\s+update\b/i.test(entry.sql))).toHaveLength(
      harness.capabilities.isolation === 'exclusive' ? 0 : 1,
    )
    expect(
      recording.statements.filter((entry) =>
        /\bupdate\s+"?observation_reports"?\b/i.test(entry.sql),
      ),
    ).toHaveLength(1)
    expect(
      recording.selects().filter((entry) => /\bobservation_report_counts\b/.test(entry.sql)),
    ).toHaveLength(2)
    const stored = await f.stored()
    expect(stored.progress).toEqual({
      pages: '8',
      rows: '1450',
      counts: '3',
      receipts: '237',
      digest: pages[7]!.digest,
    })
    expect(stored.pages).toHaveLength(8)
    expect(
      stored.counts.map((g) => [g.section, g.parent, g.total, g.actual, g.declared]).sort(),
    ).toEqual([
      ['attempts', 'empty', '0', '0', true],
      ['attempts', 'shared', '1200', '1200', true],
      ['invocations', 'shared', '250', '250', true],
    ])
    const expectedRows = pages.flatMap((page) =>
      page.items.flatMap((item, index) =>
        item.kind === 'row'
          ? [
              {
                reportId: f.report.id,
                ordinal: completeOrdinalKey(BigInt(page.ordinal) * 500n + BigInt(index)),
                section: item.row.section,
                parent: item.row.parent ?? '',
                key: item.row.key,
                document: JSON.stringify(item.row.document),
              },
            ]
          : [],
      ),
    )
    expect(stored.rows.sort((a, b) => a.ordinal.localeCompare(b.ordinal))).toEqual(expectedRows)
    expect(stored.receipts.map((r) => [r.key, JSON.parse(r.document)]).sort()).toEqual(
      pages
        .flatMap((page) =>
          page.items.flatMap((item) =>
            item.kind === 'receipt' ? [[item.key, item.document]] : [],
          ),
        )
        .sort(),
    )
    await f.cache.stageBatch(f.report.id, f.report.owner, pages)
    expect(await f.stored()).toEqual(stored)
    const emptyRecording = harness.recordStatements()
    try {
      await f.cache.stageBatch(f.report.id, f.report.owner, [])
    } finally {
      emptyRecording.stop()
    }
    expect(
      emptyRecording.statements.filter((entry) => /\bobservation_report/.test(entry.sql)),
    ).toHaveLength(0)
  }, 60_000)

  test.each(['bad-digest', 'duplicate-receipt', 'cross-packet-declaration'] as const)(
    'a late %s preserves the entire sealed prefix and rolls back all new packets',
    async (mode) => {
      const f = await fixture(harness)
      const declarationItems = Array.from({ length: 700 }, (_, index) =>
        count('wide-' + index, '1'),
      )
      const rowItems = Array.from({ length: 700 }, (_, index) => row('wide-' + index, 'row'))
      const items = [
        [count('prefix', '1'), row('prefix', 'prefix-row'), receipt('prefix')],
        declarationItems.slice(0, 350),
        declarationItems.slice(350),
        rowItems.slice(0, 500),
        [...rowItems.slice(500), receipt('new-receipt')],
        [
          mode === 'cross-packet-declaration'
            ? count('wide-0', '1')
            : receipt(mode === 'duplicate-receipt' ? 'new-receipt' : 'eof'),
        ],
      ]
      const pages = f.pages(items)
      await f.cache.stageBatch(f.report.id, f.report.owner, pages.slice(0, 1))
      const prefix = await f.stored()
      const invalid = pages.slice(1)
      if (mode === 'bad-digest')
        invalid[invalid.length - 1] = { ...invalid.at(-1)!, digest: 'f'.repeat(64) }
      await expect(f.cache.stageBatch(f.report.id, f.report.owner, invalid)).rejects.toThrow()
      expect(await f.stored()).toEqual(prefix)
      items[5] = [receipt('eof')]
      const corrected = f.pages(items)
      await f.cache.stageBatch(f.report.id, f.report.owner, corrected)
      const complete = await f.stored()
      expect(complete.progress).toEqual({
        pages: '6',
        rows: '701',
        counts: '701',
        receipts: '3',
        digest: corrected[5]!.digest,
      })
      expect(complete.rows).toHaveLength(701)
      expect(complete.counts).toHaveLength(701)
      expect(complete.pages).toHaveLength(6)
      expect(complete.receipts).toHaveLength(3)
      for (const group of complete.counts)
        expect(group).toMatchObject({ total: '1', actual: '1', declared: true })
    },
    60_000,
  )

  test('11001 groups span 47 original pages without any total limit or oversized SQL statement', async () => {
    const f = await fixture(harness)
    const groups = Array.from({ length: 11_001 }, (_, index) => 'capacity-group-' + index)
    const items: CompleteObservationTransferItem[][] = []
    for (let offset = 0; offset < groups.length; offset += 500)
      items.push(groups.slice(offset, offset + 500).map((parent) => count(parent, '1')))
    for (let offset = 0; offset < groups.length; offset += 500)
      items.push(groups.slice(offset, offset + 500).map((parent) => row(parent, 'original-row')))
    items.push([receipt('complete-eof')])
    const pages = f.pages(items)
    expect(pages).toHaveLength(47)
    const recording = harness.recordStatements()
    try {
      await f.cache.stageBatch(f.report.id, f.report.owner, pages)
    } finally {
      recording.stop()
    }
    for (const statement of recording.statements)
      expect(statement.values.length).toBeLessThanOrEqual(3000)
    const stored = await f.stored()
    expect(stored.progress).toEqual({
      pages: '47',
      rows: '11001',
      counts: '11001',
      receipts: '1',
      digest: pages.at(-1)!.digest,
    })
    expect(stored.counts).toHaveLength(groups.length)
    expect(stored.rows).toHaveLength(groups.length)
    expect(stored.pages).toHaveLength(pages.length)
    expect(stored.receipts).toMatchObject([{ key: 'complete-eof' }])
    const byParent = new Map(stored.counts.map((group) => [group.parent, group]))
    for (const parent of groups)
      expect(byParent.get(parent)).toMatchObject({ total: '1', actual: '1', declared: true })
    expect(stored.rows.map((r) => [r.parent, r.key]).sort()).toEqual(
      groups.map((parent) => [parent, 'original-row']).sort(),
    )
    await f.cache.stageBatch(f.report.id, f.report.owner, pages)
    expect(await f.stored()).toEqual(stored)
  }, 60_000)
})

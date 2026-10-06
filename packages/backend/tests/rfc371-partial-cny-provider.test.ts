// RFC-371: both original databases retain partial accepted CNY through full source EOF and report publication.
import { expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  CompleteObservationDimension,
  CompleteObservationTask,
  CompleteObservationTrend,
  CompleteObservationReportPage,
} from '@agent-workflow/shared'
import { buildActor } from '@/auth/actor'
import { sha256Hex } from '@/util/hash'
import { originalReportSnapshotSession } from '@/platform/persistence/reportSnapshot'
import { createCompleteTaskObservationFacts } from '@/modules/task-execution/composition/taskObservationFacts'
import { composeCompleteObservationSnapshot } from '@/modules/run-observability/composition/completeObservationSnapshot'
import { completeObservationFileSpool } from '@/modules/run-observability/infrastructure/completeObservationFileSpool'
import { completeObservationReportCache } from '@/modules/run-observability/infrastructure/completeObservationReportStore'
import { completeObservationActorScope } from '@/modules/run-observability/infrastructure/completeObservationReportDocuments'
import { completeObservationReportService } from '@/modules/run-observability/application/completeObservationReportService'
import type { UsageLedgerRecord } from '@/modules/run-observability/domain/usageLedger'
import { describeEachProvider } from './helpers/eachProvider'
import {
  seedCompleteTask,
  buildOriginalCompleteTask,
  COMPLETE_NOW,
} from './helpers/rfc371CompleteTaskFixture'

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
const partialRecord = (row: UsageLedgerRecord): UsageLedgerRecord => {
  const contribution = { ...row.contribution, cacheRead: null, cacheWrite: '0', output: null }
  return {
    ...row,
    contribution,
    complete: false,
    issues: [],
    measurement: { ...row.measurement, usage: contribution, coverage: 'partial' },
  }
}
const expectedCost = {
  currency: 'CNY',
  amount: '0.009453',
  records: '137',
  pricedRecords: '0',
  partiallyPricedRecords: '137',
}
describeEachProvider('RFC-371 known partial CNY original population', (harness) => {
  test('137 nullable records cross original reader pages, retain accepted rates, and repeated builds do not double charge', async () => {
    await seedCompleteTask(harness, 2, 137, partialRecord)
    const first = await buildOriginalCompleteTask(harness, 137),
      again = await buildOriginalCompleteTask(harness, 137)
    expect(first.summary.metrics).toEqual(again.summary.metrics)
    expect(first.summary.metrics).toMatchObject({
      state: 'not-ready',
      recordedUsage: {
        records: '137',
        tokens: { input: '9453', cacheRead: null, cacheWrite: '0', output: null, total: '9453' },
      },
      costCoverage: { records: '137', pricedRecords: '0', partiallyPricedRecords: '137' },
      recordedCost: expectedCost,
    })
    expect(first.allocations).toHaveLength(137)
    expect(new Set(first.allocations.map((row) => row.recordId)).size).toBe(137)
    expect(
      first.allocations.every((row) => row.cost.complete === false && row.cost.amount !== null),
    ).toBe(true)
    expect(first.sourceReceipts.every((receipt) => receipt.eof)).toBe(true)
    expect(String(first.originals[0]?.records)).toBe('137')
    expect(first.summary.metrics).not.toHaveProperty('cost')
  }, 60000)
  test('same original revision supersedes only the old cache family; Task, runtime and trend preserve partial CNY', async () => {
    await seedCompleteTask(harness, 2, 137, partialRecord)
    const binding = harness.applicationBinding
    const source =
      binding.provider === 'sqlite'
        ? { ...binding, generationId: 'known-partial-cny-original' }
        : { provider: 'postgresql' as const, runtime: binding.runtime }
    const cache = completeObservationReportCache(
      harness.db,
      source.provider === 'sqlite' ? source.generationId : source.runtime.generationId,
    )
    const folder = mkdtempSync(join(tmpdir(), 'aw-known-partial-cny-')),
      spool = completeObservationFileSpool(folder)
    const service = completeObservationReportService({
      store: cache,
      spool,
      owner: randomUUID(),
      heartbeatDuringRead: false,
      scopeOf: completeObservationActorScope,
      keyOf: sha256Hex,
      newId: randomUUID,
      build: (report, signal) =>
        originalReportSnapshotSession(source).run(
          (snapshot) =>
            composeCompleteObservationSnapshot({
              snapshot,
              tasks: createCompleteTaskObservationFacts(snapshot.executor, report.request.taskId),
              report,
              spool,
              signal,
            }),
          signal,
        ),
    })
    try {
      const query = { from: COMPLETE_NOW, to: COMPLETE_NOW + 60000, timezone: 'UTC' },
        refreshKey = 'known-partial-cny',
        actorScope = completeObservationActorScope(actor)
      const oldKey = sha256Hex(
        JSON.stringify([
          2,
          'scope-metrics/7',
          cache.generation,
          actorScope,
          query,
          null,
          refreshKey,
        ]),
      )
      const old = await cache.ensure(
        { actor, query, refreshKey },
        oldKey,
        actorScope,
        'original-version-seven',
        randomUUID(),
      )
      await cache.unavailable(old.id, old.owner, ['original-partial-cost-unavailable'])
      const historical = (await cache.get(old.id))!.report
      const request = await service.request(actor, query, refreshKey)
      const id = request.state === 'ready' ? request.header.reportId : request.reportId
      expect(id).not.toBe(old.id)
      await service.worker.drain()
      const report = await service.status(actor, id)
      if (report.state !== 'not-ready' || !report.facts)
        throw new Error('Original partial CNY facts missing')
      expect(report.facts.summary.metrics).toMatchObject({
        state: 'not-ready',
        recordedCost: expectedCost,
      })
      expect((await cache.get(old.id))!.report).toEqual(historical)
      expect(report.facts.header.generation).toBe(cache.generation)
      const task = await service.page<CompleteObservationTask>(actor, id, {
        section: 'tasks',
        limit: 1,
      })
      expect(task.total).toBe('1')
      expect(task.nextCursor).toBeNull()
      expect(task.items[0]!.metrics).toMatchObject({ recordedCost: expectedCost })
      const trend = await service.page<CompleteObservationTrend>(actor, id, {
        section: 'trends',
        limit: 1,
      })
      expect(trend.total).toBe('1')
      expect(trend.nextCursor).toBeNull()
      expect(trend.items[0]!.metrics).toMatchObject({ recordedCost: expectedCost })
      const dimensions: CompleteObservationDimension[] = []
      for (const section of ['runtimes', 'agents'] as const) {
        let after: string | null = null
        do {
          const page: CompleteObservationReportPage<CompleteObservationDimension> =
            await service.page(actor, id, {
              section,
              limit: 1,
              ...(after === null ? {} : { after }),
            })
          dimensions.push(...page.items)
          after = page.nextCursor
        } while (after !== null)
      }
      expect(dimensions.find((row) => row.kind === 'runtime')?.metrics).toMatchObject({
        recordedCost: expectedCost,
      })
      expect(dimensions.find((row) => row.kind === 'agent')?.metrics).toMatchObject({
        recordedCost: expectedCost,
      })
      expect(await service.status(actor, old.id)).toEqual(historical)
    } finally {
      await service.worker.stop()
      rmSync(folder, { recursive: true, force: true })
    }
  }, 60000)
})

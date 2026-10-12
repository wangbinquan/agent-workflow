// RFC-371: the two actual daemon bootstraps install numerical reuse in the
// original Worker. Every readable collection is compared to the uncached
// report; reused source receipts retain their original identity explicitly.
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { buildActor } from '@/auth/actor'
import { nodeRuns, observationCalculationRows, observationReportCounts } from '@/db/schema'
import { configureLogger, resetLoggerForTest } from '@/util/log'
import { observationReportBuild } from '@/platform/persistence/observationReportBuild'
import { composeCompleteObservationReports } from '@/modules/run-observability/composition/completeObservationReports'
import { createCompleteTaskObservationFacts } from '@/modules/task-execution/composition/taskObservationFacts'
import {
  COMPLETE_OBSERVATION_FACT_SECTIONS,
  COMPLETE_OBSERVATION_SECTIONS,
  completeObservationReportContent,
  type CompleteObservationSection,
  type ObservationTaskPageQuery,
} from '@agent-workflow/shared'
import { describeEachProvider, type ProviderHarness } from './helpers/eachProvider'
import { COMPLETE_NOW, completeFixtureId } from './helpers/rfc371CompleteTaskFixture'
import { originalWorkerFixture } from './helpers/rfc371OriginalWorkerFixture'
import { persistentNativeFixture } from './helpers/rfc371PersistentNativeFactFixture'

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
type Fixture = Awaited<ReturnType<typeof originalWorkerFixture>>
const filters = {
  from: COMPLETE_NOW,
  to: COMPLETE_NOW + 60_000,
  timezone: 'UTC',
  cohort: 'started' as const,
}
function reports(fixture: Fixture, cache: boolean) {
  const bound = observationReportBuild(
    fixture.binding,
    fixture.appHome,
    cache ? fixture.db : undefined,
    cache ? { taskCalculations: true } : undefined,
  )
  return composeCompleteObservationReports({
    taskSource: createCompleteTaskObservationFacts,
    db: fixture.db,
    generation:
      fixture.binding.provider === 'sqlite'
        ? fixture.binding.generationId
        : fixture.binding.runtime.generationId,
    appHome: fixture.appHome,
    heartbeatDuringRead: bound.heartbeatDuringRead,
    build: (report, _spool, signal) => bound.build(report, signal),
    closeBuild: () => bound.close(),
  })
}
async function complete(
  service: ReturnType<typeof reports>,
  fixture: Fixture,
  key: string,
  query: Omit<ObservationTaskPageQuery, 'limit' | 'after'> = filters,
) {
  const admitted = await service.queries.request(actor, query, key)
  const id = admitted.state === 'ready' ? admitted.header.reportId : admitted.reportId
  await service.worker.drain()
  const state = await service.queries.status(actor, id),
    content = completeObservationReportContent(state)
  if (!content) throw new Error(JSON.stringify(state))
  const allowed = new Set<CompleteObservationSection>(
    state.state === 'not-ready'
      ? COMPLETE_OBSERVATION_FACT_SECTIONS
      : COMPLETE_OBSERVATION_SECTIONS,
  )
  const counts = await fixture.db
    .select()
    .from(observationReportCounts)
    .where(eq(observationReportCounts.reportId, id))
    .all()
  const groups: {
    section: CompleteObservationSection
    parent: string | null
    total: string
    items: unknown[]
  }[] = []
  for (const count of counts.sort((a, b) =>
    JSON.stringify([a.section, a.parent]).localeCompare(JSON.stringify([b.section, b.parent])),
  )) {
    if (!allowed.has(count.section as CompleteObservationSection)) continue
    const items: unknown[] = []
    let after: string | undefined
    for (;;) {
      const page = await service.queries.page(actor, id, {
        section: count.section as CompleteObservationSection,
        limit: 2,
        ...(count.parent === '' ? {} : { parent: count.parent }),
        ...(after === undefined ? {} : { after }),
      })
      expect(page.reportId).toBe(id)
      expect(page.total).toBe(count.total)
      items.push(...page.items)
      if (page.nextCursor === null) break
      expect(page.nextCursor).not.toBe(after)
      after = page.nextCursor
    }
    expect(String(items.length)).toBe(count.total)
    groups.push({
      section: count.section as CompleteObservationSection,
      parent: count.parent === '' ? null : count.parent,
      total: count.total,
      items,
    })
  }
  return { content, groups }
}
function numerical(report: Awaited<ReturnType<typeof complete>>) {
  const counts = { ...report.content.counts }
  delete counts.receipts
  return {
    summary: report.content.summary,
    counts,
    groups: report.groups.filter((group) => group.section !== 'receipts'),
  }
}
function reused(fixture: Fixture, reportId: string) {
  const lines = readFileSync(join(fixture.appHome, 'logs', 'daemon.log'), 'utf8').split('\n')
  const line = lines.find(
    (line) =>
      line.includes('original task calculation reuse') && line.includes('reportId=' + reportId),
  )
  if (!line) throw new Error('Actual Worker numerical cache diagnostic missing')
  return line
}
async function withOriginal(
  harness: ProviderHarness,
  work: (fixture: Fixture, source: ReturnType<typeof persistentNativeFixture>) => Promise<void>,
) {
  const native = persistentNativeFixture({ steps: 7, depth: 5 }),
    previous = process.env.OPENCODE_DB
  process.env.OPENCODE_DB = native.path
  let fixture: Fixture | undefined
  try {
    fixture = await originalWorkerFixture(harness, { attempts: 1, records: 2 })
    configureLogger({
      level: 'info',
      jsonMode: false,
      logFile: join(fixture.appHome, 'logs', 'daemon.log'),
    })
    await fixture.db
      .update(nodeRuns)
      .set({ runtime: 'opencode', opencodeSessionId: 'root' })
      .where(eq(nodeRuns.id, completeFixtureId('run', 0)))
      .run()
    await work(fixture, native)
  } finally {
    resetLoggerForTest()
    if (previous === undefined) delete process.env.OPENCODE_DB
    else process.env.OPENCODE_DB = previous
    await fixture?.close()
    await native.close()
  }
}

describeEachProvider('RFC-371 Task calculations through actual original Workers', (harness) => {
  test('actual cold/hot Workers retain every uncached fact, physical group EOF, CNY and all four Token buckets', async () => {
    await withOriginal(harness, async (fixture) => {
      const original = reports(fixture, false),
        cached = reports(fixture, true)
      try {
        const oracle = await complete(original, fixture, 'original-task-calculation-worker-oracle')
        const cold = await complete(
          cached,
          fixture,
          'load-performance-task-calculation-worker-cold',
        )
        const hot = await complete(cached, fixture, 'load-performance-task-calculation-worker-hot')
        expect(numerical(cold)).toEqual(numerical(oracle))
        expect(numerical(hot)).toEqual(numerical(oracle))
        expect(oracle.content.summary.recordedUsage!.tokens).toEqual({
          input: '9007199254741028',
          cacheRead: '88',
          cacheWrite: '109',
          output: '71',
          total: '9007199254741296',
        })
        expect(oracle.content.summary.metrics).toHaveProperty('recordedCost', {
          currency: 'CNY',
          amount: '0.00015',
          records: '11',
          pricedRecords: '2',
        })
        expect(reused(fixture, cold.content.header.reportId)).toContain('cachedTasks=0')
        expect(reused(fixture, cold.content.header.reportId)).toContain('calculatedTasks=1')
        expect(reused(fixture, hot.content.header.reportId)).toContain('cachedTasks=1')
        expect(reused(fixture, hot.content.header.reportId)).toContain('calculatedTasks=0')
        const rows = await fixture.db.select().from(observationCalculationRows).all()
        expect(rows.length).toBeGreaterThan(0)
        expect(reused(fixture, hot.content.header.reportId)).toContain('cachedRows=' + rows.length)
        if (fixture.binding.provider === 'postgresql') {
          const release = fixture.events.indexOf('reader-released')
          expect(release).toBeGreaterThanOrEqual(0)
          expect(fixture.events.slice(release + 1)).toContain('writer-released')
        }
      } finally {
        await cached.worker.stop()
        await original.worker.stop()
      }
    })
  }, 60_000)

  test('changing usage boundaries and returning to the same range reuses numbers while freshly selecting every original member', async () => {
    await withOriginal(harness, async (fixture) => {
      const original = reports(fixture, false),
        cached = reports(fixture, true)
      try {
        const usage = { ...filters, cohort: 'usage' as const }
        await complete(cached, fixture, 'load-performance-task-calculation-range-cold', usage)
        const next = { ...usage, to: COMPLETE_NOW + 1 }
        const hot = await complete(
          cached,
          fixture,
          'load-performance-task-calculation-range-next',
          next,
        )
        const oracle = await complete(
          original,
          fixture,
          'original-task-calculation-range-oracle',
          next,
        )
        expect(reused(fixture, hot.content.header.reportId)).toContain('cachedTasks=1')
        expect(numerical(hot)).toEqual(numerical(oracle))
        const back = await complete(
          cached,
          fixture,
          'load-performance-task-calculation-range-back',
          usage,
        )
        const originalBack = await complete(
          original,
          fixture,
          'original-task-calculation-range-back',
          usage,
        )
        expect(numerical(back)).toEqual(numerical(originalBack))
        expect(reused(fixture, back.content.header.reportId)).toContain('cachedTasks=1')
      } finally {
        await cached.worker.stop()
        await original.worker.stop()
      }
    })
  }, 60_000)
})

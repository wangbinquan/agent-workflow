// RFC-371: actual Workers reuse complete numerical pages; faults, late source writes and
// lifecycle restarts must retain the complete uncached report, including all Token buckets.
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import {
  COMPLETE_OBSERVATION_SECTIONS,
  completeObservationReportContent,
  type CompleteObservationReportContent,
  type CompleteObservationSection,
} from '@agent-workflow/shared'
import { buildActor } from '@/auth/actor'
import { nodeRuns, observationNativeFactPages, observationNativeFactRoots } from '@/db/schema'
import { createCompleteTaskObservationFacts } from '@/modules/task-execution/composition/taskObservationFacts'
import { composeCompleteObservationReports } from '@/modules/run-observability/composition/completeObservationReports'
import { observationReportBuild } from '@/platform/persistence/observationReportBuild'
import { configureLogger, resetLoggerForTest } from '@/util/log'
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
const filters = { from: COMPLETE_NOW, to: COMPLETE_NOW + 60_000, timezone: 'UTC' }
type Fixture = Awaited<ReturnType<typeof originalWorkerFixture>>
function reports(fixture: Fixture, useFacts: boolean) {
  const bound = observationReportBuild(
    fixture.binding,
    fixture.appHome,
    useFacts ? fixture.db : undefined,
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
type Service = ReturnType<typeof reports>
type FullReport = {
  content: CompleteObservationReportContent
  sections: Record<CompleteObservationSection, unknown[]>
}
async function complete(service: Service, key: string): Promise<FullReport> {
  const requested = await service.queries.request(actor, filters, key)
  const id = requested.state === 'ready' ? requested.header.reportId : requested.reportId
  await service.worker.drain()
  const state = await service.queries.status(actor, id)
  const content = completeObservationReportContent(state)
  if (!content) throw new Error(JSON.stringify(state))
  const sections = {} as FullReport['sections']
  for (const section of COMPLETE_OBSERVATION_SECTIONS) {
    const items: unknown[] = []
    let after: string | undefined
    for (;;) {
      // This small output page intentionally exercises every cursor through real EOF.
      const page = await service.queries.page<unknown>(actor, id, {
        section,
        limit: 2,
        ...(after === undefined ? {} : { after }),
      })
      expect(page.reportId).toBe(id)
      expect(page.section).toBe(section)
      items.push(...page.items)
      if (page.nextCursor === null) {
        expect(String(items.length)).toBe(page.total)
        break
      }
      expect(page.nextCursor).not.toBe(after)
      after = page.nextCursor
    }
    sections[section] = items
  }
  return { content, sections }
}
function stable(report: FullReport) {
  const sections = { ...report.sections }
  // Only the original report namespace and original application snapshot receipt ID differ.
  // Native identity, cursor, EOF, row/page counts, all numerical facts and all issues remain.
  sections.receipts = sections.receipts.map((value) => {
    const row = value as Record<string, unknown>
    return {
      ...row,
      ...(typeof row.source === 'string' &&
      row.source.startsWith('report/' + report.content.header.reportId + '/')
        ? {
            source:
              'report/<report-id>/' +
              row.source.slice(('report/' + report.content.header.reportId + '/').length),
          }
        : {}),
      ...(row.snapshotId === report.content.header.snapshotId
        ? { snapshotId: '<original-snapshot-id>' }
        : {}),
    }
  })
  return { summary: report.content.summary, counts: report.content.counts, sections }
}
function reuseLine(fixture: Fixture, report: FullReport) {
  const line = readFileSync(join(fixture.appHome, 'logs', 'daemon.log'), 'utf8')
    .split('\n')
    .find(
      (value) =>
        value.includes('original native numeric page reuse') &&
        value.includes('reportId=' + report.content.header.reportId),
    )
  if (!line) throw new Error('Actual native page reuse diagnostic missing')
  return line
}
async function withOriginal(
  harness: ProviderHarness,
  work: (fixture: Fixture, native: ReturnType<typeof persistentNativeFixture>) => Promise<void>,
  beforeOriginalRead?: (statement: string) => void,
) {
  const native = persistentNativeFixture({ steps: 7, depth: 5 }),
    previous = process.env.OPENCODE_DB
  process.env.OPENCODE_DB = native.path
  let fixture: Fixture | undefined
  try {
    fixture = await originalWorkerFixture(harness, { attempts: 1, records: 2, beforeOriginalRead })
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

describeEachProvider(
  'RFC-371 persistent native pages through original report Workers',
  (harness) => {
    test('cold and actual hot Workers equal the uncached report across every section and original CNY/four-bucket facts', async () => {
      await withOriginal(harness, async (fixture) => {
        const oracle = reports(fixture, false),
          cached = reports(fixture, true)
        try {
          const original = await complete(oracle, 'original-numeric-worker-oracle')
          const coldEventsStart = fixture.events.length
          const cold = await complete(cached, 'load-performance-numeric-worker-cold')
          const coldEvents = fixture.events.slice(coldEventsStart)
          const hot = await complete(cached, 'load-performance-numeric-worker-hot')
          expect(stable(cold)).toEqual(stable(original))
          expect(stable(hot)).toEqual(stable(original))
          expect(reuseLine(fixture, cold)).toContain('cachedRoots=0')
          expect(reuseLine(fixture, cold)).toContain('sourceRoots=1')
          expect(reuseLine(fixture, hot)).toContain('cachedRoots=1')
          expect(reuseLine(fixture, hot)).toContain('sourceRoots=0')
          expect(await fixture.db.select().from(observationNativeFactRoots).all()).toHaveLength(1)
          expect(original.sections['historical-records'].length).toBeGreaterThan(7)
          if (fixture.binding.provider === 'postgresql') {
            // The actual serving pool has max=1: a derived writer must follow reader release.
            const readerRelease = coldEvents.indexOf('reader-released')
            expect(readerRelease).toBeGreaterThanOrEqual(0)
            expect(coldEvents.slice(readerRelease + 1)).toContain('writer-released')
          }
        } finally {
          await cached.worker.stop()
          await oracle.worker.stop()
        }
      })
    }, 60000)

    test('a corrupted persisted page is discarded and a complete fresh original snapshot succeeds', async () => {
      await withOriginal(harness, async (fixture) => {
        const oracle = reports(fixture, false),
          cached = reports(fixture, true)
        try {
          const original = await complete(oracle, 'worker-corruption-oracle')
          await complete(cached, 'worker-corruption-seed')
          await fixture.db.update(observationNativeFactPages).set({ document: '{' }).run()
          const recovered = await complete(cached, 'worker-corruption-recovered')
          expect(stable(recovered)).toEqual(stable(original))
        } finally {
          await cached.worker.stop()
          await oracle.worker.stop()
        }
      })
    }, 60000)

    test.each([
      [
        'same-ID late usage',
        "UPDATE part SET data=json_set(data,'$.tokens.cache.write',777) WHERE id='step-00000'",
      ],
      ['deletion', "DELETE FROM part WHERE id='step-00000'"],
      ['reparenting', "UPDATE session SET parent_id='unrelated' WHERE id='child-0'"],
    ] as const)(
      'an external %s is reflected in all actual Worker outputs instead of a stale cache',
      async (_name, statement) => {
        await withOriginal(harness, async (fixture, native) => {
          const oracle = reports(fixture, false),
            cached = reports(fixture, true)
          try {
            const before = await complete(cached, 'worker-late-source-before')
            native.writer.exec(statement)
            const original = await complete(oracle, 'worker-late-source-oracle')
            const after = await complete(cached, 'load-performance-worker-late-source-after')
            expect(stable(after)).toEqual(stable(original))
            expect(after.sections['historical-records']).not.toEqual(
              before.sections['historical-records'],
            )
            expect(reuseLine(fixture, after)).toContain('cachedRoots=0')
            expect(reuseLine(fixture, after)).toContain('sourceRoots=1')
          } finally {
            await cached.worker.stop()
            await oracle.worker.stop()
          }
        })
      },
      60000,
    )

    test('a native commit at the actual provider read boundary preserves complete fresh output', async () => {
      let mutate: (() => void) | undefined,
        commitsDuringRead = 0
      await withOriginal(
        harness,
        async (fixture, native) => {
          const cached = reports(fixture, true),
            oracle = reports(fixture, false)
          try {
            const before = await complete(cached, 'worker-mid-read-before')
            const commit = () => {
              native.writer.exec(
                "UPDATE part SET data=json_set(data,'$.tokens.output',456) WHERE id='step-00000'",
              )
            }
            if (fixture.binding.provider === 'postgresql') mutate = commit
            else commit()
            const changed = await complete(cached, 'load-performance-worker-mid-read-changed')
            expect(commitsDuringRead).toBe(fixture.binding.provider === 'postgresql' ? 1 : 0)
            const original = await complete(oracle, 'worker-mid-read-oracle')
            expect(stable(changed)).toEqual(stable(original))
            expect(changed.sections['historical-records']).not.toEqual(
              before.sections['historical-records'],
            )
            if (fixture.binding.provider === 'postgresql') {
              // The commit occurred after proof sampling, during actual cache-page SELECT.
              // Both original max=1 snapshot reservations must really be released.
              expect(
                fixture.events.filter((event) => event === 'reader-released').length,
              ).toBeGreaterThanOrEqual(4)
            }
          } finally {
            mutate = undefined
            await cached.worker.stop()
            await oracle.worker.stop()
          }
        },
        (statement) => {
          if (
            !mutate ||
            !statement.includes('observation_native_fact_pages') ||
            !/^\s*select\b/i.test(statement)
          )
            return
          const commit = mutate
          mutate = undefined
          commitsDuringRead++
          commit()
        },
      )
    }, 60000)

    test('stop and resume create a fresh connection epoch and then permit verified hot reuse', async () => {
      await withOriginal(harness, async (fixture) => {
        const cached = reports(fixture, true)
        try {
          const before = await complete(cached, 'worker-lifecycle-before')
          const first = await fixture.db.select().from(observationNativeFactRoots).get()
          await cached.worker.stop()
          cached.worker.start()
          const resumed = await complete(cached, 'load-performance-worker-lifecycle-resumed')
          const hot = await complete(cached, 'load-performance-worker-lifecycle-hot')
          expect(stable(resumed)).toEqual(stable(before))
          expect(stable(hot)).toEqual(stable(before))
          expect(reuseLine(fixture, resumed)).toContain('cachedRoots=0')
          expect(reuseLine(fixture, hot)).toContain('cachedRoots=1')
          const roots = await fixture.db.select().from(observationNativeFactRoots).all()
          expect(roots).toHaveLength(2)
          expect(roots.map((root) => root.proofKey)).toContain(first!.proofKey)
          expect(new Set(roots.map((root) => root.proofKey)).size).toBe(2)
        } finally {
          await cached.worker.stop()
        }
      })
    }, 60000)
  },
)

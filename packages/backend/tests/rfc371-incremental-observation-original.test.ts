// RFC-371: the persistent increment must equal the canonical original allocator,
// including ancestry, four-bucket partials, local pricing and platform authority.
import { expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import type {
  CompleteObservationReport,
  CompleteObservationSection,
  ObservationOverviewQuery,
} from '@agent-workflow/shared'
import { buildActor } from '@/auth/actor'
import {
  observationProjectionBootstrap,
  observationProjectionChanges,
} from '@/db/observationProjection'
import { observationUsageCurrent } from '@/db/schema'
import { sha256Hex } from '@/util/hash'
import { originalReportSnapshotSession } from '@/platform/persistence/reportSnapshot'
import type { ReportSnapshotSession } from '@/platform/persistence/reportSnapshotTypes'
import {
  createCompleteTaskObservationFacts,
  createProjectionTaskObservationFacts,
} from '@/modules/task-execution/composition/taskObservationFacts'
import { buildCompleteObservationCohort } from '@/modules/run-observability/application/completeObservationCohort'
import { buildCompleteObservationUsageWindow } from '@/modules/run-observability/application/completeObservationUsageWindow'
import { completeWorkingTraversal } from '@/modules/run-observability/application/completeWorkingTraversal'
import { incrementalObservationQueries } from '@/modules/run-observability/application/incrementalObservationQueries'
import { createIncrementalObservationProjection } from '@/modules/run-observability/application/incrementalObservationProjection'
import { incrementalObservationQualification } from '@/modules/run-observability/composition/incrementalObservationQualification'
import { createCompleteObservationSources } from '@/modules/run-observability/infrastructure/completeObservationSources'
import { completeObservationValuation } from '@/modules/run-observability/infrastructure/completeObservationValuation'
import { completeUsageWorkspace } from '@/modules/run-observability/infrastructure/completeUsageWorkspace'
import { completeObservationActorScope } from '@/modules/run-observability/infrastructure/completeObservationReportDocuments'
import { createIncrementalObservationProjectionStore } from '@/modules/run-observability/infrastructure/incrementalObservationProjectionStore'
import { createIncrementalObservationQueryStore } from '@/modules/run-observability/infrastructure/incrementalObservationQueryStore'
import { incrementalObservationViews } from '@/modules/run-observability/infrastructure/incrementalObservationViews'
import { preparedObservationContributions } from '@/modules/run-observability/infrastructure/incrementalObservationPreparedStore'
import { enqueueIncrementalObservationWork } from '@/modules/run-observability/infrastructure/incrementalObservationWork'
import type {
  CompleteObservationReportRow,
  CompleteObservationCohortInput,
} from '@/modules/run-observability/ports/completeObservationReport'
import { describeEachProvider, type ProviderHarness } from './helpers/eachProvider'
import {
  seedCompleteTask,
  COMPLETE_NOW,
  completeTaskRecord,
  completeFixtureId,
} from './helpers/rfc371CompleteTaskFixture'
import { seedCompleteCoveredUsage } from './helpers/rfc371CompleteCoverageFixture'

const generation = 'incremental-original-fixture',
  asOf = COMPLETE_NOW + 86400000
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
const all: ObservationOverviewQuery = { from: 0, to: Number.MAX_SAFE_INTEGER, timezone: 'UTC' }
function setup(h: ProviderHarness) {
  const binding = h.applicationBinding
  const original = originalReportSnapshotSession(
    binding.provider === 'sqlite'
      ? { ...binding, generationId: generation }
      : { provider: 'postgresql', runtime: binding.runtime },
  )
  const snapshot: ReportSnapshotSession = {
    run: (fn, signal) => original.run((value) => fn({ ...value, asOf }), signal),
  }
  const adapter = createIncrementalObservationProjectionStore(h.db, generation),
    store = createIncrementalObservationQueryStore(h.db),
    views = incrementalObservationViews(h.db)
  const qualify = incrementalObservationQualification({
    db: h.db,
    snapshot,
    tasks: createProjectionTaskObservationFacts,
    owners: () => [],
    native: () => ({ open: async () => null, generation: async () => 'empty-native', close() {} }),
  })
  const projection = createIncrementalObservationProjection({
    store: adapter.store,
    source: adapter.source(preparedObservationContributions),
    now: () => asOf,
  })
  const queries = incrementalObservationQueries({
    generation,
    scopeOf: completeObservationActorScope,
    keyOf: sha256Hex,
    source: {
      ...store,
      retainView: views.retain,
      activateView: views.activate,
      view: views.get,
      visibleTaskIds: (a, ids) => createCompleteTaskObservationFacts(h.db).visibleIds(a, ids),
      async *visibleTasks() {
        throw new Error('Range queries must not reopen the original Task population')
      },
    },
  })
  async function apply(id: string, ids: readonly string[]) {
    const work = {
      id,
      source: 'original-row-changes',
      revision: id,
      components: ids.map((id) => JSON.stringify(['invocation', id])),
    }
    await h.session.transaction((tx) => enqueueIncrementalObservationWork(tx, work))
    await h.db.delete(observationProjectionChanges).run()
    await h.db
      .insert(observationProjectionBootstrap)
      .values({ generation, channel: 'fixture-complete-population', done: true })
      .onConflictDoNothing()
      .run()
    await projection.apply(await qualify(work, new AbortController().signal))
  }
  async function oracle(query: ObservationOverviewQuery) {
    return snapshot.run(async (read) => {
      const tasks = createCompleteTaskObservationFacts(read.executor),
        namespace = 'oracle/' + crypto.randomUUID(),
        value = completeObservationValuation({
          db: read.executor,
          rows: read.workspace,
          namespace: namespace + '/prices',
        })
      const input: CompleteObservationCohortInput = {
        actor,
        query,
        sources: createCompleteObservationSources({
          db: read.executor,
          tasks,
          snapshotId: read.snapshotId,
        }),
        asOf,
        rows: read.workspace,
        namespace,
        keyOf: sha256Hex,
        usageWorkspace: completeUsageWorkspace,
        value: value.value,
        ...(query.cohort === 'usage' ? { projectionCohort: true } : {}),
      }
      const base = await buildCompleteObservationCohort(input),
        result =
          query.cohort === 'usage' ? await buildCompleteObservationUsageWindow(input, base) : base
      await value.flush()
      const rows: CompleteObservationReportRow[] = []
      for await (const row of completeWorkingTraversal<CompleteObservationReportRow>(
        read.workspace,
        result.rowsNamespace,
      ))
        rows.push(row.document)
      return { summary: result.summary, rows }
    })
  }
  return { apply, queries, oracle }
}
function content(report: CompleteObservationReport) {
  if (report.state === 'ready') return report
  if (report.state === 'not-ready' && report.facts) return report.facts
  throw new Error('Original projection facts missing: ' + report.state)
}
const normalized = (items: readonly unknown[]) =>
  [...items].map((row) => JSON.stringify(row)).sort()
describeEachProvider(
  'RFC-371 original numerical oracle against incremental materialization',
  (h) => {
    for (const authority of ['local', 'platform'] as const)
      for (const partial of [false, true])
        test(`${authority} ${partial ? 'partial' : 'complete'} ancestry keeps the exact original Token/CNY and dimensions`, async () => {
          await seedCompleteCoveredUsage(h, authority, partial)
          const f = setup(h)
          await f.apply('initial', [completeFixtureId('invocation', 0)])
          const expected = await f.oracle(all),
            actual = content(await f.queries.request(actor, all, 'fixture'))
          expect(actual.summary.metrics).toEqual(expected.summary.metrics)
          expect(actual.summary.inventory).toEqual(expected.summary.inventory)
          for (const section of [
            'agents',
            'runtimes',
            'models',
            'purposes',
            'sources',
            'tasks',
            'trends',
          ] as const) {
            const page = await f.queries.page(actor, actual.header.reportId, {
              section,
              limit: 200,
            })
            expect(normalized(page.items)).toEqual(
              normalized(
                expected.rows
                  .filter((row) => row.section === section && row.parent === null)
                  .map((row) => row.document),
              ),
            )
          }
        }, 60_000)
    test('periods share original increments and complete days; UTC half-open boundaries preserve every bucket, category and page', async () => {
      await seedCompleteTask(h, 2, 7)
      const f = setup(h)
      await f.apply('initial', [
        completeFixtureId('invocation', 0),
        completeFixtureId('invocation', 1),
      ])
      for (const query of [
        all,
        { ...all, cohort: 'usage' as const, from: COMPLETE_NOW + 2, to: COMPLETE_NOW + 5 },
        { ...all, cohort: 'usage' as const, from: COMPLETE_NOW, to: COMPLETE_NOW + 86400000 },
        {
          ...all,
          cohort: 'usage' as const,
          from: COMPLETE_NOW + 86400000,
          to: COMPLETE_NOW + 2 * 86400000,
        },
      ]) {
        const expected = await f.oracle(query),
          actual = content(await f.queries.request(actor, query, 'fixture'))
        expect(actual.summary.metrics).toEqual(expected.summary.metrics)
        expect(actual.summary.inventory).toEqual(expected.summary.inventory)
        for (const section of [
          'tasks',
          'invocations',
          'allocations',
          'trends',
          'agents',
          'runtimes',
          'models',
          'purposes',
          'sources',
          'time-partitions',
        ] as const) {
          const expectedRows = expected.rows.filter(
            (row) => row.section === section && row.parent === null,
          )
          const rows = []
          let cursor: string | null = null
          do {
            const page = await f.queries.page(actor, actual.header.reportId, {
              section: section satisfies CompleteObservationSection,
              limit: 2,
              ...(cursor ? { after: cursor } : {}),
            })
            rows.push(...page.items)
            cursor = page.nextCursor
            expect(page.total).toBe(String(expectedRows.length))
          } while (cursor !== null)
          expect(normalized(rows)).toEqual(normalized(expectedRows.map((row) => row.document)))
        }
      }
    }, 60_000)
    test('a same-ID revision replaces values once while the old retained report stays immutable', async () => {
      await seedCompleteTask(h, 2, 7)
      const f = setup(h)
      await f.apply('initial', [
        completeFixtureId('invocation', 0),
        completeFixtureId('invocation', 1),
      ])
      const first = content(await f.queries.request(actor, all, 'first')),
        revised = completeTaskRecord(0, 2)
      revised.contribution = {
        input: '9007199254740999',
        cacheRead: '17',
        cacheWrite: '19',
        output: '23',
      }
      revised.measurement = { ...revised.measurement, revision: 2, usage: revised.contribution }
      revised.observedRevision = 2
      await h.db
        .update(observationUsageCurrent)
        .set({ document: JSON.stringify(revised) })
        .where(
          eq(
            observationUsageCurrent.id,
            sha256Hex(
              JSON.stringify([
                revised.sourceId,
                revised.measurement.invocationId,
                revised.measurement.recordId,
              ]),
            ),
          ),
        )
        .run()
      await f.apply('revision', [completeFixtureId('invocation', 0)])
      const expected = await f.oracle(all),
        second = content(await f.queries.request(actor, all, 'second'))
      expect(second.summary.metrics).toEqual(expected.summary.metrics)
      expect(content(await f.queries.status(actor, first.header.reportId)).summary).toEqual(
        first.summary,
      )
      expect(second.header.sourceRevision).not.toBe(first.header.sourceRevision)
    }, 60_000)
  },
)

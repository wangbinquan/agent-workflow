import type { ObservationPhase } from '@agent-workflow/shared'
import { canonicalJson } from '@agent-workflow/shared'
import { observationMaintenance } from '@/modules/run-observability/infrastructure/observationMaintenance'
import { originalObservationLifecyclePhases } from '@/modules/task-execution/infrastructure/observationLifecyclePhases'
import { docVersions } from '@/db/schema'
import {
  observationMaintenanceOperations,
  observationInvocationPriceRecords,
} from '@/db/observationAnalysis'
import { createObservationPriceStore } from '@/modules/run-observability/infrastructure/pricingPersistence'
import { ObservationPriceVersionSchema } from '@agent-workflow/shared'
// RFC-371: the persistent increment must equal the canonical original allocator,
// including ancestry, four-bucket partials, local pricing and platform authority.
import { afterEach, expect, test } from 'bun:test'
import { and, eq } from 'drizzle-orm'
import type {
  CompleteObservationReport,
  CompleteObservationReportPage,
  CompleteObservationSection,
  ObservationOverviewQuery,
} from '@agent-workflow/shared'
import { buildActor } from '@/auth/actor'
import {
  observationProjectionBootstrap,
  observationProjectionChanges,
} from '@/db/observationProjection'
import {
  nodeRuns,
  observationUsageCaptures,
  observationUsageCurrent,
  observationInvocations,
  tasks as originalTasks,
} from '@/db/schema'
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
import { persistentNativeFixture } from './helpers/rfc371PersistentNativeFactFixture'
import { createHistoricalTaskObservationFacts } from '@/modules/task-execution/composition/historicalObservationFacts'
import type { ProjectionOriginalScope } from '@/modules/run-observability/composition/incrementalObservationQualification'
import { createPostgresqlDatabaseRuntime } from '@/platform/persistence/postgresqlRuntime'
import { createPostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import { databaseSessionFor } from '@/platform/persistence/databaseTransaction'
import {
  qualifiedObservationIndexChannel,
  qualifiedObservationIndexVersion,
} from '@/modules/run-observability/domain/qualifiedObservationIndexes'
import { incrementalObservationBootstrap } from '@/modules/run-observability/infrastructure/incrementalObservationBootstrap'

import { composeOriginalProjectionBootstrap } from '@/modules/run-observability/composition/incrementalObservationBootstrap'
import { retainIncrementalObservationVersion } from '@/modules/run-observability/infrastructure/incrementalObservationVersions'
import { observationWindowCellKey } from '@/modules/run-observability/domain/observationWindowCell'
import {
  emptyIncrementalObservationFold,
  replaceIncrementalObservationContribution,
  type IncrementalObservationFold,
} from '@/modules/run-observability/domain/incrementalObservationFold'
import type { QualifiedObservationContribution } from '@/modules/run-observability/ports/incrementalObservationQualified'
import type { ProjectionOccurrence } from '@/modules/run-observability/application/incrementalObservationWindow'
import {
  observationProjectionCurrent,
  observationProjectionHistory,
  observationProjectionMemberships,
  observationProjectionDescriptors,
  observationProjectionIndexedVersions,
  observationProjectionWork,
} from '@/db/observationProjection'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close()
})

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
function setup(
  h: ProviderHarness,
  native?: ReturnType<typeof persistentNativeFixture>,
  indexed = false,
) {
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
  const owners = (db: ProviderHarness['db'], scope?: ProjectionOriginalScope) =>
    native
      ? [
          {
            kind: 'task' as const,
            query: createHistoricalTaskObservationFacts(
              db,
              scope
                ? { ownerIds: scope.ownerIds.task, roots: scope.roots, taskIds: scope.taskIds }
                : undefined,
            ),
          },
        ]
      : []
  const nativeQuery = native?.query ?? {
    open: async () => null,
    generation: async () => 'empty-native',
  }
  let nativeOpens = 0
  const qualify = incrementalObservationQualification({
    db: h.db,
    snapshot,
    tasks: createProjectionTaskObservationFacts,
    owners,
    native: () => {
      nativeOpens++
      return { ...nativeQuery, close() {} }
    },
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
    },
  })
  async function apply(
    id: string,
    ids: readonly string[],
    source = 'original-row-changes',
    metadataIds: readonly string[] = [],
  ) {
    const work = {
      id,
      source,
      revision: id,
      components:
        source === 'original-bootstrap-finish'
          ? [JSON.stringify(['coverage', generation])]
          : [
              ...ids.flatMap((id) => [
                JSON.stringify(['invocation', id]),
                JSON.stringify(['task', id.replace('invocation-', 'run-')]),
              ]),
              ...metadataIds.map((id) => JSON.stringify(['task-metadata', id])),
            ],
    }
    await h.session.transaction((tx) => enqueueIncrementalObservationWork(tx, work))
    await h.db.delete(observationProjectionChanges).run()
    await h.db
      .insert(observationProjectionBootstrap)
      .values({
        generation,
        channel: indexed ? qualifiedObservationIndexChannel : 'fixture-complete-population',
        done: true,
      })
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
        sources: {
          ...createCompleteObservationSources({
            db: read.executor,
            tasks,
            snapshotId: read.snapshotId,
          }),
          // Both paths use the original historical/occurrence contract, including
          // an empty physical owner population; retain every occurrence field.
          historical: {
            owners: owners(read.executor),
            native: nativeQuery,
            task: (id: string) => tasks.get(actor, id),
          },
        },
        asOf,
        rows: read.workspace,
        namespace,
        keyOf: sha256Hex,
        usageWorkspace: completeUsageWorkspace,
        value: value.value,
        // Trace/occurrence annotation is identical on both canonical paths;
        // the selected time cohort still controls the numerical population.
        projectionCohort: true,
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
  return {
    apply,
    queries,
    oracle,
    store,
    get nativeOpens() {
      return nativeOpens
    },
    async drain() {
      for (;;) {
        const pending = await adapter.store.pending(100)
        if (!pending.length) return
        for (const work of pending)
          await projection.apply(await qualify(work, new AbortController().signal))
      }
    },
  }
}
function content(report: CompleteObservationReport) {
  if (report.state === 'ready') return report
  if (report.state === 'not-ready' && report.facts) return report.facts
  throw new Error('Original projection facts missing: ' + report.state)
}
function discreteRequest(record: ReturnType<typeof completeTaskRecord>) {
  return {
    ...record,
    measurement: {
      ...record.measurement,
      scope: {
        level: 'request' as const,
        root: record.measurement.nodeRunId!,
        session: record.measurement.nodeRunId!,
        parentSession: null,
        ancestors: [],
        turn: record.measurement.recordId,
        turnIndex: 0,
      },
    },
  }
}
const normalized = (items: readonly unknown[]) =>
  // Object property insertion order is not a usage fact. Canonical JSON keeps
  // every field/value and ordered array while comparing complete row sets.
  [...items].map((row) => canonicalJson(row)).sort()
describeEachProvider(
  'RFC-371 original numerical oracle against incremental materialization',
  (h) => {
    test('a root replacement requalifies its retained owner after that owner moves to a different session', async () => {
      await seedCompleteTask(h, 1, 0)
      await h.db.delete(observationUsageCaptures).run()
      await h.db.delete(observationInvocations).run()
      await h.db.update(nodeRuns).set({ runtime: 'opencode', opencodeSessionId: 'root' }).run()
      const native = persistentNativeFixture({ steps: 3, depth: 1 })
      cleanups.push(() => native.close())
      // Root connectivity is an optional native capability. The durable
      // owner/group relation must work even when it cannot rediscover children.
      const f = setup(h, { ...native, query: { ...native.query, connectedRoots: undefined } }, true)
      await f.apply('retained-root-owner-base', [completeFixtureId('invocation', 0)])
      const sourceBefore = normalized(await h.db.select().from(observationUsageCurrent).all())
      await h.db.update(nodeRuns).set({ opencodeSessionId: 'child-0' }).run()
      await h.session.transaction((tx) =>
        enqueueIncrementalObservationWork(tx, {
          id: 'old-root-replaced-after-owner-moved',
          source: 'original-row-changes',
          revision: 'root-change',
          components: [JSON.stringify(['root', 'root'])],
        }),
      )
      await f.drain()
      const projected = (
        await h.db
          .select({ document: observationProjectionCurrent.document })
          .from(observationProjectionCurrent)
          .where(eq(observationProjectionCurrent.kind, 'contribution'))
          .all()
      ).map((row) => JSON.parse(row.document) as QualifiedObservationContribution)
      const groups = new Set(
        projected
          .filter((row) => row.detail.parent === 'native-scope-groups')
          .map((row) => row.detail.key),
      )
      const referenced = projected.flatMap((row) => row.detail.historicalRecordScopes ?? [])
      expect(referenced.length).toBeGreaterThan(0)
      for (const key of referenced) expect(groups.has(key)).toBe(true)
      for (const query of [all, { ...all, cohort: 'usage' as const }]) {
        const expected = await f.oracle(query),
          actual = content(await f.queries.request(actor, query, crypto.randomUUID()))
        expect(actual.summary.metrics).toEqual(expected.summary.metrics)
        expect(actual.summary.inventory).toEqual(expected.summary.inventory)
      }
      expect(normalized(await h.db.select().from(observationUsageCurrent).all())).toEqual(
        sourceBefore,
      )
    }, 60_000)

    test('a retained v3 checkpoint stays intact while the reverse-owner protocol independently reaches EOF', async () => {
      await h.db
        .insert(observationProjectionBootstrap)
        .values({
          generation,
          channel: 'indexed-details-v3',
          cursor: 'original-v3-cursor',
          done: false,
        })
        .run()
      const boot = incrementalObservationBootstrap(h.db, generation, [
        {
          id: qualifiedObservationIndexChannel,
          refresh: true,
          page: async () => ({ items: [], nextCursor: null }),
        },
      ])
      expect(qualifiedObservationIndexChannel).toBe('indexed-details-v4')
      expect(await boot(new AbortController().signal)).toBe(1)
      expect(
        await h.db
          .select()
          .from(observationProjectionBootstrap)
          .where(eq(observationProjectionBootstrap.channel, 'indexed-details-v3'))
          .get(),
      ).toMatchObject({ cursor: 'original-v3-cursor', done: false })
      expect(
        await h.db
          .select()
          .from(observationProjectionBootstrap)
          .where(eq(observationProjectionBootstrap.channel, qualifiedObservationIndexChannel))
          .get(),
      ).toMatchObject({ cursor: null, done: true })
    })

    test('usage selection preserves every original execution relationship diagnostic while excluding its numerical values', async () => {
      await seedCompleteTask(h, 2, 0)
      await h.db.delete(observationUsageCaptures).run()
      await h.db.delete(observationInvocations).run()
      await h.db.update(nodeRuns).set({ runtime: 'opencode', opencodeSessionId: 'root' }).run()
      const native = persistentNativeFixture({ steps: 3, depth: 1 })
      cleanups.push(() => native.close())
      const f = setup(h, native, true)
      await f.apply('diagnostic-executions-original', [
        completeFixtureId('invocation', 0),
        completeFixtureId('invocation', 1),
      ])
      const query = {
          ...all,
          cohort: 'usage' as const,
          selection: JSON.stringify({
            source: { authority: 'crewstation', sourceId: 'other-authority' },
          }),
        },
        expected = await f.oracle(query),
        actual = content(await f.queries.request(actor, query, crypto.randomUUID()))
      const originals = expected.rows
        .filter(
          (row) => row.section === 'historical-executions' && row.parent === 'original-source',
        )
        .map((row) => row.document)
      expect(originals).toHaveLength(2)
      expect(
        expected.rows.filter(
          (row) => row.section === 'historical-executions' && row.parent === null,
        ),
      ).toHaveLength(0)
      expect(actual.summary.metrics).toEqual(expected.summary.metrics)
      const items: unknown[] = []
      let after: string | undefined
      do {
        const page = await f.queries.page(actor, actual.header.reportId, {
          section: 'historical-executions',
          parent: 'original-source',
          limit: 1,
          ...(after ? { after } : {}),
        })
        expect(page.total).toBe('2')
        items.push(...page.items)
        if (page.nextCursor !== null) expect(page.nextCursor).not.toBe(after)
        after = page.nextCursor ?? undefined
      } while (after)
      expect(normalized(items)).toEqual(normalized(originals))
    }, 60_000)

    test('original max=1 snapshot releases before empty and nonempty persistent staging', async () => {
      const actual = h.applicationBinding
      const single =
        actual.provider === 'postgresql'
          ? createPostgresqlDatabaseRuntime({
              config: { ...actual.databaseConfig, poolMax: 1 },
              generationId: actual.runtime.generationId,
            })
          : undefined
      try {
        const postgres = single ? createPostgresqlDatabaseClient(single) : undefined
        const db = postgres ?? h.db
        const selected: ProviderHarness = {
          ...h,
          db,
          session: databaseSessionFor(db),
          applicationBinding:
            single && postgres && actual.provider === 'postgresql'
              ? {
                  ...actual,
                  db: postgres,
                  runtime: single,
                  databaseConfig: { ...actual.databaseConfig, poolMax: 1 },
                }
              : actual,
        }
        const f = setup(selected)
        // PG reset restores baseline seed rows through original triggers.
        // This controlled empty-source fixture contains no Task or invocation;
        // acknowledge only that baseline outbox before the synthetic channel.
        expect(await db.select({ id: originalTasks.id }).from(originalTasks).all()).toEqual([])
        expect(
          await db.select({ id: observationInvocations.id }).from(observationInvocations).all(),
        ).toEqual([])
        await db.delete(observationProjectionChanges).run()
        const boot = incrementalObservationBootstrap(db, generation, [
            {
              id: qualifiedObservationIndexChannel,
              page: async () => ({ items: [], nextCursor: null }),
            },
          ]),
          signal = new AbortController().signal
        expect(await boot(signal)).toBe(1)
        expect(await boot(signal)).toBe(1)
        await f.drain()
        expect(content(await f.queries.request(actor, all, 'empty')).summary.inventory.tasks).toBe(
          '0',
        )
        await seedCompleteTask(selected, 2, 11)
        await f.apply('single-connection-data', [
          completeFixtureId('invocation', 0),
          completeFixtureId('invocation', 1),
        ])
        const expected = await f.oracle(all),
          report = content(await f.queries.request(actor, all, 'single'))
        expect(report.summary.metrics).toEqual(expected.summary.metrics)
        expect(report.summary.inventory).toEqual(expected.summary.inventory)
        await db.select({ id: originalTasks.id }).from(originalTasks).all()
      } finally {
        await single?.close()
      }
    }, 60_000)
    test('only the known obsolete v1 index channel is retired; unknown required checkpoints still fail explicitly', async () => {
      await h.db
        .insert(observationProjectionBootstrap)
        .values([
          { generation, channel: 'indexed-details-v1', cursor: 'original-v1-cursor', done: false },
          {
            generation,
            channel: 'a-required-original-channel',
            cursor: 'original-required-cursor',
            done: false,
          },
        ])
        .run()
      const boot = incrementalObservationBootstrap(h.db, generation, [
        {
          id: qualifiedObservationIndexChannel,
          page: async () => ({ items: [], nextCursor: null }),
        },
      ])
      await expect(boot(new AbortController().signal)).rejects.toThrow(
        'Original bootstrap channel disappeared',
      )
      expect(
        await h.db
          .select()
          .from(observationProjectionBootstrap)
          .where(eq(observationProjectionBootstrap.channel, 'a-required-original-channel'))
          .get(),
      ).toMatchObject({ cursor: 'original-required-cursor', done: false })
      expect(
        await h.db
          .select()
          .from(observationProjectionBootstrap)
          .where(eq(observationProjectionBootstrap.channel, 'indexed-details-v1'))
          .get(),
      ).toMatchObject({ cursor: 'original-v1-cursor', done: false })
    })
    test('an obsolete v2 checkpoint keeps its original cursor while the current candidate-set protocol reaches its real EOF', async () => {
      await h.db
        .insert(observationProjectionBootstrap)
        .values({
          generation,
          channel: 'indexed-details-v2',
          cursor: 'retained-original-v2-cursor',
          done: false,
        })
        .run()
      const boot = incrementalObservationBootstrap(h.db, generation, [
        {
          id: qualifiedObservationIndexChannel,
          refresh: true,
          page: async () => ({ items: [], nextCursor: null }),
        },
      ])
      expect(qualifiedObservationIndexChannel).toBe('indexed-details-v4')
      expect(await boot(new AbortController().signal)).toBe(1)
      expect(
        await h.db
          .select()
          .from(observationProjectionBootstrap)
          .where(eq(observationProjectionBootstrap.channel, 'indexed-details-v2'))
          .get(),
      ).toMatchObject({ cursor: 'retained-original-v2-cursor', done: false })
      expect(
        await h.db
          .select()
          .from(observationProjectionBootstrap)
          .where(eq(observationProjectionBootstrap.channel, qualifiedObservationIndexChannel))
          .get(),
      ).toMatchObject({ cursor: null, done: true })
    })
    test('a nonempty legacy v2 projection requalifies original candidate sets after unavailable EOF and restart without losing facts', async () => {
      await seedCompleteTask(h, 2, 0)
      const first = (await h.db
        .select()
        .from(originalTasks)
        .where(eq(originalTasks.id, 'complete-original-task'))
        .get())!
      await h.db
        .update(originalTasks)
        .set({ status: 'done' })
        .where(eq(originalTasks.id, first.id))
        .run()
      await h.db
        .insert(originalTasks)
        .values({
          ...first,
          id: 'excluded-original-task',
          rootTaskId: 'excluded-original-task',
          name: 'Excluded original task',
          status: 'failed',
        })
        .run()
      await h.db.delete(observationUsageCaptures).run()
      await h.db.delete(observationInvocations).run()
      await h.db.update(nodeRuns).set({ runtime: 'opencode', opencodeSessionId: 'root' }).run()
      await h.db
        .update(nodeRuns)
        .set({ taskId: 'excluded-original-task' })
        .where(eq(nodeRuns.id, completeFixtureId('run', 1)))
        .run()
      const native = persistentNativeFixture({ steps: 3, depth: 1 })
      cleanups.push(() => native.close())
      let available = true
      const reader = {
          ...native,
          query: {
            ...native.query,
            open: async (selection: Parameters<typeof native.query.open>[0]) =>
              available ? native.query.open(selection) : null,
          },
        },
        f = setup(h, reader, true)
      await f.apply('nonempty-v2-original-base', [
        completeFixtureId('invocation', 0),
        completeFixtureId('invocation', 1),
      ])
      const previous = (await f.store.snapshot())!,
        expectedAll = await f.oracle(all),
        sourceBefore = normalized(await h.db.select().from(observationUsageCurrent).all()),
        pricesBefore = normalized(
          await h.db.select().from(observationInvocationPriceRecords).all(),
        ),
        nativeBefore = native.writer
          .query('SELECT id,session_id,message_id,time_created,data FROM part ORDER BY id')
          .all(),
        rows = await h.db
          .select()
          .from(observationProjectionCurrent)
          .where(eq(observationProjectionCurrent.kind, 'contribution'))
          .all()
      expect(rows.length).toBeGreaterThan(0)
      // Simulate exactly the older persisted projection, leaving every original
      // producer/native fact, numerical atom, old EOF and watermark intact.
      await h.session.transaction(async (tx) => {
        for (const value of rows) {
          const original = JSON.parse(value.document) as QualifiedObservationContribution
          if (original.detail.parent === 'native-scope-groups') {
            await retainIncrementalObservationVersion(tx, {
              kind: 'contribution',
              key: original.key,
              component: original.component,
              version: previous,
              document: null,
            })
            await tx
              .delete(observationProjectionHistory)
              .where(
                and(
                  eq(observationProjectionHistory.kind, 'contribution'),
                  eq(observationProjectionHistory.key, original.key),
                  eq(observationProjectionHistory.fromRevision, previous.revision),
                ),
              )
              .run()
            await tx
              .delete(observationProjectionMemberships)
              .where(
                and(
                  eq(observationProjectionMemberships.key, original.key),
                  eq(observationProjectionMemberships.fromRevision, previous.revision),
                ),
              )
              .run()
          } else if (original.detail.historicalRecordScopes !== undefined) {
            const { historicalRecordScopes: _proof, ...detail } = original.detail
            await retainIncrementalObservationVersion(tx, {
              kind: 'contribution',
              key: original.key,
              component: original.component,
              version: previous,
              document: { ...original, detail },
            })
          }
        }
        await tx
          .delete(observationProjectionIndexedVersions)
          .where(
            eq(
              observationProjectionIndexedVersions.revision,
              qualifiedObservationIndexVersion(previous.revision),
            ),
          )
          .run()
        await tx
          .insert(observationProjectionIndexedVersions)
          .values({ revision: 'indexed-details-v2/' + previous.revision })
          .run()
        await tx
          .delete(observationProjectionBootstrap)
          .where(
            and(
              eq(observationProjectionBootstrap.generation, generation),
              eq(observationProjectionBootstrap.channel, qualifiedObservationIndexChannel),
            ),
          )
          .run()
        await tx
          .insert(observationProjectionBootstrap)
          .values({
            generation,
            channel: 'indexed-details-v2',
            cursor: 'nonempty-original-v2-cursor',
            done: false,
          })
          .run()
        await enqueueIncrementalObservationWork(tx, {
          id: 'nonempty-v2-real-upgrade',
          source: 'original-bootstrap-upgrade',
          revision: generation,
          components: [JSON.stringify(['root', 'root'])],
        })
      })
      expect(await f.store.indexedDetails(previous)).toBe(false)
      const held = content(await f.queries.request(actor, all, 'legacy-known-data'))
      expect(held.summary.metrics).toEqual(expectedAll.summary.metrics)
      available = false
      await expect(f.drain()).rejects.toThrow(
        'Original candidate-set index upgrade is waiting for native EOF',
      )
      expect(await f.store.snapshot()).toEqual(previous)
      expect(await f.store.indexedDetails(previous)).toBe(false)
      expect(
        await h.db
          .select()
          .from(observationProjectionWork)
          .where(eq(observationProjectionWork.id, 'nonempty-v2-real-upgrade'))
          .get(),
      ).toMatchObject({ completedRevision: null, appliedRevision: null })
      expect(normalized(await h.db.select().from(observationUsageCurrent).all())).toEqual(
        sourceBefore,
      )
      expect(normalized(await h.db.select().from(observationInvocationPriceRecords).all())).toEqual(
        pricesBefore,
      )
      expect(
        native.writer
          .query('SELECT id,session_id,message_id,time_created,data FROM part ORDER BY id')
          .all(),
      ).toEqual(nativeBefore)
      available = true
      // Reconstruct both original qualification and projection adapters, not a
      // prebuilt successful receipt, before consuming the original pending work.
      const restarted = setup(h, reader, true)
      await restarted.drain()
      expect(restarted.nativeOpens).toBeGreaterThan(0)
      const boot = composeOriginalProjectionBootstrap({
          db: h.db,
          generation,
          tasks: createProjectionTaskObservationFacts(h.db),
          owners: [],
        }),
        signal = new AbortController().signal
      for (;;) {
        const advanced = await boot(signal)
        await restarted.drain()
        if (!advanced) break
      }
      const current = (await restarted.store.snapshot())!
      expect(await restarted.store.indexedDetails(current)).toBe(true)
      expect(
        await h.db
          .select()
          .from(observationProjectionBootstrap)
          .where(eq(observationProjectionBootstrap.channel, 'indexed-details-v2'))
          .get(),
      ).toMatchObject({ cursor: 'nonempty-original-v2-cursor', done: false })
      expect(
        await h.db
          .select()
          .from(observationProjectionBootstrap)
          .where(eq(observationProjectionBootstrap.channel, qualifiedObservationIndexChannel))
          .get(),
      ).toMatchObject({ cursor: null, done: true })
      expect(
        await h.db
          .select()
          .from(observationProjectionWork)
          .where(eq(observationProjectionWork.id, 'nonempty-v2-real-upgrade'))
          .get(),
      ).toMatchObject({
        completedRevision: expect.any(String),
        appliedRevision: expect.any(String),
      })
      for (const query of [
        all,
        { ...all, cohort: 'usage' as const, status: 'done' as const },
        { ...all, cohort: 'started' as const, status: 'failed' as const },
      ]) {
        const expected = await restarted.oracle(query),
          actual = content(await restarted.queries.request(actor, query, crypto.randomUUID()))
        expect(actual.summary.metrics).toEqual(expected.summary.metrics)
        expect(actual.summary.inventory).toEqual(expected.summary.inventory)
        for (const [section, parent] of [
          ['historical-executions', null],
          ['historical-executions', 'original-source'],
          ['historical-records', null],
          ['time-partitions', null],
          ['time-unassigned', null],
        ] as const) {
          const original = expected.rows
              .filter((row) => row.section === section && row.parent === parent)
              .map((row) => row.document),
            items: unknown[] = []
          let after: string | undefined
          do {
            const page = await restarted.queries.page(actor, actual.header.reportId, {
              section,
              ...(parent ? { parent } : {}),
              limit: 2,
              ...(after ? { after } : {}),
            })
            expect(page.total, JSON.stringify({ query, section, parent })).toBe(
              String(original.length),
            )
            items.push(...page.items)
            if (page.nextCursor !== null) expect(page.nextCursor).not.toBe(after)
            after = page.nextCursor ?? undefined
          } while (after)
          expect(normalized(items)).toEqual(normalized(original))
        }
      }
      expect(normalized(await h.db.select().from(observationUsageCurrent).all())).toEqual(
        sourceBefore,
      )
      expect(normalized(await h.db.select().from(observationInvocationPriceRecords).all())).toEqual(
        pricesBefore,
      )
      expect(
        native.writer
          .query('SELECT id,session_id,message_id,time_created,data FROM part ORDER BY id')
          .all(),
      ).toEqual(nativeBefore)
    }, 60_000)

    test('physical candidate model and Agent predicates keep canonical received values and complete original-source EOF', async () => {
      await seedCompleteTask(h, 2, 0)
      await h.db.delete(observationUsageCaptures).run()
      await h.db.delete(observationInvocations).run()
      await h.db.update(nodeRuns).set({ runtime: 'opencode', opencodeSessionId: 'root' }).run()
      const native = persistentNativeFixture({ steps: 3, depth: 1 })
      cleanups.push(() => native.close())
      const f = setup(h, native, true)
      await f.apply('selected-physical-base', [
        completeFixtureId('invocation', 0),
        completeFixtureId('invocation', 1),
      ])
      const opens = f.nativeOpens
      for (const selection of [
        {
          model: {
            authority: 'local',
            sourceId: null,
            provider: 'actual-provider',
            model: 'actual-model',
          },
        },
        { model: { authority: 'local', sourceId: null, provider: null, model: null } },
        { agent: { id: null, revision: null } },
        { purpose: 'task' },
        { source: { authority: 'crewstation', sourceId: 'other-authority' } },
      ]) {
        const query = { ...all, cohort: 'usage' as const, selection: JSON.stringify(selection) },
          expected = await f.oracle(query),
          actual = content(await f.queries.request(actor, query, crypto.randomUUID()))
        expect(actual.summary.metrics).toEqual(expected.summary.metrics)
        expect(actual.summary.inventory).toEqual(expected.summary.inventory)
        for (const [section, parent] of [
          ['historical-executions', null],
          ['historical-executions', 'original-source'],
          ['historical-records', null],
          ['time-partitions', null],
          ['time-unassigned', null],
        ] as const) {
          const original = expected.rows
              .filter((row) => row.section === section && row.parent === parent)
              .map((row) => row.document),
            items: unknown[] = []
          let after: string | undefined
          do {
            const page = await f.queries.page(actor, actual.header.reportId, {
              section,
              ...(parent ? { parent } : {}),
              limit: 2,
              ...(after ? { after } : {}),
            })
            expect(page.total, JSON.stringify({ query, section, parent })).toBe(
              String(original.length),
            )
            items.push(...page.items)
            if (page.nextCursor !== null) expect(page.nextCursor).not.toBe(after)
            after = page.nextCursor ?? undefined
          } while (after)
          expect(normalized(items)).toEqual(normalized(original))
        }
      }
      expect(f.nativeOpens).toBe(opens)
    }, 60_000)

    test('complete excluded source and per-reference predicates survive indexed and fallback EOF with compact physical owner evidence', async () => {
      const population = 23
      await seedCompleteTask(h, population, 0)
      await h.db.update(originalTasks).set({ status: 'done' }).run()
      await h.db.delete(observationUsageCaptures).run()
      await h.db.delete(observationInvocations).run()
      await h.db
        .update(nodeRuns)
        .set({
          runtime: 'opencode',
          opencodeSessionId: 'root',
          agentOverrideId: 'candidate-b',
          agentOverrideName: 'Candidate B',
        })
        .run()
      await h.db
        .update(nodeRuns)
        .set({ agentOverrideId: 'candidate-a', agentOverrideName: 'Candidate A' })
        .where(eq(nodeRuns.id, completeFixtureId('run', 0)))
        .run()
      const native = persistentNativeFixture({ steps: 3, depth: 1 })
      cleanups.push(() => native.close())
      const first = setup(h, native, true)
      await first.apply(
        'compact-reference-base',
        Array.from({ length: population }, (_, n) => completeFixtureId('invocation', n)),
      )
      const current = (await first.store.snapshot())!,
        contributions = (
          await h.db
            .select({ document: observationProjectionCurrent.document })
            .from(observationProjectionCurrent)
            .where(eq(observationProjectionCurrent.kind, 'contribution'))
            .all()
        ).map((row) => JSON.parse(row.document) as QualifiedObservationContribution),
        groups = contributions.filter((row) => row.detail.parent === 'native-scope-groups'),
        references = contributions.filter(
          (row) => row.detail.section === 'historical-record-references',
        ),
        groupIds = new Set(groups.map((row) => row.detail.key))
      expect(groups).toHaveLength(3)
      for (const row of groups)
        expect((row.detail.document as { scopes: readonly unknown[] }).scopes).toHaveLength(
          population,
        )
      // Five physical records, each with every original candidate reference.
      expect(references).toHaveLength(population * 5)
      for (const row of contributions)
        if (
          row.detail.historicalRecordScopes?.length &&
          (row.detail.nativeRecord || row.detail.section === 'historical-record-references')
        ) {
          expect(row.detail.scopes).toBeUndefined()
          expect(row.detail.visibility).toBeUndefined()
          for (const key of row.detail.historicalRecordScopes) expect(groupIds.has(key)).toBe(true)
          if (row.detail.section === 'time-partitions') {
            expect(row.detail.document).not.toHaveProperty('scopes')
            expect(row.detail.document).not.toHaveProperty('visibility')
          }
        }
      for (const indexed of [true, false]) {
        if (!indexed)
          await h.db
            .delete(observationProjectionIndexedVersions)
            .where(
              eq(
                observationProjectionIndexedVersions.revision,
                qualifiedObservationIndexVersion(current.revision),
              ),
            )
            .run()
        const f = setup(h, native, true)
        expect(await f.store.indexedDetails(current)).toBe(indexed)
        for (const query of [
          { ...all, cohort: 'usage' as const, status: 'failed' as const },
          {
            ...all,
            cohort: 'usage' as const,
            selection: JSON.stringify({ agent: { id: 'candidate-a', revision: null } }),
          },
        ]) {
          const expected = await f.oracle(query),
            actual = content(await f.queries.request(actor, query, crypto.randomUUID())),
            requested = new Map<
              string,
              { section: CompleteObservationSection; parent: string | null }
            >()
          expect(actual.summary.metrics).toEqual(expected.summary.metrics)
          expect(actual.summary.inventory).toEqual(expected.summary.inventory)
          for (const row of expected.rows)
            if (
              (row.parent === 'original-source' &&
                ['historical-executions', 'historical-records'].includes(row.section)) ||
              row.section === 'historical-record-references'
            )
              requested.set(JSON.stringify([row.section, row.parent]), {
                section: row.section,
                parent: row.parent,
              })
          for (const { section, parent } of requested.values()) {
            const original = expected.rows
                .filter((row) => row.section === section && row.parent === parent)
                .map((row) => row.document),
              items: unknown[] = []
            let after: string | undefined
            do {
              const page = await f.queries.page(actor, actual.header.reportId, {
                section,
                ...(parent ? { parent } : {}),
                limit: 2,
                ...(after ? { after } : {}),
              })
              expect(page.total).toBe(String(original.length))
              items.push(...page.items)
              if (page.nextCursor !== null) expect(page.nextCursor).not.toBe(after)
              after = page.nextCursor ?? undefined
            } while (after)
            expect(normalized(items)).toEqual(normalized(original))
          }
          if ('status' in query) expect(actual.summary.inventory.tasks).toBe('0')
        }
        expect(f.nativeOpens).toBe(0)
      }
    }, 60_000)

    test('physical native parent/child roots across two Tasks retain the canonical candidate set in either change order', async () => {
      await seedCompleteTask(h, 2, 0)
      const original = (await h.db
        .select()
        .from(originalTasks)
        .where(eq(originalTasks.id, 'complete-original-task'))
        .get())!
      await h.db
        .insert(originalTasks)
        .values({
          ...original,
          id: 'second-original-task',
          rootTaskId: 'second-original-task',
          name: 'Second original task',
        })
        .run()
      // The zero-record helper also creates a synthetic zero-use capture.
      // Historical-only fixtures remove that capture with its accepted call,
      // while retaining every physical native record and historical owner.
      await h.db.delete(observationUsageCaptures).run()
      await h.db.delete(observationInvocations).run()
      await h.db
        .update(nodeRuns)
        .set({ runtime: 'opencode', opencodeSessionId: 'root' })
        .where(eq(nodeRuns.id, completeFixtureId('run', 0)))
        .run()
      await h.db
        .update(nodeRuns)
        .set({ taskId: 'second-original-task', runtime: 'opencode', opencodeSessionId: 'child-0' })
        .where(eq(nodeRuns.id, completeFixtureId('run', 1)))
        .run()
      const native = persistentNativeFixture({ steps: 3, depth: 1 })
      cleanups.push(() => native.close())
      const f = setup(h, native)
      for (const n of [0, 1, 0]) {
        await f.apply('physical-roots-' + n + '-' + crypto.randomUUID(), [
          completeFixtureId('invocation', n),
        ])
        const expected = await f.oracle(all),
          actual = content(await f.queries.request(actor, all, 'parents'))
        expect(actual.summary.metrics).toEqual(expected.summary.metrics)
        expect(actual.summary.inventory).toEqual(expected.summary.inventory)
        const rows = await f.queries.page(actor, actual.header.reportId, {
          section: 'historical-records',
          limit: 200,
        })
        expect(normalized(rows.items)).toEqual(
          normalized(
            expected.rows
              .filter((row) => row.section === 'historical-records' && row.parent === null)
              .map((row) => row.document),
          ),
        )
      }
    }, 60_000)
    test('temporary missing native EOF retains every known bucket and record until recovery without duplicate usage', async () => {
      await seedCompleteTask(h, 1, 0)
      await h.db.delete(observationUsageCaptures).run()
      await h.db.delete(observationInvocations).run()
      await h.db.update(nodeRuns).set({ runtime: 'opencode', opencodeSessionId: 'root' }).run()
      const native = persistentNativeFixture({ steps: 3, depth: 1 })
      cleanups.push(() => native.close())
      let available = true
      const reader = {
        ...native,
        query: {
          ...native.query,
          open: async (selection: Parameters<typeof native.query.open>[0]) =>
            available ? native.query.open(selection) : null,
        },
      }
      const f = setup(h, reader)
      await f.apply('initial-native', [completeFixtureId('invocation', 0)])
      const before = content(await f.queries.request(actor, all, 'before')).summary
      available = false
      await f.apply('native-outage', [completeFixtureId('invocation', 0)])
      const during = content(await f.queries.request(actor, all, 'outage')).summary
      expect(during.metrics.state).toBe('not-ready')
      expect(before.metrics.state).toBe('not-ready')
      if (before.metrics.state !== 'not-ready' || during.metrics.state !== 'not-ready')
        throw new Error('expected known native facts and explicit source gap')
      expect(before.metrics.recordedUsage?.tokens).toBeDefined()
      expect(during.metrics.recordedUsage?.tokens).toEqual(before.metrics.recordedUsage?.tokens)
      expect(during.metrics.gaps).toContain('historical-native-unavailable')
      expect(
        'numericRecords' in during.inventory ? during.inventory.numericRecords : undefined,
      ).toBe('numericRecords' in before.inventory ? before.inventory.numericRecords : undefined)
      available = true
      await f.apply('native-recovered', [completeFixtureId('invocation', 0)])
      const after = content(await f.queries.request(actor, all, 'after')).summary
      expect(after.metrics).toEqual(before.metrics)
      expect(after.inventory).toEqual(before.inventory)
    }, 60_000)
    test('shared physical native records preserve original membership under Task status and usage-hour boundaries', async () => {
      await seedCompleteTask(h, 2, 0)
      const first = (await h.db
        .select()
        .from(originalTasks)
        .where(eq(originalTasks.id, 'complete-original-task'))
        .get())!
      await h.db
        .update(originalTasks)
        .set({ status: 'done' })
        .where(eq(originalTasks.id, first.id))
        .run()
      await h.db
        .insert(originalTasks)
        .values({
          ...first,
          id: 'excluded-original-task',
          rootTaskId: 'excluded-original-task',
          name: 'Excluded original task',
          status: 'failed',
        })
        .run()
      await h.db.delete(observationUsageCaptures).run()
      await h.db.delete(observationInvocations).run()
      await h.db.update(nodeRuns).set({ runtime: 'opencode', opencodeSessionId: 'root' }).run()
      await h.db
        .update(nodeRuns)
        .set({ taskId: 'excluded-original-task' })
        .where(eq(nodeRuns.id, completeFixtureId('run', 1)))
        .run()
      const native = persistentNativeFixture({ steps: 3, depth: 1 })
      cleanups.push(() => native.close())
      const f = setup(h, native, true)
      await f.apply('shared-status-base', [
        completeFixtureId('invocation', 0),
        completeFixtureId('invocation', 1),
      ])
      const projected = (
          await h.db
            .select({ document: observationProjectionCurrent.document })
            .from(observationProjectionCurrent)
            .where(eq(observationProjectionCurrent.kind, 'contribution'))
            .all()
        ).map((row) => JSON.parse(row.document) as QualifiedObservationContribution),
        physicalGroups = projected.filter(
          (row) =>
            row.detail.section === 'cohort-fold' && row.detail.parent === 'native-scope-groups',
        ),
        references = projected.filter(
          (row) => row.detail.section === 'cohort-fold' && row.detail.key.startsWith('reference/'),
        ),
        groupIds = new Set(physicalGroups.map((row) => row.detail.key)),
        originalScopes = references.flatMap((row) => row.detail.scopes ?? [])
      expect(physicalGroups).toHaveLength(3)
      expect(references).toHaveLength(2)
      expect(groupIds.size).toBe(physicalGroups.length)
      for (const row of physicalGroups) {
        const group = row.detail.document as { scopes: readonly unknown[]; observed: boolean }
        expect(normalized(group.scopes)).toEqual(normalized(originalScopes))
        expect(group.observed).toBe(true)
      }
      for (const row of references) {
        expect(row.detail.historicalRecordScopes).toHaveLength(3)
        for (const key of row.detail.historicalRecordScopes ?? []) {
          expect(typeof key).toBe('string')
          expect(groupIds.has(key)).toBe(true)
        }
      }
      for (const cohort of ['usage', 'started'] as const)
        for (const status of [undefined, 'done', 'failed'] as const)
          for (const [from, to] of [
            [COMPLETE_NOW, COMPLETE_NOW + 86400000],
            [COMPLETE_NOW + 1, COMPLETE_NOW + 2],
          ]) {
            const query = {
              from: from!,
              to: to!,
              timezone: 'UTC',
              cohort,
              ...(status ? { status } : {}),
            }
            const expected = await f.oracle(query),
              actual = content(await f.queries.request(actor, query, crypto.randomUUID()))
            expect(actual.summary.metrics).toEqual(expected.summary.metrics)
            expect(actual.summary.inventory).toEqual(expected.summary.inventory)
            const records = await f.queries.page(actor, actual.header.reportId, {
              section: 'historical-records',
              limit: 200,
            })
            expect(normalized(records.items)).toEqual(
              normalized(
                expected.rows
                  .filter((row) => row.section === 'historical-records' && row.parent === null)
                  .map((row) => row.document),
              ),
            )
            // An unknown clock is diagnosed completely, rather than leaking
            // into the admitted records or disappearing from the original EOF.
            for (const section of ['time-partitions', 'time-unassigned'] as const) {
              const original = expected.rows
                .filter((row) => row.section === section && row.parent === null)
                .map((row) => row.document)
              const items: unknown[] = []
              let after: string | undefined
              do {
                const page = await f.queries.page(actor, actual.header.reportId, {
                  section,
                  limit: 2,
                  ...(after ? { after } : {}),
                })
                expect(page.total).toBe(String(original.length))
                items.push(...page.items)
                if (page.nextCursor !== null) expect(page.nextCursor).not.toBe(after)
                after = page.nextCursor ?? undefined
              } while (after)
              expect(normalized(items)).toEqual(normalized(original))
            }
          }
    }, 60_000)
    test('actual native WAL, shared root candidates and original EOF match the canonical historical allocator without duplicate numbers', async () => {
      await seedCompleteTask(h, 2, 0)
      await h.db
        .update(nodeRuns)
        .set({ runtime: 'opencode', opencodeSessionId: 'root' })
        .where(eq(nodeRuns.taskId, 'complete-original-task'))
        .run()
      const native = persistentNativeFixture({ steps: 23, depth: 2 })
      cleanups.push(() => native.close())
      const f = setup(h, native)
      await f.apply('native-shared', [
        completeFixtureId('invocation', 0),
        completeFixtureId('invocation', 1),
      ])
      const expected = await f.oracle(all),
        actual = content(await f.queries.request(actor, all, 'native'))
      expect(actual.summary.metrics).toEqual(expected.summary.metrics)
      expect(actual.summary.inventory).toEqual(expected.summary.inventory)
      for (const section of [
        'historical-records',
        'historical-executions',
        'agents',
        'runtimes',
        'models',
        'purposes',
        'sources',
      ] as const) {
        const page = await f.queries.page(actor, actual.header.reportId, { section, limit: 200 })
        expect(normalized(page.items)).toEqual(
          normalized(
            expected.rows
              .filter((row) => row.section === section && row.parent === null)
              .map((row) => row.document),
          ),
        )
      }
    }, 60_000)
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
            const page: CompleteObservationReportPage<unknown> = await f.queries.page(
              actor,
              actual.header.reportId,
              {
                section,
                limit: 200,
              },
            )
            expect(normalized(page.items)).toEqual(
              normalized(
                expected.rows
                  .filter((row) => row.section === section && row.parent === null)
                  .map((row) => row.document),
              ),
            )
          }
        }, 60_000)
    test('211 persisted Tasks including zero-call and failed Tasks survive a scoped cohort; old incompatible views renew without changing original facts', async () => {
      await seedCompleteTask(h, 1, 0)
      await h.db.delete(observationUsageCaptures).run()
      await h.db.delete(observationInvocations).run()
      await h.db.update(nodeRuns).set({ runtime: 'opencode', opencodeSessionId: 'root' }).run()
      const native = persistentNativeFixture({ steps: 3, depth: 1 })
      cleanups.push(() => native.close())
      const original = (await h.db.select().from(originalTasks).all())[0]!
      const added = Array.from({ length: 210 }, (_, index) => {
        const id = completeFixtureId('no-call-task', index),
          startedAt = COMPLETE_NOW - (index < 100 ? 86400000 : 0) + index + 100
        return {
          ...original,
          id,
          name: 'Original Task without a call ' + index,
          rootTaskId: id,
          workflowSnapshot: JSON.stringify({
            nodes: index === 0 ? [{ id: 'shared-original-node', kind: 'agent-single' }] : [],
          }),
          status: index % 2 === 0 ? ('failed' as const) : ('done' as const),
          startedAt,
          branchStartedAt: startedAt,
          finishedAt: startedAt + 1,
          runningMs: 1,
        }
      })
      await h.db.insert(originalTasks).values(added).run()
      await h.db
        .insert(nodeRuns)
        .values({
          id: 'shared-original-run',
          taskId: added[0]!.id,
          nodeId: 'shared-original-node',
          status: 'done',
          runtime: 'opencode',
          opencodeSessionId: 'root',
          startedAt: COMPLETE_NOW,
          finishedAt: COMPLETE_NOW + 10,
        })
        .run()
      const before = normalized(await h.db.select().from(originalTasks).all()),
        f = setup(h, native, true)
      await f.apply(
        'all-original-tasks',
        [completeFixtureId('invocation', 0)],
        'original-row-changes',
        added.map((row) => row.id),
      )
      const expected = await f.oracle(all),
        views = incrementalObservationViews(h.db),
        old = await views.retain({
          actorScope: completeObservationActorScope(actor),
          generation,
          version: (await f.store.snapshot())!,
          query: all,
        })
      await expect(f.queries.status(actor, old.id)).rejects.toMatchObject({ code: 'not-found' })
      const report = content(await f.queries.request(actor, all, 'original-scope-renewal'))
      expect(report.header.reportId).not.toBe(old.id)
      expect(report.summary.inventory.tasks).toBe('211')
      expect(report.summary.inventory).toEqual(expected.summary.inventory)
      expect(report.summary.metrics).toEqual(expected.summary.metrics)
      const trends: CompleteObservationReportPage<{ tasks: string }> = await f.queries.page(
        actor,
        report.header.reportId,
        { section: 'trends', limit: 100 },
      )
      expect(trends.nextCursor).toBeNull()
      expect(trends.items.reduce((sum, day) => sum + BigInt(day.tasks), 0n)).toBe(211n)
      expect(normalized(trends.items)).toEqual(
        normalized(
          expected.rows
            .filter((row) => row.section === 'trends' && row.parent === null)
            .map((row) => row.document),
        ),
      )
      async function taskPages(queries: typeof f.queries) {
        const rows: unknown[] = []
        let cursor: string | null = null
        do {
          const page: CompleteObservationReportPage<unknown> = await queries.page(
            actor,
            report.header.reportId,
            { section: 'tasks', limit: 37, ...(cursor ? { after: cursor } : {}) },
          )
          expect(page.total).toBe('211')
          rows.push(...page.items)
          cursor = page.nextCursor
        } while (cursor !== null)
        return rows
      }
      const tasks = await taskPages(f.queries)
      expect(tasks).toHaveLength(211)
      expect(normalized(await h.db.select().from(originalTasks).all())).toEqual(before)
      expect((await views.get(old.id, completeObservationActorScope(actor))).query).toEqual(all)
      const resumed = setup(h, native, true),
        retained = content(await resumed.queries.status(actor, report.header.reportId))
      expect(retained.summary).toEqual(report.summary)
      expect(await taskPages(resumed.queries)).toEqual(tasks)
    }, 60_000)
    test('periods share original increments and complete days; UTC half-open boundaries preserve every bucket, category and page', async () => {
      await seedCompleteTask(h, 2, 7, discreteRequest)
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
            const page: CompleteObservationReportPage<unknown> = await f.queries.page(
              actor,
              actual.header.reportId,
              {
                section: section satisfies CompleteObservationSection,
                limit: 2,
                ...(cursor ? { after: cursor } : {}),
              },
            )
            rows.push(...page.items)
            cursor = page.nextCursor
            expect(page.total).toBe(String(expectedRows.length))
          } while (cursor !== null)
          expect(normalized(rows)).toEqual(normalized(expectedRows.map((row) => row.document)))
        }
      }
    }, 60_000)
    for (const legacyDone of [true, false])
      test(`persisted ${legacyDone ? 'complete' : 'interrupted'} v1 duplicate-cell indexes upgrade once from retained atoms, survive restart and preserve every original record and old report`, async () => {
        await seedCompleteTask(h, 2, 7, discreteRequest)
        const f = setup(h, undefined, true)
        await f.apply('legacy-population', [
          completeFixtureId('invocation', 0),
          completeFixtureId('invocation', 1),
        ])
        const previous = (await f.store.snapshot())!,
          query = { ...all, cohort: 'usage' as const },
          expected = await f.oracle(query),
          sourceBefore = normalized(await h.db.select().from(observationUsageCurrent).all()),
          rows = await h.db
            .select()
            .from(observationProjectionCurrent)
            .where(
              and(
                eq(observationProjectionCurrent.kind, 'contribution'),
                eq(observationProjectionCurrent.section, 'time-partitions'),
              ),
            )
            .all()
        expect(rows).toHaveLength(7)
        // Reproduce the previous persisted algorithm using original atoms and
        // its second equivalent descriptor. The original fact is never changed.
        await h.session.transaction(async (tx) => {
          for (const value of rows) {
            const original = JSON.parse(value.document) as QualifiedObservationContribution,
              document = original.detail.document as ProjectionOccurrence,
              reordered = Object.fromEntries(
                Object.entries(document).reverse(),
              ) as ProjectionOccurrence,
              descriptor = observationWindowCellKey(original.component, reordered)!,
              alias = 'occurrence-cell/' + sha256Hex(descriptor)
            expect(original.aggregates).not.toContain(alias)
            await tx
              .insert(observationProjectionDescriptors)
              .values({ key: alias, document: descriptor })
              .onConflictDoNothing()
              .run()
            const accumulated = await tx
              .select()
              .from(observationProjectionCurrent)
              .where(
                and(
                  eq(observationProjectionCurrent.kind, 'aggregate'),
                  eq(observationProjectionCurrent.key, alias),
                ),
              )
              .get()
            await retainIncrementalObservationVersion(tx, {
              kind: 'aggregate',
              key: alias,
              component: null,
              version: previous,
              document: replaceIncrementalObservationContribution(
                accumulated
                  ? (JSON.parse(accumulated.document) as IncrementalObservationFold)
                  : emptyIncrementalObservationFold(),
                null,
                original.fold,
              ),
            })
            await retainIncrementalObservationVersion(tx, {
              kind: 'contribution',
              key: original.key,
              component: original.component,
              version: previous,
              document: { ...original, aggregates: [...original.aggregates, alias] },
            })
          }
          await tx
            .delete(observationProjectionIndexedVersions)
            .where(
              eq(
                observationProjectionIndexedVersions.revision,
                qualifiedObservationIndexVersion(previous.revision),
              ),
            )
            .run()
          await tx
            .insert(observationProjectionIndexedVersions)
            .values({ revision: previous.revision })
            .run()
          await tx
            .delete(observationProjectionBootstrap)
            .where(
              and(
                eq(observationProjectionBootstrap.generation, generation),
                eq(observationProjectionBootstrap.channel, qualifiedObservationIndexChannel),
              ),
            )
            .run()
          await tx
            .insert(observationProjectionBootstrap)
            .values({
              generation,
              channel: 'indexed-details-v1',
              done: legacyDone,
              cursor: legacyDone ? null : 'original-v1-checkpoint',
            })
            .run()
        })
        await h.session.transaction((tx) =>
          enqueueIncrementalObservationWork(tx, {
            id: 'original-v1-pending',
            source: 'original-bootstrap-upgrade',
            revision: generation,
            components: [rows[0]!.component!],
          }),
        )
        // A legacy receipt does not certify v2. Exact raw atoms keep statistics
        // available while derived indexes are being repaired in the background.
        expect(await f.store.indexedDetails(previous)).toBe(false)
        const oldReport = content(await f.queries.request(actor, query, 'before-upgrade'))
        expect(oldReport.summary.metrics).toEqual(expected.summary.metrics)
        const opensBefore = f.nativeOpens,
          createBoot = () =>
            composeOriginalProjectionBootstrap({
              db: h.db,
              generation,
              tasks: createProjectionTaskObservationFacts(h.db),
              owners: [],
            }),
          signal = new AbortController().signal
        const boot = createBoot()
        expect(await boot(signal)).toBe(1)
        expect(await boot(signal)).toBe(1)
        const checkpoint = await h.db
          .select()
          .from(observationProjectionBootstrap)
          .where(
            and(
              eq(observationProjectionBootstrap.generation, generation),
              eq(observationProjectionBootstrap.channel, qualifiedObservationIndexChannel),
            ),
          )
          .get()
        expect(checkpoint?.done).toBe(true)
        expect(await f.store.indexedDetails(previous)).toBe(false)
        // Restart between the durable enumeration checkpoint and its work ACK.
        const restarted = createBoot()
        await f.drain()
        for (;;) {
          const advanced = await restarted(signal)
          await f.drain()
          if (!advanced) break
        }
        const current = (await f.store.snapshot())!
        expect(await f.store.indexedDetails(current)).toBe(true)
        expect(f.nativeOpens).toBe(opensBefore)
        expect(
          (
            await h.db
              .select()
              .from(observationProjectionWork)
              .where(eq(observationProjectionWork.id, 'original-v1-pending'))
              .get()
          )?.completedRevision,
        ).toMatch(/^[1-9][0-9]*$/)
        expect(
          await h.db
            .select()
            .from(observationProjectionBootstrap)
            .where(
              and(
                eq(observationProjectionBootstrap.generation, generation),
                eq(observationProjectionBootstrap.channel, 'indexed-details-v1'),
              ),
            )
            .get(),
        ).toMatchObject({ done: legacyDone, cursor: legacyDone ? null : 'original-v1-checkpoint' })
        expect(normalized(await h.db.select().from(observationUsageCurrent).all())).toEqual(
          sourceBefore,
        )
        const repaired = content(await f.queries.request(actor, query, 'after-upgrade'))
        expect(repaired.summary.metrics).toEqual(expected.summary.metrics)
        expect(repaired.summary.inventory).toEqual(expected.summary.inventory)
        expect(content(await f.queries.status(actor, oldReport.header.reportId))).toEqual(oldReport)
        const beforeIdle = await f.store.snapshot()
        expect(await restarted(signal)).toBe(0)
        await f.drain()
        expect(await f.store.snapshot()).toEqual(beforeIdle)
        for await (const value of f.store.details({ version: current, section: 'time-partitions' }))
          expect(value.aggregates.filter((key) => key.startsWith('occurrence-cell/'))).toHaveLength(
            1,
          )
      }, 60000)
    test('ordinary Task dimensions outside a selected cohort never become standalone history', async () => {
      await seedCompleteTask(h, 2, 7, discreteRequest)
      const f = setup(h)
      await f.apply('original-cohort-filter-boundaries', [
        completeFixtureId('invocation', 0),
        completeFixtureId('invocation', 1),
      ])
      for (const query of [
        { ...all, q: 'no-original-task-matches' },
        { ...all, status: 'running' as const },
        { ...all, workflow: 'unrelated-original-workflow' },
        { ...all, repository: 'unrelated-original-repository' },
        { ...all, status: 'done' as const },
      ]) {
        const expected = await f.oracle(query),
          actual = content(await f.queries.request(actor, query, 'original-filter'))
        expect(actual.summary.metrics).toEqual(expected.summary.metrics)
        expect(actual.summary.inventory).toEqual(expected.summary.inventory)
        for (const section of [
          'tasks',
          'agents',
          'runtimes',
          'models',
          'purposes',
          'sources',
        ] as const) {
          expect(actual.counts[section]).toBe(
            String(
              expected.rows.filter((row) => row.section === section && row.parent === null).length,
            ),
          )
          const rows: unknown[] = [],
            seen = new Set<string>()
          let after: string | null = null
          do {
            const page: CompleteObservationReportPage<unknown> = await f.queries.page(
              actor,
              actual.header.reportId,
              { section, limit: 2, ...(after ? { after } : {}) },
            )
            expect(page.total).toBe(actual.counts[section] ?? '0')
            rows.push(...page.items)
            if (page.nextCursor !== null) {
              expect(page.items.length).toBeGreaterThan(0)
              expect(seen.has(page.nextCursor)).toBe(false)
              seen.add(page.nextCursor)
            }
            after = page.nextCursor
          } while (after !== null)
          expect(rows).toEqual(
            expected.rows
              .filter((row) => row.section === section && row.parent === null)
              .map((row) => row.document),
          )
        }
      }
    }, 60000)
    for (const indexed of [false, true])
      test(`public time-partition contract covers default/started/selected cohorts and Task views with ${indexed ? 'indexed' : 'original-atom'} reads`, async () => {
        await seedCompleteTask(h, 2, 7, discreteRequest)
        const f = setup(h, undefined, indexed)
        await f.apply('public-time-contract', [
          completeFixtureId('invocation', 0),
          completeFixtureId('invocation', 1),
        ])
        for (const query of [
          all,
          { ...all, cohort: 'started' as const },
          { ...all, selection: JSON.stringify({ purpose: 'task' }) },
        ]) {
          const expected = await f.oracle(query),
            report = content(await f.queries.request(actor, query, 'cohort'))
          expect(report.summary.metrics).toEqual(expected.summary.metrics)
          for (const section of ['time-partitions', 'time-unassigned'] as const) {
            expect(report.counts[section]).toBe('0')
            expect(
              await f.queries.page(actor, report.header.reportId, { section, limit: 2 }),
            ).toMatchObject({ items: [], total: '0', nextCursor: null })
          }
        }
        for (const query of [all, { ...all, cohort: 'usage' as const }]) {
          const report = content(
            await f.queries.request(actor, query, 'task', 'complete-original-task'),
          )
          for (const section of ['time-partitions', 'time-unassigned'] as const)
            expect(
              await f.queries.page(actor, report.header.reportId, { section, limit: 2 }),
            ).toMatchObject({ items: [], total: '0', nextCursor: null })
        }
        const query = { ...all, cohort: 'usage' as const },
          expected = await f.oracle(query),
          report = content(await f.queries.request(actor, query, 'usage'))
        const items: unknown[] = []
        let after: string | null = null
        do {
          const page: CompleteObservationReportPage<unknown> = await f.queries.page(
            actor,
            report.header.reportId,
            {
              section: 'time-partitions',
              limit: 2,
              ...(after ? { after } : {}),
            },
          )
          expect(page.total).toBe('7')
          items.push(...page.items)
          after = page.nextCursor
        } while (after !== null)
        expect(normalized(items)).toEqual(
          normalized(
            expected.rows
              .filter((row) => row.section === 'time-partitions' && row.parent === null)
              .map((row) => row.document),
          ),
        )
        expect(report.summary.metrics).toEqual(expected.summary.metrics)
      }, 60000)
    test('a same-ID revision replaces values once while the old retained report stays immutable', async () => {
      await seedCompleteTask(h, 2, 7)
      const f = setup(h)
      await f.apply('initial', [
        completeFixtureId('invocation', 0),
        completeFixtureId('invocation', 1),
      ])
      const first = content(await f.queries.request(actor, all, 'first')),
        original = completeTaskRecord(0, 2)
      const contribution = {
        input: '9007199254740999',
        cacheRead: '17',
        cacheWrite: '19',
        output: '23',
      }
      const revised = {
        ...original,
        contribution,
        measurement: { ...original.measurement, revision: 2, usage: contribution },
        observedRevision: 2,
      }
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
    test('indexed ordinary counts and keyset pages retain every original allocation while metadata/cells share the same version', async () => {
      await seedCompleteTask(h, 2, 211, discreteRequest)
      const f = setup(h, undefined, true)
      await f.apply('indexed-original', [
        completeFixtureId('invocation', 0),
        completeFixtureId('invocation', 1),
      ])
      const expected = await f.oracle(all),
        report = content(await f.queries.request(actor, all, 'indexed')),
        rows: unknown[] = []
      let after: string | null = null
      do {
        const page: CompleteObservationReportPage<unknown> = await f.queries.page(
          actor,
          report.header.reportId,
          {
            section: 'allocations',
            limit: 37,
            ...(after ? { after } : {}),
          },
        )
        expect(page.total).toBe('211')
        rows.push(...page.items)
        after = page.nextCursor
      } while (after !== null)
      expect(normalized(rows)).toEqual(
        normalized(
          expected.rows
            .filter((row) => row.section === 'allocations' && row.parent === null)
            .map((row) => row.document),
        ),
      )
      expect(report.counts.allocations).toBe('211')
      for (const days of [7, 30]) {
        const query = {
            from: COMPLETE_NOW - days * 86400000,
            to: asOf,
            timezone: 'Asia/Shanghai',
            cohort: 'usage' as const,
          },
          window = content(await f.queries.request(actor, query, 'indexed-' + days)),
          original = await f.oracle(query)
        expect(window.summary.metrics).toEqual(original.summary.metrics)
      }
    }, 60000)
    test('same-version subtree comparisons preserve original metrics and missing causal evidence', async () => {
      await seedCompleteTask(h, 1, 3)
      const f = setup(h, undefined, true)
      await f.apply('compare-original', [completeFixtureId('invocation', 0)])
      const report = content(await f.queries.request(actor, all, 'compare')),
        comparison = await f.queries.compare!(
          actor,
          report.header.reportId,
          'complete-original-task',
          'complete-original-task',
        )
      expect(comparison.revision).toBe(report.header.sourceRevision)
      expect(comparison.left).toEqual(comparison.right)
      expect(comparison.left.metrics).toEqual(report.summary.metrics)
      expect(comparison.criticalPath).toEqual({
        state: 'not-ready',
        reasons: ['causal-dependencies-unobserved'],
      })
      await expect(
        f.queries.compare!(actor, report.header.reportId, 'unknown', 'complete-original-task'),
      ).rejects.toThrow('outside this report')
    }, 60000)
    test('all original review stages reach EOF and unfinished old waits stay unknown after Task closure', async () => {
      await seedCompleteTask(h, 1, 0)
      for (let at = 0; at < 211; at += 100)
        await h.db
          .insert(docVersions)
          .values(
            Array.from({ length: Math.min(100, 211 - at) }, (_, n) => ({
              id: 'original-review-' + String(at + n).padStart(6, '0'),
              taskId: 'complete-original-task',
              reviewNodeId: 'original-review',
              reviewNodeRunId: completeFixtureId('run', 0),
              sourceNodeId: 'original-source',
              sourcePortName: 'output',
              versionIndex: at + n + 1,
              reviewIteration: 0,
              bodyPath: 'original-retained.md',
              createdAt: COMPLETE_NOW + 100,
              decidedAt: at + n === 210 ? null : COMPLETE_NOW + 200,
              decision: at + n === 210 ? ('pending' as const) : ('approved' as const),
            })),
          )
          .run()
      const read = originalObservationLifecyclePhases(h.db),
        rows: ObservationPhase[] = []
      let after: string | undefined
      for (;;) {
        const page = await read('complete-original-task', {
          limit: 37,
          ...(after ? { after } : {}),
        })
        rows.push(...page.items)
        if (page.nextCursor === null) break
        after = page.nextCursor
      }
      expect(rows).toHaveLength(211)
      expect(rows.at(-1)).toMatchObject({ status: 'unknown', endedAt: null, basis: 'review-round' })
      expect(rows[0]).toMatchObject({
        startedAt: COMPLETE_NOW + 100,
        endedAt: COMPLETE_NOW + 200,
        status: 'closed',
      })
      const f = setup(h, undefined, true)
      await f.apply('stages-source', [completeFixtureId('invocation', 0)])
      const report = content(await f.queries.request(actor, all, 'stages')),
        page = await f.queries.page(actor, report.header.reportId, {
          section: 'phases',
          limit: 200,
        })
      expect(page.total).toBe('211')
      expect(page.nextCursor).not.toBeNull()
    }, 60000)
    test('explicit maintenance prepares durably, confirms once and completes only after every original component is committed', async () => {
      await seedCompleteTask(h, 1, 6)
      const f = setup(h, undefined, true)
      await f.apply('maintenance-base', [completeFixtureId('invocation', 0)])
      const first = content(await f.queries.request(actor, all, 'maintenance')),
        maintenance = observationMaintenance({
          db: h.db,
          reports: f.queries,
          scopeOf: completeObservationActorScope,
          failed: (error) => {
            throw error
          },
          now: () => asOf + 1000,
        }),
        request = {
          requestKey: 'original-resumable-maintenance',
          reportId: first.header.reportId,
          mode: 'rebuild' as const,
        },
        created = await maintenance.commands.prepare(actor, request)
      expect(created.state).toBe('preparing')
      expect((await maintenance.commands.prepare(actor, request)).id).toBe(created.id)
      await maintenance.tick()
      const preview = await maintenance.commands.status(actor, created.id)
      expect(preview.state).toBe('preview')
      expect(preview.records).toBe('6')
      const confirmation = { expectedDigest: preview.scopeDigest, confirmation: 'APPLY' as const },
        confirmed = await maintenance.commands.confirm(actor, created.id, confirmation)
      expect(confirmed.state).toBe('running')
      expect(await maintenance.commands.confirm(actor, created.id, confirmation)).toEqual(confirmed)
      await maintenance.tick()
      expect((await maintenance.commands.status(actor, created.id)).state).toBe('running')
      await f.drain()
      await maintenance.tick()
      expect((await maintenance.commands.status(actor, created.id)).state).toBe('complete')
      expect(content(await f.queries.status(actor, first.header.reportId)).summary.metrics).toEqual(
        first.summary.metrics,
      )
      expect(
        content(await f.queries.request(actor, all, 'after-maintenance')).summary.metrics,
      ).toEqual(first.summary.metrics)
    }, 60000)
    test('expired preview continuations cannot replace a confirmed operation after lease takeover', async () => {
      await seedCompleteTask(h, 1, 6)
      const f = setup(h, undefined, true)
      await f.apply('lease-base', [completeFixtureId('invocation', 0)])
      const report = content(await f.queries.request(actor, all, 'lease-report'))
      for (const rejectOld of [false, true]) {
        let at = asOf + 1000,
          entered!: () => void,
          release!: () => void,
          first = true
        const blocked = new Promise<void>((resolve) => {
            entered = resolve
          }),
          resumed = new Promise<void>((resolve) => {
            release = resolve
          }),
          errors: unknown[] = []
        const reports = {
          ...f.queries,
          page: async <T>(...args: Parameters<typeof f.queries.page<T>>) => {
            if (first) {
              first = false
              entered()
              await resumed
              if (rejectOld) throw new Error('old preview failed')
            }
            return f.queries.page<T>(...args)
          },
        }
        const old = observationMaintenance({
            db: h.db,
            reports,
            scopeOf: completeObservationActorScope,
            now: () => at,
            failed: (error) => {
              errors.push(error)
            },
          }),
          replacement = observationMaintenance({
            db: h.db,
            reports: f.queries,
            scopeOf: completeObservationActorScope,
            now: () => at,
            failed: (error) => {
              throw error
            },
          })
        const created = await old.commands.prepare(actor, {
          requestKey: 'lease-' + rejectOld,
          reportId: report.header.reportId,
          mode: 'rebuild',
        })
        const pending = old.tick()
        await blocked
        at += 40000
        await replacement.tick()
        const preview = await replacement.commands.status(actor, created.id)
        expect(preview).toMatchObject({ state: 'preview', records: '6' })
        const confirmed = await replacement.commands.confirm(actor, created.id, {
          expectedDigest: preview.scopeDigest,
          confirmation: 'APPLY',
        })
        release()
        await pending
        expect(await replacement.commands.status(actor, created.id)).toEqual(confirmed)
        const row = await h.db
          .select()
          .from(observationMaintenanceOperations)
          .where(eq(observationMaintenanceOperations.id, created.id))
          .get()
        expect(row?.state).toBe('running')
        expect(errors.length).toBeGreaterThan(0)
        // Finish this operation before the next takeover case is selected.
        await replacement.tick()
        await f.drain()
        await replacement.tick()
      }
    }, 60000)
    test('confirmed reprice freezes every original record and updates valuation without rewriting acceptance or tokens', async () => {
      await seedCompleteTask(h, 1, 6)
      const f = setup(h, undefined, true)
      await f.apply('reprice-base', [completeFixtureId('invocation', 0)])
      const before = content(await f.queries.request(actor, all, 'reprice-before')),
        accepted = await h.db.select().from(observationInvocations).all()
      await createObservationPriceStore(h.db).change('complete-runtime', async (scope) =>
        scope.append(
          ObservationPriceVersionSchema.parse({
            id: 'corrective-price',
            registrationId: 'complete-runtime',
            revision: 2,
            configurationRevision: 0,
            protocol: 'opencode',
            provider: 'native',
            model: 'actual',
            condition: null,
            currency: 'CNY',
            rates: { input: '2', cacheRead: '4', cacheWrite: '6', output: '8' },
            effectiveFrom: new Date(COMPLETE_NOW - 1).toISOString(),
            createdAt: new Date(asOf).toISOString(),
            createdBy: actor.user.id,
            sourceNote: 'Validation catalogue only',
          }),
          'corrective-request',
          'corrective-fingerprint',
        ),
      )
      const maintenance = observationMaintenance({
          db: h.db,
          reports: f.queries,
          scopeOf: completeObservationActorScope,
          now: () => asOf + 1000,
          failed: (error) => {
            throw error
          },
        }),
        created = await maintenance.commands.prepare(actor, {
          requestKey: 'complete-record-reprice',
          reportId: before.header.reportId,
          mode: 'reprice',
          registrationId: 'complete-runtime',
          targetPriceBookRevision: 2,
        })
      await maintenance.tick()
      const preview = await maintenance.commands.status(actor, created.id)
      expect(preview).toMatchObject({
        state: 'preview',
        records: '6',
        unpricedRecords: '0',
        knownOriginalCny: '0.00105',
        knownProposedCny: '0.0021',
        knownPairedDeltaCny: '0.00105',
      })
      await maintenance.commands.confirm(actor, created.id, {
        expectedDigest: preview.scopeDigest,
        confirmation: 'APPLY',
      })
      await maintenance.tick()
      await f.drain()
      await maintenance.tick()
      expect((await maintenance.commands.status(actor, created.id)).state).toBe('complete')
      expect(await h.db.select().from(observationInvocationPriceRecords).all()).toHaveLength(6)
      expect(await h.db.select().from(observationInvocations).all()).toEqual(accepted)
      const after = content(await f.queries.request(actor, all, 'reprice-after'))
      expect(after.summary.metrics.state).toBe('ready')
      if (before.summary.metrics.state !== 'ready' || after.summary.metrics.state !== 'ready')
        throw new Error('expected fully priced original records')
      expect(after.summary.metrics.tokens).toEqual(before.summary.metrics.tokens)
      expect(after.summary.metrics.cost).toMatchObject({ currency: 'CNY', amount: '0.0021' })
      expect(content(await f.queries.status(actor, before.header.reportId)).summary).toEqual(
        before.summary,
      )
    }, 60000)
    test('a catalogue with four missing prices remains unpriced in the frozen preview and original valuation', async () => {
      await seedCompleteTask(h, 1, 1)
      const f = setup(h, undefined, true)
      await f.apply('unpriced-base', [completeFixtureId('invocation', 0)])
      const before = content(await f.queries.request(actor, all, 'unpriced-before')),
        accepted = await h.db.select().from(observationInvocations).all()
      await createObservationPriceStore(h.db).change('complete-runtime', async (scope) =>
        scope.append(
          ObservationPriceVersionSchema.parse({
            id: 'unpriced-catalogue',
            registrationId: 'complete-runtime',
            revision: 2,
            configurationRevision: 0,
            protocol: 'opencode',
            provider: 'native',
            model: 'actual',
            condition: null,
            currency: 'CNY',
            rates: { input: null, cacheRead: null, cacheWrite: null, output: null },
            effectiveFrom: new Date(COMPLETE_NOW - 1).toISOString(),
            createdAt: new Date(asOf).toISOString(),
            createdBy: actor.user.id,
            sourceNote: 'Validation missing-price catalogue',
          }),
          'unpriced-request',
          'unpriced-fingerprint',
        ),
      )
      const maintenance = observationMaintenance({
          db: h.db,
          reports: f.queries,
          scopeOf: completeObservationActorScope,
          now: () => asOf + 1000,
          failed: (error) => {
            throw error
          },
        }),
        created = await maintenance.commands.prepare(actor, {
          requestKey: 'four-missing-prices',
          reportId: before.header.reportId,
          mode: 'reprice',
          registrationId: 'complete-runtime',
          targetPriceBookRevision: 2,
        })
      await maintenance.tick()
      const preview = await maintenance.commands.status(actor, created.id)
      expect(preview).toMatchObject({
        state: 'preview',
        records: '1',
        unpricedRecords: '1',
        knownOriginalCny: '0.00005',
        knownProposedCny: null,
        knownPairedDeltaCny: null,
      })
      await maintenance.commands.confirm(actor, created.id, {
        expectedDigest: preview.scopeDigest,
        confirmation: 'APPLY',
      })
      await maintenance.tick()
      await f.drain()
      await maintenance.tick()
      expect((await maintenance.commands.status(actor, created.id)).state).toBe('partial')
      expect(await h.db.select().from(observationInvocations).all()).toEqual(accepted)
      const after = content(await f.queries.request(actor, all, 'unpriced-after'))
      expect(after.summary.metrics.state).toBe('ready')
      if (before.summary.metrics.state !== 'ready' || after.summary.metrics.state !== 'ready')
        throw new Error('expected original known price and corrected unpriced state')
      expect(after.summary.metrics.tokens).toEqual(before.summary.metrics.tokens)
      expect(after.summary.metrics.cost).toMatchObject({
        currency: 'CNY',
        state: 'unpriced',
        amount: null,
      })
      expect(content(await f.queries.status(actor, before.header.reportId)).summary).toEqual(
        before.summary,
      )
    }, 60000)
  },
)

// RFC-371 report-load-performance: repeated historical owners reuse one snapshot's
// parent qualification, while cache eviction must never hide an identity conflict or cap EOF.
import { expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import type { HistoricalObservationExecution } from '@agent-workflow/shared'
import { buildActor } from '@/auth/actor'
import { nodeRuns, nodeRunEvents } from '@/db/schema'
import { sha256Hex } from '@/util/hash'
import { originalReportSnapshotSession } from '@/platform/persistence/reportSnapshot'
import type { OriginalReportSnapshot } from '@/platform/persistence/reportSnapshotTypes'
import { createCompleteTaskObservationFacts } from '@/modules/task-execution/composition/taskObservationFacts'
import { createHistoricalTaskObservationFacts } from '@/modules/task-execution/composition/historicalObservationFacts'
import { stageHistoricalObservationSources } from '@/modules/run-observability/application/historicalObservationSource'
import { completeWorkingTraversal } from '@/modules/run-observability/application/completeWorkingTraversal'
import { createCompleteObservationSources } from '@/modules/run-observability/infrastructure/completeObservationSources'
import { completeObservationValuation } from '@/modules/run-observability/infrastructure/completeObservationValuation'
import { completeUsageWorkspace } from '@/modules/run-observability/infrastructure/completeUsageWorkspace'
import type { HistoricalWorkingExecution } from '@/modules/run-observability/ports/historicalObservationWorking'
import type { CompleteWorkingRows } from '@/modules/run-observability/ports/completeWorkingRows'
import { describeEachProvider, type ProviderHarness } from './helpers/eachProvider'
import {
  COMPLETE_NOW,
  completeFixtureId,
  seedCompleteTask,
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
function source(harness: ProviderHarness) {
  const binding = harness.applicationBinding
  return binding.provider === 'sqlite'
    ? { ...binding, generationId: 'historical-cache-original-snapshot' }
    : { provider: 'postgresql' as const, runtime: binding.runtime }
}
async function inputFor(snapshot: OriginalReportSnapshot, conflictAfterEviction = false) {
  const tasks = createCompleteTaskObservationFacts(snapshot.executor),
    query = createHistoricalTaskObservationFacts(snapshot.executor),
    namespace = 'historical-cache-fixture',
    lookups: string[] = []
  const parent = await tasks.get(actor, 'complete-original-task')
  if (!parent) throw new Error('Original fixture Task missing')
  await snapshot.workspace.insert(namespace + '/original-tasks', [
    {
      key: parent.id,
      document: parent,
    },
  ])
  let first: HistoricalObservationExecution | undefined,
    ownerPages = 0,
    ownerEOF = false
  const value = completeObservationValuation({
    db: snapshot.executor,
    rows: snapshot.workspace,
    namespace: namespace + '/value',
  })
  return {
    lookups,
    pages: () => ({ ownerPages, ownerEOF }),
    input: {
      actor,
      query: { from: COMPLETE_NOW, to: COMPLETE_NOW + 60_000, timezone: 'UTC' },
      asOf: snapshot.asOf,
      namespace,
      rows: snapshot.workspace,
      keyOf: sha256Hex,
      usageWorkspace: completeUsageWorkspace,
      value: value.value,
      sources: {
        ...createCompleteObservationSources({
          db: snapshot.executor,
          tasks,
          snapshotId: snapshot.snapshotId,
        }),
        historical: {
          owners: [
            {
              kind: 'task' as const,
              query: {
                ...query,
                async owners(input: Parameters<typeof query.owners>[0]) {
                  const page = await query.owners(input)
                  ownerPages++
                  first ??= page.items[0]
                  if (page.nextCursor === null) {
                    ownerEOF = true
                    if (conflictAfterEviction && first)
                      return {
                        ...page,
                        items: [...page.items, { ...first, name: 'changed identity' }],
                      }
                  }
                  return page
                },
              },
            },
          ],
          task: async (id: string) => {
            lookups.push(id)
            return tasks.get(actor, id)
          },
          native: {
            open: async () => null,
            generation: async () => null,
          },
        },
      },
    },
  }
}

describeEachProvider('RFC-371 original historical qualification cache', (harness) => {
  test.each([2, 4097])(
    '%i distinct original root edges retain all events but write each relation once, including replay after eviction',
    async (distinct) => {
      await seedCompleteTask(harness, 1, 0)
      const session = (index: number) => 'original-cache-root-' + index,
        runId = completeFixtureId('run', 0)
      await harness.db
        .update(nodeRuns)
        .set({ opencodeSessionId: session(0) })
        .where(eq(nodeRuns.id, runId))
        .run()
      const sessions = [
        ...Array.from({ length: 500 }, () => session(0)),
        ...Array.from({ length: distinct }, (_, index) => session(index)),
        session(0),
      ]
      for (let start = 0; start < sessions.length; start += 100)
        await harness.db
          .insert(nodeRunEvents)
          .values(
            sessions.slice(start, start + 100).map((sessionId, index) => ({
              nodeRunId: runId,
              ts: COMPLETE_NOW + start + index,
              kind: 'text' as const,
              payload: '{}',
              sessionId,
            })),
          )
          .run()
      await originalReportSnapshotSession(source(harness)).run(async (snapshot) => {
        const fixture = await inputFor(snapshot),
          original = fixture.input.rows,
          namespace = fixture.input.namespace + '/historical',
          writes = { roots: 0, references: 0, executions: 0 }
        let nativeRoots = 0
        const put: CompleteWorkingRows['put'] = async (space, row) => {
          if (space === namespace + '/roots') writes.roots++
          if (space.startsWith(namespace + '/root-refs/')) writes.references++
          if (space.startsWith(namespace + '/execution-roots/')) writes.executions++
          await original.put(space, row)
        }
        const stage = await stageHistoricalObservationSources({
          ...fixture.input,
          rows: { ...original, put },
          sources: {
            ...fixture.input.sources,
            historical: {
              ...fixture.input.sources.historical,
              native: {
                ...fixture.input.sources.historical.native,
                open: async () => {
                  nativeRoots++
                  return null
                },
              },
            },
          },
        })
        expect(stage?.sourceRows).toBe('1')
        expect(fixture.lookups).toEqual(['complete-original-task'])
        expect(writes).toEqual({ roots: distinct, references: distinct, executions: distinct })
        expect(nativeRoots).toBe(distinct)
        const roots = new Set<string>()
        for await (const row of completeWorkingTraversal<{ sessionId: string }>(
          original,
          namespace + '/roots',
        ))
          roots.add(row.document.sessionId)
        expect(roots).toEqual(
          new Set(Array.from({ length: distinct }, (_, index) => session(index))),
        )
        let events: { rows: string; eof: boolean } | undefined
        for await (const row of completeWorkingTraversal<{
          source: string
          rows: string
          eof: boolean
        }>(original, stage!.receiptsNamespace))
          if (row.document.source?.includes('/events/')) events = row.document
        expect(events).toMatchObject({ rows: String(sessions.length), eof: true })
        const first = await original.page<{ referenceId: string }>(
          namespace + '/root-refs/' + sha256Hex(session(0)),
          null,
        )
        expect(first.nextCursor).toBeNull()
        expect(first.items).toHaveLength(1)
        expect(first.items[0]?.document.referenceId).toBe(
          JSON.stringify(['historical-observed', 'task', runId]),
        )
      })
    },
    60_000,
  )

  test('501 original attempts reuse the same parent and retain every execution and owner/event EOF', async () => {
    await seedCompleteTask(harness, 501, 0)
    await originalReportSnapshotSession(source(harness)).run(async (snapshot) => {
      const fixture = await inputFor(snapshot)
      const stage = await stageHistoricalObservationSources(fixture.input)
      expect(stage?.sourceRows).toBe('501')
      expect(fixture.lookups).toEqual(['complete-original-task'])
      expect(fixture.pages()).toEqual({ ownerPages: 6, ownerEOF: true })
      const executions: HistoricalWorkingExecution[] = []
      for await (const row of completeWorkingTraversal<HistoricalWorkingExecution>(
        snapshot.workspace,
        stage!.executionsNamespace,
      ))
        executions.push(row.document)
      expect(executions).toHaveLength(501)
      expect(new Set(executions.map((value) => value.execution.ownerId))).toEqual(
        new Set(Array.from({ length: 501 }, (_, index) => completeFixtureId('run', index))),
      )
      expect(
        executions.every(
          (value) =>
            value.scopeMatch === 'matched' &&
            value.timeBasis === 'task-cohort' &&
            value.parentTask?.id === 'complete-original-task',
        ),
      ).toBe(true)
      let receipts = 0
      for await (const row of completeWorkingTraversal<{ eof: boolean }>(
        snapshot.workspace,
        stage!.receiptsNamespace,
      )) {
        expect(row.document.eof).toBe(true)
        receipts++
      }
      expect(receipts).toBe(502)
    })
  }, 60_000)

  test('an original execution replay after 4096-cache eviction still rejects changed content at the real owner EOF', async () => {
    await seedCompleteTask(harness, 1, 0)
    for (let start = 1; start < 4097; start += 100) {
      await harness.db
        .insert(nodeRuns)
        .values(
          Array.from({ length: Math.min(100, 4097 - start) }, (_, offset) => ({
            id: completeFixtureId('run', start + offset),
            taskId: 'complete-original-task',
            nodeId: completeFixtureId('node', start + offset),
            status: 'done' as const,
            startedAt: COMPLETE_NOW,
            finishedAt: COMPLETE_NOW + 1,
          })),
        )
        .run()
    }
    await originalReportSnapshotSession(source(harness)).run(async (snapshot) => {
      const fixture = await inputFor(snapshot, true)
      await expect(stageHistoricalObservationSources(fixture.input)).rejects.toThrow(
        'Original historical execution identity changed',
      )
      expect(fixture.pages()).toEqual({ ownerPages: 41, ownerEOF: true })
      expect(fixture.lookups).toEqual(['complete-original-task'])
      const first = await snapshot.workspace.get<HistoricalWorkingExecution>(
        fixture.input.namespace + '/historical/executions',
        sha256Hex(JSON.stringify(['historical-observed', 'task', completeFixtureId('run', 0)])),
      )
      expect(first?.execution.name).toBe('Original complete task')
      expect(first?.execution.ownerId).toBe(completeFixtureId('run', 0))
    })
  }, 60_000)
})

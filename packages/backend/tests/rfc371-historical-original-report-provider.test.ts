// RFC-371: historical owner rows and native artifacts must remain complete without forged admissions,
// double counting, guessed retry clocks, or applying today's rate to yesterday's observations.
import { afterEach, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { eq } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  CompleteHistoricalObservationExecution,
  CompleteHistoricalObservationRecord,
  CompleteHistoricalObservationReference,
  CompleteObservationReportPage,
  CompleteObservationSection,
  CompleteObservationTask,
  CompleteObservationTrend,
  HistoricalNativeObservationReader,
  HistoricalObservationPage,
  ObservationOverviewQuery,
  CompleteObservationTimePartition,
  CompleteObservationDimension,
} from '@agent-workflow/shared'
import { buildActor } from '@/auth/actor'
import {
  nodeRuns,
  tasks,
  memoryDistillJobs,
  memoryDistillEvents,
  intentSessions,
  intentTurns,
  intentTurnEvents,
  mcps,
  observationInvocations,
  observationUsageCaptures,
  taskExecutionObservationSources,
  mcpRuntimeTestSessions,
  mcpRuntimeTestTurns,
  mcpRuntimeTestEvents,
} from '@/db/schema'
import { sha256Hex } from '@/util/hash'
import { originalReportSnapshotSession } from '@/platform/persistence/reportSnapshot'
import { createCompleteTaskObservationFacts } from '@/modules/task-execution/composition/taskObservationFacts'
import { createHistoricalTaskObservationFacts } from '@/modules/task-execution/composition/historicalObservationFacts'
import { createHistoricalMemoryObservationFacts } from '@/modules/memory/composition/historicalObservationFacts'
import { createHistoricalIntentObservationFacts } from '@/modules/intent/composition/historicalObservationFacts'
import { createHistoricalMcpObservationFacts } from '@/modules/resource-catalog/composition/historicalObservationFacts'
import { createHistoricalNativeUsageQuery } from '@/modules/runtime-management/composition/historicalNativeUsage'
import { composeCompleteObservationSnapshot } from '@/modules/run-observability/composition/completeObservationSnapshot'
import { completeObservationFileSpool } from '@/modules/run-observability/infrastructure/completeObservationFileSpool'
import { completeObservationReportCache } from '@/modules/run-observability/infrastructure/completeObservationReportStore'
import { completeObservationActorScope } from '@/modules/run-observability/infrastructure/completeObservationReportDocuments'
import { completeObservationReportService } from '@/modules/run-observability/application/completeObservationReportService'
import {
  COMPLETE_NOW,
  completeFixtureId,
  seedCompleteTask,
} from './helpers/rfc371CompleteTaskFixture'
import { describeEachProvider, type ProviderHarness } from './helpers/eachProvider'

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
const range = { from: COMPLETE_NOW, to: COMPLETE_NOW + 60_000, timezone: 'UTC' }
const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close()
})
async function all<T>(read: (after?: string) => Promise<HistoricalObservationPage<T>>) {
  const items: T[] = []
  let after: string | undefined
  for (;;) {
    const page: HistoricalObservationPage<T> = await read(after)
    items.push(...page.items)
    if (page.nextCursor === null) return items
    expect(page.nextCursor).not.toBe(after)
    after = page.nextCursor
  }
}
function nativeArtifact() {
  const directory = mkdtempSync(join(tmpdir(), 'aw-original-historical-'))
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }))
  const path = join(directory, 'opencode.db'),
    db = new Database(path)
  cleanups.push(() => db.close())
  db.exec(`CREATE TABLE session(id TEXT PRIMARY KEY,parent_id TEXT,time_created INTEGER);
    CREATE INDEX session_parent ON session(parent_id,id);
    CREATE TABLE message(id TEXT PRIMARY KEY,session_id TEXT,data TEXT);
    CREATE TABLE part(id TEXT PRIMARY KEY,session_id TEXT,message_id TEXT,time_created INTEGER,data TEXT);
    CREATE INDEX part_session ON part(session_id,id);`)
  function root(id: string, parent: string | null = null) {
    db.run('INSERT INTO session VALUES (?,?,?)', [id, parent, COMPLETE_NOW])
    db.run('INSERT INTO message VALUES (?,?,?)', [
      'message-' + id,
      id,
      JSON.stringify({ role: 'assistant', providerID: 'native', modelID: 'actual' }),
    ])
  }
  function step(
    id: string,
    session: string,
    input: number,
    output: number | null,
    read = 0,
    write = 0,
    occurredAt: number | null = COMPLETE_NOW + 1,
  ) {
    db.run('INSERT INTO part VALUES (?,?,?,?,?)', [
      id,
      session,
      'message-' + session,
      occurredAt,
      JSON.stringify({
        type: 'step-finish',
        tokens: { input, output, reasoning: output === null ? null : 2, cache: { read, write } },
      }),
    ])
  }
  return {
    path,
    root,
    step,
    changeInput(id: string, input: number) {
      const row = db.query<{ data: string }, [string]>('SELECT data FROM part WHERE id=?').get(id)!
      const data = JSON.parse(row.data)
      data.tokens.input = input
      db.run('UPDATE part SET data=? WHERE id=?', [JSON.stringify(data), id])
    },
  }
}
function serviceFor(
  harness: ProviderHarness,
  path: string,
  beforeNativeOpen?: () => void,
  unknownOwnerClock?: string,
) {
  const binding = harness.applicationBinding
  const source =
    binding.provider === 'sqlite'
      ? { ...binding, generationId: 'original-historical-fixture' }
      : { provider: 'postgresql' as const, runtime: binding.runtime }
  const generation =
    source.provider === 'sqlite' ? source.generationId : source.runtime.generationId
  const cache = completeObservationReportCache(
    harness.db,
    generation,
    createCompleteTaskObservationFacts,
  )
  const home = mkdtempSync(join(tmpdir(), 'aw-historical-report-'))
  cleanups.push(() => rmSync(home, { recursive: true, force: true }))
  const spool = completeObservationFileSpool(home)
  const service = completeObservationReportService({
    store: cache,
    spool,
    owner: randomUUID(),
    heartbeatDuringRead: false,
    scopeOf: completeObservationActorScope,
    keyOf: sha256Hex,
    newId: randomUUID,
    build: (report, signal) =>
      originalReportSnapshotSession(source).run((snapshot) => {
        const originalTasks = createCompleteTaskObservationFacts(
          snapshot.executor,
          report.request.taskId,
        )
        return composeCompleteObservationSnapshot({
          snapshot,
          tasks: originalTasks,
          report,
          spool,
          signal,
          historical: {
            owners: [
              { kind: 'task', query: createHistoricalTaskObservationFacts(snapshot.executor) },
              {
                kind: 'memory-distill',
                query: (() => {
                  const query = createHistoricalMemoryObservationFacts(snapshot.executor)
                  if (unknownOwnerClock === undefined) return query
                  // The nullable owner-clock protocol is exercised on the real provider/SDK path.
                  return {
                    ...query,
                    async owners(input: Parameters<typeof query.owners>[0]) {
                      const page = await query.owners(input)
                      return {
                        ...page,
                        items: page.items.map((owner) =>
                          owner.ownerId === unknownOwnerClock
                            ? { ...owner, createdAt: null, startedAt: null }
                            : owner,
                        ),
                      }
                    },
                  }
                })(),
              },
              {
                kind: 'intent-turn',
                query: createHistoricalIntentObservationFacts(snapshot.executor),
              },
              {
                kind: 'mcp-runtime-test',
                query: createHistoricalMcpObservationFacts(snapshot.executor),
              },
            ],
            native: (() => {
              const original = createHistoricalNativeUsageQuery({ OPENCODE_DB: path })
              return {
                generation: original.generation,
                async open(
                  input: Parameters<typeof original.open>[0],
                ): Promise<HistoricalNativeObservationReader | null> {
                  beforeNativeOpen?.()
                  return original.open(input)
                },
              }
            })(),
            task: (id) => originalTasks.get(actor, id),
          },
        })
      }, signal),
  })
  cleanups.push(() => service.worker.stop())
  async function report(query: ObservationOverviewQuery = range, taskId?: string) {
    const accepted = await service.request(actor, query, randomUUID(), taskId)
    const id = accepted.state === 'ready' ? accepted.header.reportId : accepted.reportId
    await service.worker.drain()
    const original = await service.status(actor, id)
    const content =
      original.state === 'ready'
        ? original
        : original.state === 'not-ready'
          ? original.facts
          : undefined
    expect(content).toBeDefined()
    if (!content) throw new Error('Original historical report did not retain its known facts')
    return { id, original, content }
  }
  async function pages<T>(id: string, section: CompleteObservationSection, parent?: string) {
    const items: T[] = []
    let after: string | undefined
    for (;;) {
      const page: CompleteObservationReportPage<T> = await service.page<T>(actor, id, {
        section,
        limit: 1,
        ...(parent === undefined ? {} : { parent }),
        ...(after === undefined ? {} : { after }),
      })
      items.push(...page.items)
      if (page.nextCursor === null) {
        expect(String(items.length)).toBe(page.total)
        return items
      }
      expect(page.nextCursor).not.toBe(after)
      after = page.nextCursor
    }
  }
  return { report, pages, cache, service }
}
async function job(
  harness: ProviderHarness,
  id: string,
  rootSession: string | null,
  parentTaskId: string | null = null,
  createdAt = COMPLETE_NOW,
) {
  await harness.db
    .insert(memoryDistillJobs)
    .values({
      id,
      debounceKey: id,
      sourceKind: 'feedback',
      sourceEventId: id,
      taskId: parentTaskId,
      scopeResolvedJson: '[]',
      status: 'done',
      attempts: 1,
      nextRunAt: createdAt,
      createdAt,
      startedAt: createdAt + 1,
      finishedAt: createdAt + 2,
      opencodeSessionId: rootSession,
    })
    .run()
}

describeEachProvider(
  'RFC-371 original historical executions and full native reports',
  (harness) => {
    test('actual consumption days use the chosen timezone across midnight and daylight-saving transition without changing original totals', async () => {
      const instants = [
        '2026-03-08T04:59:59.999Z',
        '2026-03-08T05:00:00Z',
        '2026-03-08T06:59:59.999Z',
        '2026-03-08T07:00:00Z',
      ].map(Date.parse)
      await seedCompleteTask(harness, 1, 4, (record) => {
        const n = Number(record.measurement.recordId.split('-').at(-1))
        return {
          ...record,
          measurement: {
            ...record.measurement,
            recordId: 'opencode:step:day-' + n,
            occurredAt: instants[n]!,
          },
        }
      })
      const native = nativeArtifact(),
        service = serviceFor(harness, native.path)
      const range = { from: instants[0]!, to: instants[3]! + 1, cohort: 'usage' as const }
      const local = await service.report({ ...range, timezone: 'America/New_York' }),
        utc = await service.report({ ...range, timezone: 'UTC' })
      expect(local.content.summary.metrics).toEqual(utc.content.summary.metrics)
      expect(local.content.summary.metrics).toMatchObject({
        state: 'ready',
        records: '4',
        tokens: { total: '160' },
        cost: { amount: '0.0005' },
      })
      const localDays = await service.pages<CompleteObservationTrend>(local.id, 'trends'),
        utcDays = await service.pages<CompleteObservationTrend>(utc.id, 'trends')
      expect(localDays.map((day) => day.key)).toEqual(['2026-03-07', '2026-03-08'])
      expect(
        localDays.map((day) => (day.metrics.state === 'ready' ? day.metrics.tokens.total : null)),
      ).toEqual(['16', '144'])
      expect(utcDays).toHaveLength(1)
      expect(utcDays[0]?.metrics).toMatchObject({ tokens: { total: '160' } })
      for (const day of localDays) expect(day.tasks).toBe('1')
    }, 120_000)

    test('usage window selects a Task born before the range and exactly partitions original time, late receipt and frozen CNY', async () => {
      const from = COMPLETE_NOW + 100,
        to = COMPLETE_NOW + 200
      await seedCompleteTask(harness, 1, 3, (record) => {
        const n = Number(record.measurement.recordId.split('-').at(-1))
        return {
          ...record,
          measurement: {
            ...record.measurement,
            recordId: 'opencode:step:time-' + n,
            occurredAt: n === 0 ? from : n === 1 ? to : null,
            observedAt: to + 99_000,
          },
        }
      })
      const native = nativeArtifact(),
        service = serviceFor(harness, native.path)
      const filters = { from, to, timezone: 'UTC' },
        original = await service.report(filters)
      expect(original.content.header.filters).not.toHaveProperty('cohort')
      expect(original.content.summary.inventory.tasks).toBe('0')
      const window = await service.report({ ...filters, cohort: 'usage' })
      expect(window.content.header.filters.cohort).toBe('usage')
      expect(window.content.summary.metrics).toMatchObject({
        state: 'not-ready',
        recordedUsage: {
          tokens: { input: '1', cacheRead: '3', cacheWrite: '5', output: '7', total: '16' },
        },
        recordedCost: { currency: 'CNY', amount: '0.00005' },
      })
      expect(window.content.summary.usageWindow?.partitions['in-window']).toMatchObject({
        records: '1',
        metrics: { tokens: { total: '16' }, cost: { amount: '0.00005' } },
      })
      expect(window.content.summary.usageWindow?.partitions['outside-window']).toMatchObject({
        records: '1',
        metrics: { tokens: { total: '32' }, cost: { amount: '0.0001' } },
      })
      expect(window.content.summary.usageWindow?.partitions['unassigned-time']).toMatchObject({
        records: '1',
        metrics: { tokens: { total: '48' }, cost: { amount: '0.00015' } },
      })
      const partitions = await service.pages<CompleteObservationTimePartition>(
        window.id,
        'time-partitions',
      )
      expect(partitions).toHaveLength(3)
      expect(new Set(partitions.map((p) => p.identity)).size).toBe(3)
      expect(partitions.find((p) => p.recordId.endsWith('time-1'))?.partition).toBe(
        'outside-window',
      )
      const unassigned = await service.pages<CompleteObservationTimePartition>(
        window.id,
        'time-unassigned',
      )
      expect(unassigned).toHaveLength(1)
      expect(unassigned[0]?.recordId).toBe('opencode:step:time-2')
      const trends = await service.pages<CompleteObservationTrend>(window.id, 'trends')
      expect(trends).toHaveLength(1)
      expect(trends[0]?.metrics).toMatchObject({
        state: 'ready',
        records: '1',
        tokens: { total: '16' },
      })
      for (const section of ['agents', 'runtimes', 'models', 'purposes', 'sources'] as const) {
        const dimensions = await service.pages<CompleteObservationDimension>(window.id, section)
        expect(dimensions).toHaveLength(1)
        expect(dimensions[0]?.metrics).toMatchObject({
          state: 'not-ready',
          recordedUsage: { tokens: { total: '16' } },
          recordedCost: { amount: '0.00005' },
        })
        const members = await service.pages<CompleteObservationTask>(
          window.id,
          'dimension-tasks',
          dimensions[0]!.key,
        )
        expect(members).toHaveLength(1)
        expect(members[0]?.task.id).toBe('complete-original-task')
      }
      const task = await service.report(filters, 'complete-original-task')
      expect(task.content.summary.metrics).toMatchObject({
        state: 'ready',
        tokens: { total: '96' },
        cost: { amount: '0.0003' },
      })
      expect(task.content.summary).not.toHaveProperty('usageWindow')
      await expect(
        service.service.request(
          actor,
          { ...filters, cohort: 'usage' },
          'invalid-task-window',
          'complete-original-task',
        ),
      ).rejects.toThrow('Task details show lifecycle usage')
    }, 120_000)

    test('window values retain pending Task sources and unobserved attempts without borrowing lifecycle numbers', async () => {
      await seedCompleteTask(harness, 1, 1, (record) => ({
        ...record,
        measurement: {
          ...record.measurement,
          recordId: 'opencode:step:pending-source-step',
          occurredAt: COMPLETE_NOW + 10,
        },
      }))
      await harness.db
        .insert(taskExecutionObservationSources)
        .values({
          taskId: 'complete-original-task',
          nodeRunId: completeFixtureId('run', 0),
          evidenceJson: '{}',
          pending: true,
        })
        .run()
      const native = nativeArtifact(),
        service = serviceFor(harness, native.path),
        filters = {
          from: COMPLETE_NOW + 5,
          to: COMPLETE_NOW + 20,
          timezone: 'UTC',
          cohort: 'usage' as const,
        }
      const pending = await service.report(filters)
      expect(pending.content.summary.metrics).toMatchObject({
        state: 'not-ready',
        gaps: expect.arrayContaining(['source-projection-pending']),
        recordedUsage: {
          records: '1',
          tokens: { input: '1', cacheRead: '3', cacheWrite: '5', output: '7', total: '16' },
        },
        recordedCost: { currency: 'CNY', amount: '0.00005' },
      })
      const pendingTasks = await service.pages<CompleteObservationTask>(pending.id, 'tasks')
      expect(pendingTasks).toHaveLength(1)
      expect(pendingTasks[0]!.metrics).toEqual(pending.content.summary.metrics)
      expect(
        await service.pages<CompleteObservationTask>(
          pending.id,
          'quality-tasks',
          'source-projection-pending',
        ),
      ).toHaveLength(1)
      const quality = await service.pages<{ key: string; taskCount: string }>(pending.id, 'quality')
      expect(quality.find((q) => q.key === 'source-projection-pending')?.taskCount).toBe('1')
      expect(pending.content.summary.usageWindow?.partitions['in-window']).toMatchObject({
        records: '1',
        metrics: { state: 'ready', tokens: { total: '16' } },
      })
      await harness.db
        .update(taskExecutionObservationSources)
        .set({ pending: false })
        .where(eq(taskExecutionObservationSources.taskId, 'complete-original-task'))
        .run()
      const settled = await service.report(filters)
      expect(settled.content.summary.metrics).toMatchObject({
        state: 'ready',
        records: '1',
        tokens: { total: '16' },
        cost: { amount: '0.00005' },
      })
      // The repaired source removes its quality reason. The original page
      // contract rejects a reason with no sealed index instead of inventing
      // an empty Task population for that absent reason.
      const settledQuality = await service.pages<{ key: string }>(settled.id, 'quality')
      expect(settledQuality.filter((q) => q.key === 'source-projection-pending')).toHaveLength(0)
      await expect(
        service.pages(settled.id, 'quality-tasks', 'source-projection-pending'),
      ).rejects.toMatchObject({
        code: 'not-ready',
        message: 'Original quality Task index was not sealed',
      })
      await harness.db
        .insert(nodeRuns)
        .values({
          id: 'window-unobserved-original-attempt',
          taskId: 'complete-original-task',
          nodeId: completeFixtureId('node', 0),
          status: 'done',
          startedAt: COMPLETE_NOW + 11,
          finishedAt: COMPLETE_NOW + 15,
        })
        .run()
      const missingAttempt = await service.report(filters)
      expect(missingAttempt.content.summary.metrics).toMatchObject({
        state: 'not-ready',
        gaps: expect.arrayContaining(['invocation-unobserved']),
        recordedUsage: { records: '1', tokens: { total: '16' } },
        recordedCost: { amount: '0.00005' },
      })
      expect(
        await service.pages(missingAttempt.id, 'quality-tasks', 'invocation-unobserved'),
      ).toHaveLength(1)
    }, 120_000)

    test('usage uses original step time for independent historical owners outside the window, absent owner clocks and absent step clocks', async () => {
      await seedCompleteTask(harness, 1, 1)
      const native = nativeArtifact()
      native.root('historical-old-owner')
      native.step('old-owner-step', 'historical-old-owner', 11, 2, 3, 5, COMPLETE_NOW + 10)
      native.root('historical-no-owner-clock')
      native.step(
        'no-owner-clock-step',
        'historical-no-owner-clock',
        13,
        3,
        7,
        9,
        COMPLETE_NOW + 20,
      )
      native.root('historical-no-step-clock')
      native.step('no-step-clock-step', 'historical-no-step-clock', 17, 4, 11, 13, null)
      await job(harness, 'historical-old-owner', 'historical-old-owner', null, COMPLETE_NOW - 5000)
      await job(
        harness,
        'historical-no-owner-clock',
        'historical-no-owner-clock',
        null,
        COMPLETE_NOW - 5000,
      )
      await job(
        harness,
        'historical-no-step-clock',
        'historical-no-step-clock',
        null,
        COMPLETE_NOW - 5000,
      )
      const lifecycle = await serviceFor(harness, native.path).report()
      expect(lifecycle.content.summary.metrics).toMatchObject({
        state: 'ready',
        tokens: { total: '16' },
        cost: { amount: '0.00005' },
      })
      const service = serviceFor(harness, native.path, undefined, 'historical-no-owner-clock')
      const window = await service.report({ ...range, cohort: 'usage' })
      expect(window.content.summary.metrics).toMatchObject({
        state: 'not-ready',
        recordedUsage: {
          tokens: { input: '24', cacheRead: '10', cacheWrite: '14', output: '9', total: '57' },
        },
      })
      expect(window.content.summary.usageWindow?.partitions['in-window'].records).toBe('2')
      const pool = await service.pages<CompleteObservationTimePartition>(
        window.id,
        'time-unassigned',
      )
      expect(pool).toHaveLength(2)
      expect(
        pool.find((p) => p.recordId === 'opencode:step:no-step-clock-step')?.metrics,
      ).toMatchObject({
        recordedUsage: {
          tokens: { input: '17', cacheRead: '11', cacheWrite: '13', output: '6', total: '47' },
        },
      })
      const trends = await service.pages<CompleteObservationTrend>(window.id, 'trends')
      expect(trends).toHaveLength(1)
      expect(trends[0]?.metrics).toMatchObject({ recordedUsage: { tokens: { total: '57' } } })
      const executions = await service.pages<CompleteHistoricalObservationExecution>(
        window.id,
        'historical-executions',
      )
      expect(
        executions.find((e) => e.execution.ownerId === 'historical-old-owner')?.metrics,
      ).toMatchObject({
        state: 'not-ready',
        recordedUsage: {
          records: '1',
          tokens: { input: '11', cacheRead: '3', cacheWrite: '5', output: '4', total: '23' },
        },
      })
      expect(
        executions.find((e) => e.execution.ownerId === 'historical-no-owner-clock')?.metrics,
      ).toMatchObject({
        state: 'not-ready',
        recordedUsage: {
          records: '1',
          tokens: { input: '13', cacheRead: '7', cacheWrite: '9', output: '5', total: '34' },
        },
      })
      const untimed = executions.find((e) => e.execution.ownerId === 'historical-no-step-clock')!
      expect(untimed.metrics).toMatchObject({
        state: 'not-ready',
        gaps: expect.arrayContaining(['usage-time-unassigned']),
        tokenCoverage: { records: '0' },
      })
      expect(untimed.metrics).not.toHaveProperty('recordedUsage')
      const filtered = await service.report({
        ...range,
        cohort: 'usage',
        q: 'Original complete task',
      })
      expect(filtered.content.summary.usageWindow?.partitions['in-window'].records).toBe('0')
      expect(
        await service.pages<CompleteObservationTimePartition>(filtered.id, 'time-unassigned'),
      ).toHaveLength(1)
    }, 120_000)

    test('historical execution rows keep only their uniquely attributed window records while shared native records remain single-counted', async () => {
      const from = COMPLETE_NOW + 10,
        to = COMPLETE_NOW + 20
      await seedCompleteTask(harness, 1, 1, (record) => ({
        ...record,
        measurement: {
          ...record.measurement,
          recordId: 'opencode:step:accepted-outside',
          occurredAt: COMPLETE_NOW,
        },
      }))
      const native = nativeArtifact()
      native.root('unique-window-history')
      native.step('unique-before', 'unique-window-history', 2, 1, 1, 1, from - 1)
      native.step('unique-inside', 'unique-window-history', 11, 2, 3, 5, from)
      native.step('unique-after', 'unique-window-history', 13, 3, 7, 9, to)
      native.step('unique-unknown', 'unique-window-history', 17, 4, 11, 13, null)
      await job(harness, 'unique-window-history', 'unique-window-history')
      native.root('shared-window-history')
      native.step('shared-inside', 'shared-window-history', 19, 6, 17, 23, from + 1)
      await job(harness, 'shared-window-owner-a', 'shared-window-history')
      await job(harness, 'shared-window-owner-b', 'shared-window-history')
      const service = serviceFor(harness, native.path),
        lifecycle = await service.report()
      const originalRows = await service.pages<CompleteHistoricalObservationExecution>(
        lifecycle.id,
        'historical-executions',
      )
      expect(
        originalRows.find((e) => e.execution.ownerId === 'unique-window-history')?.metrics,
      ).toMatchObject({ recordedUsage: { records: '4', tokens: { total: '111' } } })
      const window = await service.report({ from, to, timezone: 'UTC', cohort: 'usage' })
      expect(window.content.summary.metrics).toMatchObject({
        state: 'not-ready',
        tokenCoverage: {
          invocations: '0',
          historicalReferences: '3',
          observedHistoricalReferences: '3',
          records: '2',
        },
        recordedUsage: {
          tokens: { input: '30', cacheRead: '20', cacheWrite: '28', output: '12', total: '90' },
        },
      })
      const rows = await service.pages<CompleteHistoricalObservationExecution>(
        window.id,
        'historical-executions',
      )
      const unique = rows.find((e) => e.execution.ownerId === 'unique-window-history')!
      expect(unique.metrics).toMatchObject({
        state: 'not-ready',
        gaps: expect.arrayContaining(['historical-invocation-unobserved', 'usage-time-unassigned']),
        recordedUsage: {
          records: '1',
          tokens: { input: '11', cacheRead: '3', cacheWrite: '5', output: '4', total: '23' },
        },
      })
      for (const ownerId of ['shared-window-owner-a', 'shared-window-owner-b']) {
        const shared = rows.find((e) => e.execution.ownerId === ownerId)!
        expect(shared.metrics).toMatchObject({
          state: 'not-ready',
          tokenCoverage: { historicalReferences: '1', records: '0' },
        })
        expect(shared.metrics).not.toHaveProperty('recordedUsage')
      }
      const trends = await service.pages<CompleteObservationTrend>(window.id, 'trends')
      expect(trends).toHaveLength(1)
      expect(trends[0]!.metrics).toMatchObject({
        recordedUsage: { records: '2', tokens: { total: '90' } },
      })
      const pool = await service.pages<CompleteObservationTimePartition>(
        window.id,
        'time-unassigned',
      )
      expect(pool).toHaveLength(1)
      expect(pool[0]).toMatchObject({
        recordId: 'opencode:step:unique-unknown',
        metrics: { recordedUsage: { tokens: { total: '47' } } },
      })
      const parts = await service.pages<CompleteObservationTimePartition>(
        window.id,
        'time-partitions',
      )
      expect(parts).toHaveLength(6)
      expect(new Set(parts.map((p) => p.identity)).size).toBe(6)
    }, 120_000)

    test('historical Task and Intent protocol validation retains the saved values without a current runtime lookup', async () => {
      await seedCompleteTask(harness, 3, 1)
      await harness.db
        .update(nodeRuns)
        .set({ runtime: 'opencode' })
        .where(eq(nodeRuns.id, completeFixtureId('run', 0)))
        .run()
      await harness.db
        .update(nodeRuns)
        .set({ runtime: 'claude-code' })
        .where(eq(nodeRuns.id, completeFixtureId('run', 1)))
        .run()
      await harness.db
        .insert(intentSessions)
        .values({
          id: 'saved-protocol-intent',
          ownerUserId: actor.user.id,
          createdAt: COMPLETE_NOW,
          updatedAt: COMPLETE_NOW,
        })
        .run()
      await harness.db
        .insert(intentTurns)
        .values(
          ['opencode', 'claude-code', 'unregistered-protocol', null].map((runtime, n) => ({
            id: 'saved-protocol-turn-' + n,
            sessionId: 'saved-protocol-intent',
            seq: n + 1,
            role: 'agent' as const,
            kind: 'message' as const,
            runMetaJson: JSON.stringify({ runtime }),
            createdAt: COMPLETE_NOW,
          })),
        )
        .run()
      const queries = [
        createHistoricalTaskObservationFacts(harness.db),
        createHistoricalIntentObservationFacts(harness.db),
      ]
      for (const [n, query] of queries.entries()) {
        const owners = await all((after) =>
          query.owners({ limit: 2, ...(after === undefined ? {} : { after }) }),
        )
        expect(owners.map((owner) => owner.runtime?.protocol ?? null)).toEqual(
          n === 0 ? ['opencode', 'claude-code', null] : ['opencode', 'claude-code', null, null],
        )
        for (const owner of owners)
          if (owner.runtime)
            expect(owner.runtime).toEqual({
              registrationId: null,
              configurationRevision: null,
              protocol: owner.runtime.protocol,
              name: null,
            })
      }
    }, 120_000)
    test('all four owner populations and every attempt event continue beyond 200 without invented runtime/clock facts', async () => {
      await seedCompleteTask(harness, 211, 1)
      await harness.db
        .update(nodeRuns)
        .set({
          startedAt: null,
          finishedAt: null,
          agentOverrideId: 'original-borrowed-agent',
          agentOverrideName: 'Frozen borrowed Agent',
        })
        .where(eq(nodeRuns.id, completeFixtureId('run', 210)))
        .run()
      await harness.db
        .update(nodeRuns)
        .set({ agentOverrideName: 'Original name-only borrowed Agent' })
        .where(eq(nodeRuns.id, completeFixtureId('run', 209)))
        .run()
      await harness.db
        .update(tasks)
        .set({
          deletedAt: COMPLETE_NOW + 2,
          workflowSnapshot: JSON.stringify({
            nodes: Array.from({ length: 211 }, (_, n) => ({
              id: completeFixtureId('node', n),
              kind: 'agent-single',
              agentId: 'original-template-agent',
              agentName: 'Frozen template Agent',
            })),
          }),
        })
        .where(eq(tasks.id, 'complete-original-task'))
        .run()
      for (let offset = 0; offset < 211; offset += 40) {
        const numbers = Array.from({ length: Math.min(40, 211 - offset) }, (_, i) => offset + i)
        await harness.db
          .insert(memoryDistillJobs)
          .values(
            numbers.map((n) => ({
              id: completeFixtureId('legacy-memory', n),
              debounceKey: 'memory-' + n,
              sourceKind: ['clarify', 'review', 'feedback', 'agent-run', 'task-run'][n % 5] as
                | 'clarify'
                | 'review'
                | 'feedback'
                | 'agent-run'
                | 'task-run',
              sourceEventId: 'event-' + n,
              taskId: null,
              scopeResolvedJson: '[]',
              status: 'done' as const,
              attempts: 1,
              nextRunAt: COMPLETE_NOW,
              createdAt: COMPLETE_NOW,
              opencodeSessionId: 'root-' + n,
            })),
          )
          .run()
        await harness.db
          .insert(memoryDistillEvents)
          .values(
            numbers.map((n) => ({
              distillJobId: completeFixtureId('legacy-memory', 0),
              attemptIndex: n % 2,
              sessionId: 'root-' + n,
              parentSessionId: null,
              ts: COMPLETE_NOW + n,
              kind: 'step_finish',
              payload: JSON.stringify({ part: { type: 'step-finish', id: 'step-' + n } }),
            })),
          )
          .run()
      }
      await harness.db
        .insert(intentSessions)
        .values({
          id: 'original-intent',
          ownerUserId: actor.user.id,
          createdAt: COMPLETE_NOW,
          updatedAt: COMPLETE_NOW,
        })
        .run()
      await harness.db
        .insert(mcps)
        .values({
          id: 'original-mcp',
          name: 'original',
          type: 'remote',
          config: '{}',
          enabled: true,
          ownerUserId: actor.user.id,
          createdAt: COMPLETE_NOW,
          updatedAt: COMPLETE_NOW,
        })
        .run()
      await harness.db
        .insert(mcpRuntimeTestSessions)
        .values({
          id: 'original-mcp-session',
          mcpId: 'original-mcp',
          ownerUserId: actor.user.id,
          clientCreateId: 'original-create',
          clientCreateDigest: '1'.repeat(64),
          status: 'active',
          mcpConfigHash: '2'.repeat(64),
          runtimeRowId: 'original-installation',
          runtimeName: 'Frozen original runtime',
          runtimeProtocol: 'opencode',
          runtimeSnapshotJson: '{}',
          runtimeBinaryPath: '/original/opencode',
          runtimeSessionId: 'original-mcp-root',
          nativeSessionState: 'ready',
          turnSeq: 211,
          sessionVersion: 1,
          idleDeadlineAt: COMPLETE_NOW + 600_000,
          scratchRoot: '/original/mcp',
          createdAt: COMPLETE_NOW,
          updatedAt: COMPLETE_NOW,
        })
        .run()
      for (let offset = 0; offset < 211; offset += 40) {
        const numbers = Array.from({ length: Math.min(40, 211 - offset) }, (_, i) => offset + i)
        await harness.db
          .insert(intentTurns)
          .values(
            numbers.map((n) => ({
              id: completeFixtureId('original-intent-agent', n),
              sessionId: 'original-intent',
              seq: n + 1,
              role: 'agent' as const,
              kind: 'changeset' as const,
              createdAt: COMPLETE_NOW,
              runMetaJson: JSON.stringify({ runtime: 'opencode', durationMs: 100 }),
              captureRootSessionId: 'intent-root-' + n,
            })),
          )
          .run()
        await harness.db
          .insert(intentTurnEvents)
          .values(
            numbers.map((n) => ({
              turnId: completeFixtureId('original-intent-agent', 0),
              eventSeq: n + 1,
              ts: COMPLETE_NOW + n,
              kind: 'step_finish',
              payload: JSON.stringify({ part: { type: 'step-finish', id: 'intent-step-' + n } }),
              sessionId: 'intent-root-' + n,
              source: 'stream' as const,
            })),
          )
          .run()
        await harness.db
          .insert(mcpRuntimeTestTurns)
          .values(
            numbers.map((n) => ({
              id: completeFixtureId('original-mcp-turn', n),
              sessionId: 'original-mcp-session',
              seq: n + 1,
              clientMessageId: 'original-message-' + n,
              promptText: 'original',
              status: 'succeeded' as const,
              hardDeadlineAt: COMPLETE_NOW + 60_000,
              captureState: 'complete' as const,
              createdAt: COMPLETE_NOW,
              startedAt: COMPLETE_NOW + 1,
              finishedAt: COMPLETE_NOW + 2,
            })),
          )
          .run()
        await harness.db
          .insert(mcpRuntimeTestEvents)
          .values(
            numbers.map((n) => ({
              testSessionId: 'original-mcp-session',
              firstSeenTurnId: completeFixtureId('original-mcp-turn', 0),
              eventSeq: n + 1,
              ts: COMPLETE_NOW + n,
              kind: 'step_finish',
              payload: JSON.stringify({ part: { type: 'step-finish', id: 'mcp-step-' + n } }),
              sessionId: 'original-mcp-root',
              source: 'stream' as const,
            })),
          )
          .run()
      }
      await harness.db
        .insert(intentTurns)
        .values({
          id: 'original-user-turn',
          sessionId: 'original-intent',
          seq: 212,
          role: 'user',
          kind: 'message',
          createdAt: COMPLETE_NOW,
        })
        .run()
      const queries = [
        createHistoricalTaskObservationFacts(harness.db),
        createHistoricalMemoryObservationFacts(harness.db),
        createHistoricalIntentObservationFacts(harness.db),
        createHistoricalMcpObservationFacts(harness.db),
      ]
      for (const query of queries) {
        const owners = await all((after) =>
          query.owners({ limit: 100, ...(after === undefined ? {} : { after }) }),
        )
        expect(owners).toHaveLength(211)
        expect(new Set(owners.map((owner) => owner.referenceId)).size).toBe(211)
        expect(owners.every((owner) => owner.kind === 'historical-observed')).toBe(true)
      }
      for (const [query, id] of [
        [queries[1]!, completeFixtureId('legacy-memory', 0)],
        [queries[2]!, completeFixtureId('original-intent-agent', 0)],
        [queries[3]!, completeFixtureId('original-mcp-turn', 0)],
      ] as const) {
        const events = await all((after) =>
          query.events(id, { limit: 100, ...(after === undefined ? {} : { after }) }),
        )
        expect(events).toHaveLength(211)
        expect(new Set(events.map((event) => event.id)).size).toBe(211)
        expect(events.every((event) => event.stepId !== null)).toBe(true)
      }
      const node = await queries[0]!.owners({ after: completeFixtureId('run', 209), limit: 1 })
      expect(node.items[0]).toMatchObject({
        createdAt: null,
        startedAt: null,
        finishedAt: null,
        runtime: null,
        agentId: 'original-borrowed-agent',
        agentName: 'Frozen borrowed Agent',
        agentRevision: null,
      })
      const nameOnly = await queries[0]!.owners({
        after: completeFixtureId('run', 208),
        limit: 1,
      })
      expect(nameOnly.items[0]).toMatchObject({
        agentId: null,
        agentName: 'Original name-only borrowed Agent',
        agentRevision: null,
      })
      expect((await queries[0]!.owners({ limit: 1 })).items[0]).toMatchObject({
        agentId: 'original-template-agent',
        agentName: 'Frozen template Agent',
      })
      const turn = (await queries[2]!.owners({ limit: 1 })).items[0]!
      expect(turn).toMatchObject({
        createdAt: COMPLETE_NOW,
        startedAt: null,
        finishedAt: null,
        runtime: {
          registrationId: null,
          configurationRevision: null,
          protocol: 'opencode',
          name: null,
        },
      })
      const mcp = (await queries[3]!.owners({ limit: 1 })).items[0]!
      expect(mcp.runtime).toEqual({
        registrationId: 'original-installation',
        configurationRevision: null,
        protocol: 'opencode',
        name: 'Frozen original runtime',
      })
    }, 120_000)

    test('selected Task status retains every differently-stated historical child and the exact Task detail cohort', async () => {
      await seedCompleteTask(harness, 1, 1)
      await harness.db
        .update(nodeRuns)
        .set({ status: 'failed' })
        .where(eq(nodeRuns.id, completeFixtureId('run', 0)))
        .run()
      const native = nativeArtifact()
      native.root('failed-memory-root')
      native.step('failed-memory-step', 'failed-memory-root', 30, 7, 2, 1)
      await job(harness, 'failed-memory-child', 'failed-memory-root', 'complete-original-task')
      await harness.db
        .update(memoryDistillJobs)
        .set({ status: 'failed' })
        .where(eq(memoryDistillJobs.id, 'failed-memory-child'))
        .run()
      const service = serviceFor(harness, native.path)
      for (const built of [
        await service.report({ ...range, status: 'done' }),
        await service.report(range, 'complete-original-task'),
      ]) {
        expect(built.content.summary.inventory.tasks).toBe('1')
        expect(built.content.summary.metrics).toMatchObject({
          recordedUsage: {
            tokens: { input: '31', cacheRead: '5', cacheWrite: '6', output: '16', total: '58' },
          },
          recordedCost: { currency: 'CNY', amount: '0.00005' },
        })
        const executions = await service.pages<CompleteHistoricalObservationExecution>(
          built.id,
          'historical-executions',
        )
        expect(executions).toHaveLength(2)
        expect(executions.every((row) => row.scopeMatch === 'matched')).toBe(true)
        expect(executions.every((row) => row.execution.status === 'failed')).toBe(true)
        expect(executions.every((row) => row.timeBasis === 'task-cohort')).toBe(true)
        const records = await service.pages<CompleteHistoricalObservationRecord>(
          built.id,
          'historical-records',
        )
        expect(records).toHaveLength(1)
        expect(records[0]).toMatchObject({
          includedInTotals: true,
          scopeMatch: 'matched',
          originalUsage: { input: '30', cacheRead: '2', cacheWrite: '1', output: '9' },
        })
      }
    }, 120_000)

    test('two original memory attempts retain partial four buckets, the current frozen CNY, and truthful unknown retry clocks', async () => {
      await seedCompleteTask(harness, 1, 1)
      const native = nativeArtifact()
      native.root('first-root')
      native.root('second-root')
      native.step('first-step', 'first-root', 100, null, 5, 0)
      native.step('second-step', 'second-root', 200, 10, 6, 7)
      await job(harness, 'original-memory', 'second-root', 'complete-original-task')
      await harness.db
        .insert(memoryDistillEvents)
        .values([
          {
            distillJobId: 'original-memory',
            attemptIndex: 0,
            sessionId: 'first-root',
            ts: COMPLETE_NOW + 1,
            kind: 'step_finish',
            payload: JSON.stringify({ part: { type: 'step-finish', id: 'first-step' } }),
          },
          {
            distillJobId: 'original-memory',
            attemptIndex: 1,
            sessionId: 'second-root',
            ts: COMPLETE_NOW + 2,
            kind: 'step_finish',
            payload: JSON.stringify({ part: { type: 'step-finish', id: 'second-step' } }),
          },
        ])
        .run()
      const service = serviceFor(harness, native.path),
        built = await service.report()
      expect(built.original.state).toBe('not-ready')
      expect(built.content.summary.inventory).toMatchObject({
        tasks: '1',
        attempts: '1',
        invocations: '1',
        historicalReferences: '2',
      })
      expect(built.content.summary.metrics).toMatchObject({
        state: 'not-ready',
        recordedUsage: {
          tokens: { input: '301', cacheRead: '14', cacheWrite: '12', output: '19', total: '346' },
        },
        tokenCoverage: {
          invocations: '1',
          historicalReferences: '2',
          observedHistoricalReferences: '2',
          records: '3',
          bucketRecords: { input: '3', cacheRead: '3', cacheWrite: '3', output: '2' },
        },
        recordedCost: { currency: 'CNY', amount: '0.00005', records: '3', pricedRecords: '1' },
      })
      const executions = await service.pages<CompleteHistoricalObservationExecution>(
        built.id,
        'historical-executions',
      )
      const attempts = executions.filter((row) => row.execution.sourceKind === 'memory-distill')
      expect(attempts.map((row) => row.execution.attemptId).sort()).toEqual(['0', '1'])
      expect(
        attempts.every(
          (row) =>
            row.referenceRole === 'execution' &&
            row.execution.startedAt === null &&
            row.execution.finishedAt === null &&
            row.timeBasis === 'task-cohort',
        ),
      ).toBe(true)
      expect(attempts.every((row) => row.parentTaskName === 'Original complete task')).toBe(true)
      const records = await service.pages<CompleteHistoricalObservationRecord>(
        built.id,
        'historical-records',
      )
      expect(records).toHaveLength(2)
      expect(
        records.every(
          (row) =>
            row.includedInTotals && !row.coveredByAcceptedRecords && row.scopeMatch === 'matched',
        ),
      ).toBe(true)
      const trends = await service.pages<CompleteObservationTrend>(built.id, 'trends')
      expect(trends).toHaveLength(1)
      expect(trends[0]!.metrics).toEqual(built.content.summary.metrics)
      const before = await service.cache.get(built.id)
      const selected = await service.report({
        ...range,
        selection: JSON.stringify({ purpose: 'memory' }),
      })
      expect(selected.content.summary.metrics).toMatchObject({
        state: 'not-ready',
        tokenCoverage: {
          invocations: '0',
          historicalReferences: '2',
          observedHistoricalReferences: '2',
        },
        recordedUsage: {
          tokens: { input: '300', cacheRead: '11', cacheWrite: '7', output: '12', total: '330' },
        },
      })
      expect('recordedCost' in selected.content.summary.metrics).toBe(false)
      expect(await service.cache.get(built.id)).toEqual(before)
      const selectedTask = await service.pages<CompleteObservationTask>(selected.id, 'tasks')
      expect(selectedTask).toHaveLength(1)
      expect<string | null>(selected.content.summary.timing.wallMs).toBe(
        selectedTask[0]!.timing.wallMs,
      )
    }, 120_000)

    test('one original native part shared by two owners is counted once globally, retaining every owner across range filters', async () => {
      await seedCompleteTask(harness, 1, 1)
      const native = nativeArtifact()
      native.root('shared-root')
      native.root('shared-child', 'shared-root')
      native.step('shared-step', 'shared-child', 30, 4, 5, 6)
      await job(harness, 'inside-original', 'shared-root')
      await job(harness, 'outside-original', 'shared-child', null, COMPLETE_NOW - 100_000)
      const service = serviceFor(harness, native.path),
        mixed = await service.report()
      const records = await service.pages<CompleteHistoricalObservationRecord>(
        mixed.id,
        'historical-records',
      )
      expect(records).toHaveLength(1)
      expect(records[0]).toMatchObject({
        candidateCount: '2',
        scopeMatch: 'unresolved',
        includedInTotals: false,
        originalUsage: { input: '30', cacheRead: '5', cacheWrite: '6', output: '6' },
      })
      expect(mixed.content.summary.metrics).toMatchObject({
        recordedUsage: {
          tokens: { input: '1', cacheRead: '3', cacheWrite: '5', output: '7', total: '16' },
        },
      })
      const originalRefs = await service.pages<CompleteHistoricalObservationReference>(
        mixed.id,
        'historical-record-references',
        JSON.stringify([records[0]!.nativeSource, records[0]!.recordId]),
      )
      expect(originalRefs).toHaveLength(2)
      expect(originalRefs.map((row) => row.scopeMatch).sort()).toEqual(['excluded', 'matched'])
      const wide = await service.report({ ...range, from: COMPLETE_NOW - 200_000 })
      expect(wide.content.summary.metrics).toMatchObject({
        tokenCoverage: {
          historicalReferences: '2',
          observedHistoricalReferences: '2',
          records: '2',
        },
        recordedUsage: {
          tokens: { input: '31', cacheRead: '8', cacheWrite: '11', output: '13', total: '63' },
        },
      })
      const wideRecords = await service.pages<CompleteHistoricalObservationRecord>(
        wide.id,
        'historical-records',
      )
      expect(wideRecords).toHaveLength(1)
      expect(wideRecords[0]).toMatchObject({
        candidateCount: '2',
        scopeMatch: 'matched',
        includedInTotals: true,
        issues: [],
      })
      const excluded = await service.report({
        ...range,
        from: COMPLETE_NOW + 30_000,
        to: COMPLETE_NOW + 40_000,
      })
      expect(await service.pages(excluded.id, 'historical-records')).toHaveLength(0)
      expect(excluded.content.summary.metrics).toEqual({ state: 'not-applicable' })
    }, 120_000)

    test('211 native parts and a 211-deep child chain retain actual EOF; missing roots remain visible without guessed zeroes', async () => {
      await seedCompleteTask(harness, 1, 1)
      const native = nativeArtifact()
      native.root('deep-root')
      for (let n = 0; n < 211; n++) {
        const id = completeFixtureId('deep-child', n)
        native.root(id, n === 0 ? 'deep-root' : completeFixtureId('deep-child', n - 1))
        native.step(completeFixtureId('deep-part', n), id, 1, 2, 3, 4)
      }
      await job(harness, 'deep-memory', 'deep-root')
      await job(harness, 'missing-memory', null)
      const service = serviceFor(harness, native.path),
        built = await service.report()
      expect(built.content.summary.inventory).toMatchObject({
        tasks: '1',
        invocations: '1',
        historicalReferences: '2',
      })
      expect(built.content.summary.metrics).toMatchObject({
        recordedUsage: {
          tokens: {
            input: '212',
            cacheRead: '636',
            cacheWrite: '849',
            output: '851',
            total: '2548',
          },
        },
        tokenCoverage: {
          records: '212',
          historicalReferences: '2',
          observedHistoricalReferences: '1',
        },
      })
      const records = await service.pages<CompleteHistoricalObservationRecord>(
        built.id,
        'historical-records',
      )
      expect(records).toHaveLength(211)
      expect(new Set(records.map((row) => row.recordId)).size).toBe(211)
      expect(records.every((row) => row.includedInTotals)).toBe(true)
      const executions = await service.pages<CompleteHistoricalObservationExecution>(
        built.id,
        'historical-executions',
      )
      const missing = executions.find((row) => row.execution.ownerId === 'missing-memory')!
      expect(missing.metrics).toMatchObject({
        state: 'not-ready',
        tokenCoverage: {
          records: '0',
          historicalReferences: '1',
          observedHistoricalReferences: '0',
        },
      })
      expect(missing.issues).toContain('historical-native-unobserved')
      expect('recordedUsage' in missing.metrics).toBe(false)
      const nativeQuery = createHistoricalNativeUsageQuery({ OPENCODE_DB: native.path })
      const reader = (await nativeQuery.open({
        referenceId: 'original-deep-proof',
        rootSessionId: 'deep-root',
      }))!
      try {
        let cursor = reader.initialCursor,
          pages = 0,
          steps = 0,
          sessions = 0
        for (;;) {
          const page = reader.next(cursor)
          pages++
          steps += page.steps.length
          sessions += page.sessions.length
          reader.acknowledge(page.ordinal, page.payloadDigest)
          if (page.nextCursor === null) {
            expect(page.eof?.counts).toEqual({ sessions: '212', parts: '211', steps: '211' })
            break
          }
          cursor = page.nextCursor
        }
        expect(pages).toBeGreaterThan(1)
        expect(steps).toBe(211)
        expect(sessions).toBe(212)
      } finally {
        reader.close()
      }
    }, 120_000)

    test('the exact same native part already admitted by Task keeps its frozen CNY and is never charged again', async () => {
      const native = nativeArtifact()
      native.root('accepted-native-root')
      native.step('accepted-native-part', 'accepted-native-root', 1, 5, 3, 5)
      await seedCompleteTask(harness, 1, 1, (record) => ({
        ...record,
        measurement: { ...record.measurement, recordId: 'opencode:step:accepted-native-part' },
      }))
      const source = sha256Hex(JSON.stringify(['opencode-native-db', native.path]))
      const accepted = (await harness.db
        .select()
        .from(observationInvocations)
        .where(eq(observationInvocations.id, completeFixtureId('invocation', 0)))
        .get())!
      const document = { ...JSON.parse(accepted.document), nativeCaptureSource: source }
      await harness.db
        .update(observationInvocations)
        .set({ document: JSON.stringify(document), fingerprint: JSON.stringify(document) })
        .where(eq(observationInvocations.id, accepted.id))
        .run()
      const capture = (await harness.db
        .select()
        .from(observationUsageCaptures)
        .where(eq(observationUsageCaptures.invocationId, accepted.id))
        .get())!
      const captureDocument = JSON.parse(capture.document)
      captureDocument.evidence.capture.nativeSource = source
      captureDocument.evidence.capture.rootSessionId = 'accepted-native-root'
      await harness.db
        .update(observationUsageCaptures)
        .set({
          document: JSON.stringify(captureDocument),
          summary: JSON.stringify(captureDocument),
        })
        .where(eq(observationUsageCaptures.invocationId, accepted.id))
        .run()
      await job(harness, 'accepted-overlap', 'accepted-native-root', 'complete-original-task')
      const service = serviceFor(harness, native.path),
        built = await service.report()
      expect(built.content.summary.inventory.historicalReferences).toBeUndefined()
      expect(built.content.summary.metrics).toMatchObject({
        state: 'ready',
        records: '1',
        tokens: { input: '1', cacheRead: '3', cacheWrite: '5', output: '7', total: '16' },
        cost: { currency: 'CNY', state: 'complete', amount: '0.00005' },
      })
      const records = await service.pages<CompleteHistoricalObservationRecord>(
        built.id,
        'historical-records',
      )
      expect(records).toHaveLength(1)
      expect(records[0]).toMatchObject({
        coveredByAcceptedRecords: true,
        includedInTotals: false,
        scopeMatch: 'matched',
        issues: [],
      })
    }, 120_000)

    test('usage matches a missing accepted clock to frozen native versions, retaining accepted deduplication and original CNY', async () => {
      const native = nativeArtifact()
      native.root('window-accepted-root')
      native.step('window-accepted-part', 'window-accepted-root', 1, 5, 3, 5)
      await seedCompleteTask(harness, 1, 1, (record) => ({
        ...record,
        measurement: {
          ...record.measurement,
          recordId: 'opencode:step:window-accepted-part',
          occurredAt: null,
        },
      }))
      const source = sha256Hex(JSON.stringify(['opencode-native-db', native.path]))
      const accepted = (await harness.db
        .select()
        .from(observationInvocations)
        .where(eq(observationInvocations.id, completeFixtureId('invocation', 0)))
        .get())!
      const document = { ...JSON.parse(accepted.document), nativeCaptureSource: source }
      await harness.db
        .update(observationInvocations)
        .set({ document: JSON.stringify(document), fingerprint: JSON.stringify(document) })
        .where(eq(observationInvocations.id, accepted.id))
        .run()
      const capture = (await harness.db
        .select()
        .from(observationUsageCaptures)
        .where(eq(observationUsageCaptures.invocationId, accepted.id))
        .get())!
      const captureDocument = JSON.parse(capture.document)
      captureDocument.evidence.capture.nativeSource = source
      captureDocument.evidence.capture.rootSessionId = 'window-accepted-root'
      await harness.db
        .update(observationUsageCaptures)
        .set({
          document: JSON.stringify(captureDocument),
          summary: JSON.stringify(captureDocument),
        })
        .where(eq(observationUsageCaptures.invocationId, accepted.id))
        .run()
      await job(
        harness,
        'window-accepted-overlap',
        'window-accepted-root',
        'complete-original-task',
      )
      const service = serviceFor(harness, native.path),
        lifecycle = await service.report(),
        window = await service.report({ ...range, cohort: 'usage' })
      expect(window.content.summary.metrics).toEqual(lifecycle.content.summary.metrics)
      expect(window.content.summary.metrics).toMatchObject({
        state: 'ready',
        records: '1',
        tokens: { input: '1', cacheRead: '3', cacheWrite: '5', output: '7', total: '16' },
        cost: { currency: 'CNY', state: 'complete', amount: '0.00005' },
      })
      expect(window.content.summary.inventory.historicalReferences).toBeUndefined()
      expect(window.content.summary.usageWindow?.partitions['in-window'].records).toBe('1')
      expect(window.content.summary.usageWindow?.partitions['unassigned-time'].records).toBe('0')
      const partitions = await service.pages<CompleteObservationTimePartition>(
        window.id,
        'time-partitions',
      )
      expect(partitions).toHaveLength(1)
      expect(partitions[0]).toMatchObject({
        kind: 'accepted',
        recordId: 'opencode:step:window-accepted-part',
        partition: 'in-window',
        occurrence: { occurredAt: COMPLETE_NOW + 1, basis: 'native-step' },
      })
      expect(await service.pages(window.id, 'time-unassigned')).toEqual([])
    }, 120_000)

    test('actual native part changes between two original root snapshots retain both versions and do not overwrite known totals', async () => {
      await seedCompleteTask(harness, 1, 1)
      const native = nativeArtifact()
      native.root('changing-parent')
      native.root('changing-child', 'changing-parent')
      native.step('changing-step', 'changing-child', 30, 4, 5, 6)
      await job(harness, 'changing-owner-1', 'changing-parent')
      await job(harness, 'changing-owner-2', 'changing-child')
      let reads = 0
      const service = serviceFor(harness, native.path, () => {
        if (++reads === 2) native.changeInput('changing-step', 90)
      })
      const built = await service.report()
      expect(built.content.summary.metrics).toMatchObject({
        recordedUsage: {
          tokens: { input: '1', cacheRead: '3', cacheWrite: '5', output: '7', total: '16' },
        },
        recordedCost: { currency: 'CNY', amount: '0.00005' },
      })
      const records = await service.pages<CompleteHistoricalObservationRecord>(
        built.id,
        'historical-records',
      )
      expect(records).toHaveLength(1)
      expect(records[0]).toMatchObject({ includedInTotals: false, scopeMatch: 'matched' })
      expect(records[0]!.issues).toContain('historical-native-record-conflict')
      const versions = await service.pages<CompleteHistoricalObservationRecord>(
        built.id,
        'historical-record-versions',
        JSON.stringify([records[0]!.nativeSource, records[0]!.recordId]),
      )
      expect(versions.map((row) => row.originalUsage.input).sort()).toEqual(['30', '90'])
      expect(versions.every((row) => !row.includedInTotals)).toBe(true)
    }, 120_000)
  },
)

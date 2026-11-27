// RFC-616 §5.3 / §5.4 / §9 / §10 — the persistence of process metrics on both
// providers: recorded human operations (with the session-merge rule), the
// text-theme analysis queue, and the three read-only usage reads added to the
// call store.
//
// Why this file exists: the session rule decides how many rows a polling page
// writes (one every 30 minutes, moved at most once a minute — not one per
// request), and the usage reads are what makes a task's tokens on the process
// metrics page equal the number on the run observation page.
import { expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { PROCESS_OPERATION_SESSION_MS, PROCESS_OPERATION_TOUCH_MS } from '@agent-workflow/shared'
import { createOperationRecorder } from '@/modules/run-observability/application/process/operationObservations'
import {
  INSIGHT_KEEP,
  type InsightScope,
  type InsightSubject,
} from '@/modules/run-observability/application/process/ports/insightStore'
import { composeRunObservationCalls } from '@/modules/run-observability/composition/runObservation'
import { createCallPersistence } from '@/modules/run-observability/infrastructure/callPersistence'
import { createInsightPersistence } from '@/modules/run-observability/infrastructure/insightPersistence'
import { createOperationPersistence } from '@/modules/run-observability/infrastructure/operationPersistence'
import type { CallObservationStart } from '@/modules/run-observability/public/participants'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { describeEachProvider } from './helpers/eachProvider'

const MIN = 60_000
const T0 = Date.UTC(2026, 10, 1)

async function operationRows(db: PersistenceDb) {
  const { observationOperations } = tablesOf(db)
  const rows = await db.select().from(observationOperations)
  return rows
    .map((row) => ({
      action: row.action,
      subjectKind: row.subjectKind,
      subjectId: row.subjectId,
      actorUserId: row.actorUserId,
      transport: row.transport,
      firstAt: Number(row.firstAt),
      lastAt: Number(row.lastAt),
    }))
    .sort((a, b) => a.firstAt - b.firstAt || a.action.localeCompare(b.action))
}

const view = {
  action: 'review.view',
  subjectKind: 'node-run',
  subjectId: 'run-1',
  mode: 'session',
  actorUserId: 'alice',
  transport: 'http',
} as const

describeEachProvider('RFC-616 operation recording', (harness) => {
  test('an `each` operation is one row per call', async () => {
    const recorder = createOperationRecorder({ store: createOperationPersistence(harness.db) })
    const retry = {
      action: 'task.retry-node',
      subjectKind: 'task',
      subjectId: 'task-1',
      mode: 'each',
      actorUserId: 'alice',
    } as const
    await recorder.record({ ...retry, transport: 'http', at: T0 })
    await recorder.record({ ...retry, transport: 'mcp', at: T0 + 1 })
    expect(await operationRows(harness.db)).toEqual([
      {
        action: 'task.retry-node',
        subjectKind: 'task',
        subjectId: 'task-1',
        actorUserId: 'alice',
        transport: 'http',
        firstAt: T0,
        lastAt: T0,
      },
      {
        action: 'task.retry-node',
        subjectKind: 'task',
        subjectId: 'task-1',
        actorUserId: 'alice',
        transport: 'mcp',
        firstAt: T0 + 1,
        lastAt: T0 + 1,
      },
    ])
  })

  test('a polled `session` operation is one row that moves at most once a minute', async () => {
    const recorder = createOperationRecorder({ store: createOperationPersistence(harness.db) })
    // A page polling every 8 seconds for five minutes.
    for (let at = T0; at <= T0 + 5 * MIN; at += 8_000) await recorder.record({ ...view, at })
    const rows = await operationRows(harness.db)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ firstAt: T0 })
    expect(rows[0]!.lastAt).toBeGreaterThan(T0 + 4 * MIN)
    expect(rows[0]!.lastAt).toBeLessThanOrEqual(T0 + 5 * MIN)

    // Within a minute of the last move nothing is written.
    const before = rows[0]!.lastAt
    await recorder.record({ ...view, at: before + PROCESS_OPERATION_TOUCH_MS - 1 })
    expect((await operationRows(harness.db))[0]!.lastAt).toBe(before)
    await recorder.record({ ...view, at: before + PROCESS_OPERATION_TOUCH_MS })
    expect((await operationRows(harness.db))[0]!.lastAt).toBe(before + PROCESS_OPERATION_TOUCH_MS)
  })

  test('coming back after more than thirty minutes starts a new session', async () => {
    const recorder = createOperationRecorder({ store: createOperationPersistence(harness.db) })
    await recorder.record({ ...view, at: T0 })
    await recorder.record({ ...view, at: T0 + PROCESS_OPERATION_SESSION_MS })
    expect(await operationRows(harness.db)).toHaveLength(1)
    const last = T0 + PROCESS_OPERATION_SESSION_MS
    await recorder.record({ ...view, at: last + PROCESS_OPERATION_SESSION_MS + 1 })
    const rows = await operationRows(harness.db)
    expect(rows.map((row) => [row.firstAt, row.lastAt])).toEqual([
      [T0, last],
      [last + PROCESS_OPERATION_SESSION_MS + 1, last + PROCESS_OPERATION_SESSION_MS + 1],
    ])
  })

  test('sessions are per person, subject and action; another instance continues a session', async () => {
    const store = createOperationPersistence(harness.db)
    const recorder = createOperationRecorder({ store })
    await recorder.record({ ...view, at: T0 })
    await recorder.record({ ...view, actorUserId: 'bob', at: T0 + 1 })
    await recorder.record({ ...view, subjectId: 'run-2', at: T0 + 2 })
    await recorder.record({ ...view, action: 'clarify.view', at: T0 + 3 })
    expect(await operationRows(harness.db)).toHaveLength(4)

    // A second daemon instance has no memory of the session: it finds the row and moves it.
    const other = createOperationRecorder({ store })
    await other.record({ ...view, at: T0 + 2 * MIN })
    const rows = await operationRows(harness.db)
    expect(rows).toHaveLength(4)
    expect(
      rows.find(
        (row) =>
          row.actorUserId === 'alice' && row.subjectId === 'run-1' && row.action === 'review.view',
      ),
    ).toMatchObject({
      firstAt: T0,
      lastAt: T0 + 2 * MIN,
    })
  })

  test('nothing is written while the database is not open for writes', async () => {
    let writable = false
    const recorder = createOperationRecorder({
      store: createOperationPersistence(harness.db),
      writable: () => writable,
    })
    await recorder.record({ ...view, at: T0 })
    await recorder.record({ ...view, mode: 'each', action: 'review.comment', at: T0 })
    expect(await operationRows(harness.db)).toEqual([])
    writable = true
    await recorder.record({ ...view, at: T0 + 1 })
    expect(await operationRows(harness.db)).toHaveLength(1)
  })

  test('operations are read back by subject, optionally by action', async () => {
    const store = createOperationPersistence(harness.db)
    const recorder = createOperationRecorder({ store })
    await recorder.record({ ...view, at: T0 })
    await recorder.record({ ...view, action: 'clarify.view', subjectId: 'run-2', at: T0 + 1 })
    await recorder.record({
      action: 'task.resume',
      subjectKind: 'task',
      subjectId: 'run-1',
      mode: 'each',
      actorUserId: 'bob',
      transport: 'http',
      at: T0 + 2,
    })
    const runs = await store.bySubjects('node-run', ['run-1', 'run-2', 'run-3', 'run-1'])
    expect(runs.map((row) => `${row.action}@${row.subjectId}`).sort()).toEqual([
      'clarify.view@run-2',
      'review.view@run-1',
    ])
    expect(await store.bySubjects('node-run', ['run-1', 'run-2'], ['clarify.view'])).toEqual([
      {
        action: 'clarify.view',
        subjectKind: 'node-run',
        subjectId: 'run-2',
        actorUserId: 'alice',
        firstAt: T0 + 1,
        lastAt: T0 + 1,
      },
    ])
    // The same id as a task is a different subject.
    expect((await store.bySubjects('task', ['run-1'])).map((row) => row.action)).toEqual([
      'task.resume',
    ])
    expect(await store.bySubjects('task', [])).toEqual([])
    expect(await store.bySubjects('task', ['run-1'], [])).toEqual([])
    await expect(
      store.bySubjects(
        'task',
        Array.from({ length: 501 }, (_, index) => `t${index}`),
      ),
    ).rejects.toThrow(RangeError)
  })
})

const subject: InsightSubject = { kind: 'workflow', id: 'wf-1', name: 'Requirement to merge' }
const everyone: InsightScope = { kind: 'all' }
const alice: InsightScope = { kind: 'user', userId: 'alice' }

function entry(
  id: string,
  createdAt: number,
  over: { subject?: InsightSubject; scope?: InsightScope; trigger?: 'manual' | 'scheduled' } = {},
) {
  return {
    id,
    subject: over.subject ?? subject,
    scope: over.scope ?? everyone,
    windowFrom: T0 - 30 * 86_400_000,
    windowTo: T0,
    trigger: over.trigger ?? ('manual' as const),
    requestedBy: over.trigger === 'scheduled' ? null : 'alice',
    createdAt,
  }
}

const result = {
  groups: [
    {
      source: 'review' as const,
      items: 3,
      truncated: false,
      otherItems: 1,
      themes: [
        {
          name: 'Edge cases',
          items: 2,
          share: 2 / 3,
          stages: ['design'],
          quotes: [{ text: 'idempotency key missing', unitId: 'task-1' }],
          advice: 'Add a template.',
        },
      ],
    },
  ],
  stageLabels: { design: 'Design' },
}
const input = { sources: [{ source: 'review', items: 3, truncated: false }], newestAt: T0 - 5 }

describeEachProvider('RFC-616 insight analyses', (harness) => {
  test('the queue is claimed oldest first, one claimer per analysis', async () => {
    const store = createInsightPersistence(harness.db)
    expect(await store.claimNext(T0)).toBeNull()
    await store.insert(entry('a-2', T0 + 2))
    await store.insert(entry('a-1', T0 + 1))
    expect(await store.active(subject, everyone)).toMatchObject({ id: 'a-2', status: 'pending' })

    const first = await store.claimNext(T0 + 10)
    expect(first).toMatchObject({
      id: 'a-1',
      status: 'running',
      startedAt: T0 + 10,
      trigger: 'manual',
      requestedBy: 'alice',
      subject,
      scope: everyone,
      windowTo: T0,
      result: null,
      input: null,
    })
    expect(await store.claimNext(T0 + 11)).toMatchObject({ id: 'a-2', status: 'running' })
    expect(await store.claimNext(T0 + 12)).toBeNull()
  })

  test('a finished analysis keeps its input, result or error', async () => {
    const store = createInsightPersistence(harness.db)
    await store.insert(entry('ok', T0 + 1))
    await store.insert(entry('bad', T0 + 2))
    await store.claimNext(T0 + 3)
    await store.claimNext(T0 + 4)
    await store.finish('ok', { status: 'done', input, result }, T0 + 5)
    await store.finish(
      'bad',
      { status: 'failed', input, errorCode: 'invalid-output', errorMessage: 'not the document' },
      T0 + 6,
    )
    const [bad, ok] = await store.recent(subject, everyone, 10)
    expect(ok).toMatchObject({ id: 'ok', status: 'done', input, result, finishedAt: T0 + 5 })
    expect(bad).toMatchObject({
      id: 'bad',
      status: 'failed',
      input,
      result: null,
      errorCode: 'invalid-output',
      errorMessage: 'not the document',
      finishedAt: T0 + 6,
    })
    expect(await store.active(subject, everyone)).toBeNull()

    // Only a running analysis can be finished: a late second write changes nothing.
    await store.finish(
      'ok',
      { status: 'failed', input: null, errorCode: 'late', errorMessage: 'late' },
      T0 + 9,
    )
    expect((await store.recent(subject, everyone, 10))[1]).toMatchObject({
      status: 'done',
      errorCode: null,
    })
  })

  test('analyses left running by a previous daemon are failed at start', async () => {
    const store = createInsightPersistence(harness.db)
    await store.insert(entry('running', T0 + 1))
    await store.insert(entry('pending', T0 + 2))
    await store.claimNext(T0 + 3)
    expect(await store.failRunning('daemon-restarted', 'restarted', T0 + 4)).toBe(1)
    const rows = await store.recent(subject, everyone, 10)
    expect(rows.map((row) => [row.id, row.status])).toEqual([
      ['pending', 'pending'],
      ['running', 'failed'],
    ])
    expect(rows[1]).toMatchObject({ errorCode: 'daemon-restarted', finishedAt: T0 + 4 })
    expect(await store.failRunning('daemon-restarted', 'restarted', T0 + 5)).toBe(0)
  })

  test('scopes and subjects never see each other', async () => {
    const store = createInsightPersistence(harness.db)
    const noSource: InsightSubject = { kind: 'workflow', id: null, name: null }
    const group: InsightSubject = { kind: 'workgroup', id: 'wf-1', name: 'same id, other kind' }
    await store.insert(entry('all', T0 + 1))
    await store.insert(entry('mine', T0 + 2, { scope: alice }))
    await store.insert(entry('bobs', T0 + 3, { scope: { kind: 'user', userId: 'bob' } }))
    await store.insert(entry('unnamed', T0 + 4, { subject: noSource }))
    await store.insert(entry('group', T0 + 5, { subject: group }))
    const ids = async (target: InsightSubject, scope: InsightScope) =>
      (await store.recent(target, scope, 10)).map((row) => row.id)
    expect(await ids(subject, everyone)).toEqual(['all'])
    expect(await ids(subject, alice)).toEqual(['mine'])
    expect(await ids(subject, { kind: 'user', userId: 'bob' })).toEqual(['bobs'])
    expect(await ids(subject, { kind: 'user', userId: 'carol' })).toEqual([])
    expect(await ids(noSource, everyone)).toEqual(['unnamed'])
    expect(await ids(group, everyone)).toEqual(['group'])
    expect((await store.recent(noSource, everyone, 1))[0]!.subject).toEqual(noSource)
    expect((await store.active(subject, alice))!.scope).toEqual(alice)
  })

  test('only the newest analyses are kept, and never one that is queued or running', async () => {
    const store = createInsightPersistence(harness.db)
    for (let index = 1; index <= INSIGHT_KEEP + 3; index++) {
      await store.insert(entry(`a-${index}`, T0 + index))
    }
    // Finish all but the oldest two: `a-1` stays running, `a-2` stays pending.
    await store.claimNext(T0 + 100)
    for (let index = 3; index <= INSIGHT_KEEP + 3; index++) {
      const { observationInsightAnalyses } = tablesOf(harness.db)
      await harness.db
        .update(observationInsightAnalyses)
        .set({ status: 'done', finishedAt: T0 + 200 })
        .where(eq(observationInsightAnalyses.id, `a-${index}`))
    }
    await store.insert(entry('other-scope', T0 + 1, { scope: alice }))
    await store.prune(subject, everyone)
    const kept = (await store.recent(subject, everyone, 50)).map((row) => row.id)
    expect(kept).toEqual(['a-8', 'a-7', 'a-6', 'a-5', 'a-4', 'a-2', 'a-1'])
    expect((await store.recent(subject, alice, 50)).map((row) => row.id)).toEqual(['other-scope'])
  })

  test('the newest successful analysis is kept behind any number of failed ones', async () => {
    // Regression: pruning looked at age only, so five failures erased the last good result.
    const store = createInsightPersistence(harness.db)
    expect(await store.lastDone(subject, everyone)).toBeNull()
    const finish = async (id: string, at: number, ok: boolean) => {
      await store.insert(entry(id, at))
      await store.claimNext(at + 1)
      await store.finish(
        id,
        ok
          ? { status: 'done', input, result }
          : { status: 'failed', input, errorCode: 'run-failed', errorMessage: 'model unavailable' },
        at + 2,
      )
    }
    await finish('old-good', T0 + 10, true)
    await finish('good', T0 + 20, true)
    for (let index = 1; index <= INSIGHT_KEEP + 1; index++)
      await finish(`bad-${index}`, T0 + 20 + index * 10, false)
    // Another scope's result is not this scope's last good one.
    await store.insert(entry('other-scope', T0 + 500, { scope: alice }))
    await store.prune(subject, everyone)
    expect((await store.recent(subject, everyone, 50)).map((row) => row.id)).toEqual([
      'bad-6',
      'bad-5',
      'bad-4',
      'bad-3',
      'bad-2',
      // Older than the kept five, and kept: it is the result the page still shows.
      'good',
    ])
    expect(await store.lastDone(subject, everyone)).toMatchObject({
      id: 'good',
      status: 'done',
      result,
    })
    expect(await store.lastDone(subject, alice)).toBeNull()
  })

  test('the schedule reads the newest everyone-scope analysis per subject', async () => {
    const store = createInsightPersistence(harness.db)
    const second: InsightSubject = { kind: 'workflow', id: 'wf-2', name: null }
    await store.insert(entry('s-1', T0 + 1, { trigger: 'scheduled' }))
    await store.insert(entry('s-2', T0 + 9))
    await store.insert(entry('s-3', T0 + 4, { subject: second, trigger: 'scheduled' }))
    await store.insert(entry('private', T0 + 99, { scope: alice }))
    await store.insert(
      entry('group', T0 + 50, { subject: { kind: 'workgroup', id: 'wg-1', name: null } }),
    )
    expect([...(await store.lastScheduled('workflow'))].sort()).toEqual([
      ['wf-1', T0 + 9],
      ['wf-2', T0 + 4],
    ])
    expect([...(await store.lastScheduled('digital-employee'))]).toEqual([])
  })
})

function call(id: string, over: Partial<CallObservationStart> = {}): CallObservationStart {
  return {
    id,
    purpose: 'task',
    taskId: 'task-1',
    nodeRunId: 'run-1',
    agentId: 'agent-1',
    agentName: 'coder',
    runtimeId: 'rt-1',
    runtimeName: 'claude-main',
    protocol: 'claude-code',
    startedAt: T0,
    ...over,
  }
}

const tokens = (input: number, output: number, cacheRead = 0, cacheWrite = 0) => ({
  state: 'complete' as const,
  models: [{ model: 'sonnet', input, cacheRead, cacheWrite, output, reasoning: 0 }],
})

describeEachProvider('RFC-616 usage reads of the call store', (harness) => {
  test('with no call at all there is no usage epoch', async () => {
    expect(await createCallPersistence(harness.db).usageSince()).toBeNull()
  })

  test('calls are grouped by node run, purpose and system kind; tokens are the four buckets', async () => {
    const calls = composeRunObservationCalls(harness.db, () => T0 + 60_000)
    const done = async (
      start: CallObservationStart,
      usage: ReturnType<typeof tokens> | null,
      status: 'done' | 'failed' | 'canceled' = 'done',
    ) => {
      await calls.accept(start)
      await calls.finish(start.id, { status, endedAt: start.startedAt + 30_000, usage })
    }
    await done(call('c1'), tokens(100, 10, 5, 1))
    await done(call('c2'), tokens(200, 20))
    await done(call('c3', { nodeRunId: 'run-2' }), tokens(7, 3), 'canceled')
    await done(
      call('c4', {
        purpose: 'system',
        nodeRunId: null,
        systemKind: 'clarify-followup',
        startedAt: T0 + 500,
      }),
      tokens(1_000, 100),
    )
    await done(
      call('c5', {
        purpose: 'system',
        nodeRunId: null,
        systemKind: 'clarify-followup',
        startedAt: T0 + 100,
      }),
      null,
    )
    await done(
      call('c6', { purpose: 'system', nodeRunId: null, systemKind: 'memory-distiller' }),
      tokens(50, 5),
    )
    await done(call('other-task', { taskId: 'task-2', startedAt: T0 - 1_000 }), tokens(9_999, 1))
    // A task-less system call belongs to no task and is never part of a unit.
    await done(
      call('taskless', { purpose: 'system', taskId: null, nodeRunId: null, systemKind: 'x' }),
      tokens(1, 1),
    )

    const store = createCallPersistence(harness.db)
    const rows = [...(await store.usageByNodeRun(['task-1']))].sort((a, b) =>
      `${a.nodeRunId}|${a.systemKind}`.localeCompare(`${b.nodeRunId}|${b.systemKind}`),
    )
    expect(
      rows.map((row) => [row.nodeRunId, row.purpose, row.systemKind, row.calls, row.tokens]),
    ).toEqual([
      [null, 'system', 'clarify-followup', 2, 1_100],
      [null, 'system', 'memory-distiller', 1, 55],
      ['run-1', 'task', null, 2, 336],
      ['run-2', 'task', null, 1, 10],
    ])
    // Every call here has tokens but no price line.
    expect(rows.find((row) => row.nodeRunId === 'run-1')).toMatchObject({
      taskId: 'task-1',
      incompleteCalls: 0,
      unpricedCalls: 2,
      costNano: 0,
    })
    // A canceled call's usage is a lower bound; a call that reported nothing is incomplete too.
    expect(rows.find((row) => row.nodeRunId === 'run-2')!.incompleteCalls).toBe(1)
    expect(rows.find((row) => row.systemKind === 'clarify-followup')!.incompleteCalls).toBe(1)

    // The sum over a task's rows is the task's total on the run observation page.
    const [total] = await store.aggregate({ scope: { kind: 'tasks', taskIds: ['task-1'] } }, 'task')
    expect(rows.reduce((sum, row) => sum + row.tokens, 0)).toBe(
      total!.input + total!.cacheRead + total!.cacheWrite + total!.output,
    )
    expect(rows.reduce((sum, row) => sum + row.calls, 0)).toBe(total!.calls)

    expect(await store.systemCalls(['task-1'], 'clarify-followup')).toEqual([
      { taskId: 'task-1', startedAt: T0 + 100, endedAt: T0 + 30_100, tokens: 0, costNano: 0 },
      { taskId: 'task-1', startedAt: T0 + 500, endedAt: T0 + 30_500, tokens: 1_100, costNano: 0 },
    ])
    expect(await store.systemCalls(['task-1'], 'nothing-like-this')).toEqual([])
    expect(await store.usageSince()).toBe(T0 - 1_000)
    expect(await store.usageByNodeRun([])).toEqual([])
    const tooMany = Array.from({ length: 501 }, (_, index) => `t${index}`)
    await expect(store.usageByNodeRun(tooMany)).rejects.toThrow(RangeError)
    await expect(store.systemCalls(tooMany, 'x')).rejects.toThrow(RangeError)
  })
})

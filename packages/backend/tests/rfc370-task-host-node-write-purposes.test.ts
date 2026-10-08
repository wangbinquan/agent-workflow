// RFC-370 N1: real native Node SQL follows an explicit caller-selected purpose.
import { afterEach, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import type { ProviderNeutralDatabase } from '@/db/query'
import {
  nodeRunEvents,
  nodeRunOutputs,
  nodeRuns,
  taskExecutionObservationSources,
  taskExecutionOwners,
  tasks,
} from '@/db/schema'
import type { ObservationCapturedUsage } from '@agent-workflow/shared'
import type { NodeExecutionPersistence } from '@/modules/task-execution/application/ports/nodeExecutionPersistence'
import type { NodeRunLifecyclePersistence } from '@/modules/task-execution/application/ports/nodeRunLifecyclePersistence'
import type { TaskNodeWritePurposes } from '@/modules/task-execution/application/ports/taskNodeWritePurposes'
import {
  createTaskExecutionContext,
  currentTaskExecutionContext,
  runWithTaskExecutionContext,
} from '@/modules/task-execution/application/taskExecutionContext'
import {
  taskHostWorkCapture,
  taskHostWorkForToken,
} from '@/modules/task-execution/application/taskHostAdmission'
import {
  createOwnershipToken,
  createWorkerIdentity,
} from '@/modules/task-execution/domain/ownership'
import { createTaskExecutionPersistence } from '@/modules/task-execution/composition/taskExecutionPersistence'
import { DrizzleNodeExecutionPersistence } from '@/modules/task-execution/infrastructure/nodeExecutionPersistence'
import { DrizzleNodeRunLifecyclePersistence } from '@/modules/task-execution/infrastructure/nodeRunLifecyclePersistence'
import { createSelectedTaskNodeWritePurposes } from '@/modules/task-execution/infrastructure/taskHostNodeWritePurposes'
import type { TaskHostWriteBinding } from '@/modules/task-execution/infrastructure/hostExecutionWriteTransaction'
import { describeEachProvider } from './helpers/eachProvider'
import {
  additionalTaskHostFixture,
  deferred,
  taskHostFixture,
  type TaskHostWorkFixture,
} from './helpers/taskHostExecution'
import type { StatementRecording } from './helpers/statementRecorder'

const modules: { resetForTesting(): void }[] = []
afterEach(() => {
  for (const module of modules) module.resetForTesting()
  modules.length = 0
})

type Purpose = keyof TaskNodeWritePurposes
const purposes = ['preparation', 'issuedResults'] as const
const operations = [
  'patch',
  'upsertOutputs',
  'replaceOutputs',
  'appendEvent',
  'appendEvents',
  'retagSessionEpochs',
  'transition',
  'set',
] as const
type Operation = (typeof operations)[number]

interface NodeInstallation {
  readonly h: TaskHostWorkFixture
  readonly calls: { newWork: number; issuedAck: number }
}

async function nodeFixture(
  db: ProviderNeutralDatabase,
  tag: string,
  options: Parameters<typeof taskHostFixture>[2] = {},
  installation?: NodeInstallation,
) {
  const taskId = `node-purpose-${tag}-${ulid()}`
  const calls = installation?.calls ?? { newWork: 0, issuedAck: 0 }
  const h = installation
    ? await additionalTaskHostFixture(installation.h, taskId)
    : await taskHostFixture(db, taskId, {
        ...options,
        beforeNewWork() {
          calls.newWork++
          options.beforeNewWork?.()
        },
        beforeIssuedAck() {
          calls.issuedAck++
          options.beforeIssuedAck?.()
        },
      })
  if (!modules.includes(h.module)) modules.push(h.module)
  const claimed = await h.claim()
  h.module.claimGate.leave(claimed.permit)
  const work = taskHostWorkForToken(claimed.token)
  if (work === undefined) throw new Error('missing-original-node-work')
  const context = createTaskExecutionContext({
    intentId: h.intentId,
    token: claimed.token,
    persistence: h.persistence,
    legacyConnection: db,
    compatibility: { db },
    hostWriteCapture: taskHostWorkCapture(work),
  })
  const views = h.persistence.nodeWritePurposes
  if (views === undefined) throw new Error('missing-selected-node-purpose-views')
  const runId = `node-${taskId}`,
    mintedId = `minted-${taskId}`
  await db.insert(nodeRuns).values({
    id: runId,
    taskId,
    nodeId: 'worker',
    status: 'running',
    envelopeNonce: 'original-envelope',
  })
  await db.insert(nodeRunOutputs).values({ nodeRunId: runId, portName: 'old', content: 'old' })
  await db.insert(nodeRunEvents).values([
    { nodeRunId: runId, ts: 1, kind: 'text', payload: 'native text', sessionId: 'old-1' },
    {
      nodeRunId: runId,
      ts: 2,
      kind: 'stderr',
      payload: 'native stderr',
      parentSessionId: 'old-2',
    },
  ])
  const observation: ObservationCapturedUsage = {
    invocationId: `invocation-${runId}`,
    measurements: [],
    diagnostics: [],
  }
  const rows = async () => ({
    owners: await db
      .select()
      .from(taskExecutionOwners)
      .where(eq(taskExecutionOwners.taskId, taskId)),
    runs: await db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId)).orderBy(nodeRuns.id),
    outputs: await db
      .select()
      .from(nodeRunOutputs)
      .where(eq(nodeRunOutputs.nodeRunId, runId))
      .orderBy(nodeRunOutputs.portName),
    events: await db
      .select()
      .from(nodeRunEvents)
      .where(eq(nodeRunEvents.nodeRunId, runId))
      .orderBy(nodeRunEvents.id),
    observations: await db
      .select()
      .from(taskExecutionObservationSources)
      .where(eq(taskExecutionObservationSources.taskId, taskId))
      .orderBy(taskExecutionObservationSources.id),
  })
  calls.newWork = 0
  calls.issuedAck = 0
  return {
    db,
    h,
    calls,
    context,
    work,
    runId,
    mintedId,
    views,
    native: { nodeRuns: h.persistence.nodeRuns, nodeExecution: h.persistence.nodeExecution },
    observation,
    rows,
  }
}

type Fixture = Awaited<ReturnType<typeof nodeFixture>>

async function write(f: Fixture, purpose: Purpose, operation: Operation): Promise<unknown> {
  const view = f.views[purpose]
  if (operation === 'patch')
    return view.nodeExecution.patch({
      nodeRunId: f.runId,
      values: { promptText: 'original prompt' },
      now: 71,
    })
  if (operation === 'upsertOutputs')
    return view.nodeExecution.upsertOutputs({
      nodeRunId: f.runId,
      outputs: [
        { portName: 'received', content: 'first' },
        { portName: 'received', content: 'last', kind: 'text', active: false },
      ],
      now: 72,
    })
  if (operation === 'replaceOutputs')
    return view.nodeExecution.replaceOutputs({
      nodeRunId: f.runId,
      outputs: [{ portName: 'received', content: 'replacement', archiveJson: '{}' }],
      now: 73,
    })
  if (operation === 'appendEvent')
    return view.nodeExecution.appendEvent({
      nodeRunId: f.runId,
      ts: 74,
      kind: 'text',
      payload: 'one original event',
      sessionId: 'old-1',
      parentSessionId: 'old-2',
    })
  if (operation === 'appendEvents')
    return view.nodeExecution.appendEvents({
      nodeRunId: f.runId,
      events: [{ ts: 75, kind: 'stderr', payload: 'original chunk', sessionId: 'old-1' }],
      observations: [f.observation],
    })
  if (operation === 'retagSessionEpochs')
    return view.nodeExecution.retagSessionEpochs({
      nodeRunId: f.runId,
      supersededSessionIds: ['old-1', 'old-2'],
      logicalSessionId: 'logical-session',
      now: 76,
    })
  if (operation === 'transition')
    return view.nodeRuns.transition({
      nodeRunId: f.runId,
      event: { kind: 'mark-done' },
      extra: { finishedAt: 77 },
    })
  return view.nodeRuns.set({
    nodeRunId: f.runId,
    to: 'done',
    allowedFrom: ['running'],
    extra: { finishedAt: 78 },
    reason: 'original-result',
  })
}

function expectOriginalWork(f: Fixture, leases = 1) {
  expect(f.h.completed).toBe(0)
  expect(f.h.leases).toHaveLength(leases)
  expect(taskHostWorkForToken(f.context.token)).toBe(f.work)
}

function expectConsume(f: Fixture, purpose: Purpose, count = 1) {
  expect(f.calls).toEqual({
    newWork: purpose === 'preparation' ? count : 0,
    issuedAck: purpose === 'issuedResults' ? count : 0,
  })
}

function expectTransaction(recording: StatementRecording, outcome: 'commit' | 'rollback') {
  expect(recording.statements.filter(({ sql }) => /^\s*begin\b/i.test(sql))).toHaveLength(1)
  expect(recording.statements.filter(({ sql }) => /^\s*commit\b/i.test(sql))).toHaveLength(
    outcome === 'commit' ? 1 : 0,
  )
  expect(recording.statements.filter(({ sql }) => /^\s*rollback\b/i.test(sql))).toHaveLength(
    outcome === 'rollback' ? 1 : 0,
  )
}

async function expectWrittenRows(f: Fixture, operation: Operation, result: unknown) {
  const after = await f.rows()
  if (operation === 'patch') {
    expect(result).toBe(true)
    expect(after.runs[0]?.promptText).toBe('original prompt')
    expect(after.owners[0]?.updatedAt).toBe(71)
  } else if (operation === 'upsertOutputs') {
    expect(result).toBeUndefined()
    expect(
      after.outputs.map(({ portName, content, active }) => ({ portName, content, active })),
    ).toEqual([
      { portName: 'old', content: 'old', active: true },
      { portName: 'received', content: 'last', active: false },
    ])
    expect(after.owners[0]?.updatedAt).toBe(72)
  } else if (operation === 'replaceOutputs') {
    expect(result).toBeUndefined()
    expect(after.outputs).toHaveLength(1)
    expect(after.outputs[0]).toMatchObject({
      portName: 'received',
      content: 'replacement',
      archiveJson: '{}',
    })
    expect(after.owners[0]?.updatedAt).toBe(73)
  } else if (operation === 'appendEvent') {
    expect(result).toBeUndefined()
    expect(after.events).toHaveLength(3)
    expect(after.events[2]).toMatchObject({
      ts: 74,
      payload: 'one original event',
      sessionId: 'old-1',
      parentSessionId: 'old-2',
    })
    expect(after.owners[0]?.updatedAt).toBe(74)
  } else if (operation === 'appendEvents') {
    expect(result).toBeUndefined()
    expect(after.events).toHaveLength(3)
    expect(after.events[2]).toMatchObject({ ts: 75, kind: 'stderr', payload: 'original chunk' })
    expect(after.observations).toHaveLength(1)
    expect(JSON.parse(after.observations[0]!.evidenceJson)).toEqual(f.observation)
    expect(after.owners[0]?.updatedAt).toBe(75)
  } else if (operation === 'retagSessionEpochs') {
    expect(result).toBeUndefined()
    expect(after.events[0]?.sessionId).toBe('logical-session')
    expect(after.events[1]?.parentSessionId).toBe('logical-session')
    expect(after.owners[0]?.updatedAt).toBe(76)
  } else {
    expect(result).toEqual({ from: 'running', to: 'done' })
    expect(after.runs[0]).toMatchObject({
      status: 'done',
      finishedAt: operation === 'transition' ? 77 : 78,
    })
  }
}

interface NativeCall {
  readonly name: string
  readonly args: readonly unknown[]
  readonly receiver: object
  readonly context: ReturnType<typeof currentTaskExecutionContext>
}

function traceMethod<Args extends unknown[], Result>(
  receiver: object,
  name: string,
  method: (...args: Args) => Promise<Result>,
  calls: NativeCall[],
): (...args: Args) => Promise<Result> {
  return async function (this: object, ...args: Args) {
    expect(this).toBe(receiver)
    calls.push({ name, args, receiver: this, context: currentTaskExecutionContext() })
    return await method.apply(this, args)
  }
}

function traceNative(f: Fixture, calls: NativeCall[]) {
  const n = f.native.nodeExecution,
    r = f.native.nodeRuns
  n.read = traceMethod(n, 'read', n.read, calls)
  n.list = traceMethod(n, 'list', n.list, calls)
  n.listOutputs = traceMethod(n, 'listOutputs', n.listOutputs, calls)
  n.countAgentTextEvents = traceMethod(n, 'countAgentTextEvents', n.countAgentTextEvents, calls)
  n.readStderr = traceMethod(n, 'readStderr', n.readStderr, calls)
  n.patch = traceMethod(n, 'patch', n.patch, calls)
  n.upsertOutputs = traceMethod(n, 'upsertOutputs', n.upsertOutputs, calls)
  n.replaceOutputs = traceMethod(n, 'replaceOutputs', n.replaceOutputs, calls)
  n.appendEvent = traceMethod(n, 'appendEvent', n.appendEvent, calls)
  n.appendEvents = traceMethod(n, 'appendEvents', n.appendEvents, calls)
  n.retagSessionEpochs = traceMethod(n, 'retagSessionEpochs', n.retagSessionEpochs, calls)
  r.mint = traceMethod(r, 'mint', r.mint, calls)
  r.transition = traceMethod(r, 'transition', r.transition, calls)
  r.set = traceMethod(r, 'set', r.set, calls)
  r.loadEnvelopeNonce = traceMethod(r, 'loadEnvelopeNonce', r.loadEnvelopeNonce, calls)
  return createSelectedTaskNodeWritePurposes({ db: f.db, hostWrites: f.h.binding, ...f.native })
}

describeEachProvider('RFC-370 selected native Task Node write purposes', (harness) => {
  for (const purpose of purposes) {
    for (const operation of operations) {
      test(`${purpose} ${operation}: real original SQL and one owner revision commit`, async () => {
        const f = await nodeFixture(harness.db, `${purpose}-${operation}`)
        const before = await f.rows()
        if (purpose === 'issuedResults') f.h.lose()
        const recording = harness.recordStatements()
        let result: unknown
        try {
          result = await runWithTaskExecutionContext(f.context, () => write(f, purpose, operation))
          expectTransaction(recording, 'commit')
        } finally {
          recording.stop()
        }
        await expectWrittenRows(f, operation, result)
        expect((await f.rows()).owners[0]?.revision).toBe(before.owners[0]!.revision + 1)
        expectConsume(f, purpose)
        expectOriginalWork(f)
      })

      test(`${purpose} ${operation}: failed host consumption rolls back and original work retries`, async () => {
        let fail = false
        const error = new Error(`original ${purpose} ${operation} host rejection`)
        const f = await nodeFixture(harness.db, `${purpose}-${operation}-rollback`, {
          beforeNewWork() {
            if (purpose === 'preparation' && fail) throw error
          },
          beforeIssuedAck() {
            if (purpose === 'issuedResults' && fail) throw error
          },
        })
        const before = await f.rows()
        if (purpose === 'issuedResults') f.h.lose()
        fail = true
        const recording = harness.recordStatements()
        try {
          await expect(
            runWithTaskExecutionContext(f.context, () => write(f, purpose, operation)),
          ).rejects.toBe(error)
          expectTransaction(recording, 'rollback')
        } finally {
          recording.stop()
        }
        expect(await f.rows()).toEqual(before)
        expectConsume(f, purpose)
        expectOriginalWork(f)
        fail = false
        const result = await runWithTaskExecutionContext(f.context, () =>
          write(f, purpose, operation),
        )
        await expectWrittenRows(f, operation, result)
        expect((await f.rows()).owners[0]?.revision).toBe(before.owners[0]!.revision + 1)
        expectConsume(f, purpose, 2)
        expectOriginalWork(f)
      })
    }

    test(`${purpose}: complete native method inputs and receivers retain the original context`, async () => {
      const f = await nodeFixture(harness.db, `${purpose}-complete`)
      const calls: NativeCall[] = []
      const view = traceNative(f, calls)[purpose]
      const projection = {
        nodeRunId: f.runId,
        values: { promptText: 'original object' },
        executionContext: f.context,
        now: 301,
      }
      const query = { taskId: f.h.taskId, containerRunId: null }
      const output = {
        nodeRunId: f.runId,
        outputs: [{ portName: 'traced', content: 'original' }],
        executionContext: f.context,
      }
      const event = {
        nodeRunId: f.runId,
        ts: 302,
        kind: 'text' as const,
        payload: 'traced',
        executionContext: f.context,
      }
      const chunk = {
        nodeRunId: f.runId,
        events: [{ ts: 303, kind: 'stderr' as const, payload: 'traced chunk' }],
        observations: [f.observation],
        executionContext: f.context,
      }
      const epochs = {
        nodeRunId: f.runId,
        supersededSessionIds: ['old-1', 'old-2'],
        logicalSessionId: 'traced-logical',
        executionContext: f.context,
      }
      const transition = {
        nodeRunId: f.runId,
        event: { kind: 'mark-done' as const },
        executionContext: f.context,
      }
      const set = {
        nodeRunId: f.runId,
        to: 'done' as const,
        allowedFrom: ['running' as const],
        executionContext: f.context,
      }
      await runWithTaskExecutionContext(f.context, async () => {
        expect((await view.nodeExecution.read(f.runId))?.id).toBe(f.runId)
        expect((await view.nodeExecution.list(query)).map((row) => row.id)).toEqual([f.runId])
        expect(await view.nodeExecution.listOutputs(f.runId)).toHaveLength(1)
        expect(await view.nodeExecution.countAgentTextEvents(f.runId, '[framework]')).toBe(1)
        expect(await view.nodeExecution.readStderr(f.runId)).toBe('native stderr')
        expect(await view.nodeRuns.loadEnvelopeNonce(f.runId)).toBe('original-envelope')
        expect(await view.nodeExecution.patch(projection)).toBe(true)
        await view.nodeExecution.upsertOutputs(output)
        await view.nodeExecution.replaceOutputs(output)
        await view.nodeExecution.appendEvent(event)
        await view.nodeExecution.appendEvents(chunk)
        await view.nodeExecution.retagSessionEpochs(epochs)
        expect(await view.nodeRuns.transition(transition)).toEqual({ from: 'running', to: 'done' })
        await f.db.update(nodeRuns).set({ status: 'running' }).where(eq(nodeRuns.id, f.runId))
        expect(await view.nodeRuns.set(set)).toEqual({ from: 'running', to: 'done' })
      })
      for (const [name, original] of [
        ['list', query],
        ['patch', projection],
        ['upsertOutputs', output],
        ['replaceOutputs', output],
        ['appendEvent', event],
        ['retagSessionEpochs', epochs],
        ['transition', transition],
        ['set', set],
      ] as const)
        expect(calls.find((call) => call.name === name)?.args[0]).toBe(original)
      expect(
        calls.find((call) => call.name === 'appendEvents' && call.args[0] === chunk)?.args[0],
      ).toBe(chunk)
      expect(calls.find((call) => call.name === 'countAgentTextEvents')?.args).toEqual([
        f.runId,
        '[framework]',
      ])
      expect(new Set(calls.map((call) => call.name))).toEqual(
        new Set([
          'read',
          'list',
          'listOutputs',
          'countAgentTextEvents',
          'readStderr',
          'loadEnvelopeNonce',
          ...operations,
        ]),
      )
      for (const call of calls) expect(call.context).toBe(f.context)
      expectConsume(f, purpose, 8)
      expectOriginalWork(f)
    })

    test(`${purpose}: explicit original context wins without ambient and with another real Task ambient`, async () => {
      const f = await nodeFixture(harness.db, `${purpose}-explicit`)
      const other = await nodeFixture(harness.db, 'other-ambient', {}, f)
      expect(other.h.module).toBe(f.h.module)
      expect(other.h.binding).toBe(f.h.binding)
      expect(other.context.token.taskId).not.toBe(f.context.token.taskId)
      const before = await f.rows(),
        otherBefore = await other.rows()
      const calls: NativeCall[] = []
      const view = traceNative(f, calls)[purpose]
      if (purpose === 'issuedResults') f.h.lose()
      const first = {
        nodeRunId: f.runId,
        values: { promptText: 'explicit without ALS' },
        executionContext: f.context,
        now: 401,
      }
      expect(currentTaskExecutionContext()).toBeUndefined()
      expect(await view.nodeExecution.patch(first)).toBe(true)
      expect(currentTaskExecutionContext()).toBeUndefined()
      const second = {
        nodeRunId: f.runId,
        events: [],
        observations: [f.observation],
        executionContext: f.context,
      }
      await runWithTaskExecutionContext(other.context, async () => {
        await view.nodeExecution.appendEvents(second)
        expect(currentTaskExecutionContext()).toBe(other.context)
      })
      for (const environment of ['absent', 'other-task'] as const) {
        const exercise = async () => {
          const projection = {
            nodeRunId: f.runId,
            values: { promptText: 'explicit without ALS' },
            executionContext: f.context,
            now: 403,
          }
          const chunk = {
            nodeRunId: f.runId,
            events: [],
            observations: [f.observation],
            executionContext: f.context,
          }
          const output = {
            nodeRunId: f.runId,
            outputs: [{ portName: 'explicit', content: environment }],
            executionContext: f.context,
          }
          const event = {
            nodeRunId: f.runId,
            ts: 402,
            kind: 'text' as const,
            payload: environment,
            executionContext: f.context,
          }
          const epochs = {
            nodeRunId: f.runId,
            supersededSessionIds: ['old-1'],
            logicalSessionId: environment,
            executionContext: f.context,
          }
          const transition = {
            nodeRunId: f.runId,
            event: { kind: 'mark-done' as const },
            executionContext: f.context,
          }
          const set = {
            nodeRunId: f.runId,
            to: 'done' as const,
            allowedFrom: ['running' as const],
            executionContext: f.context,
          }
          expect(await view.nodeExecution.patch(projection)).toBe(true)
          await view.nodeExecution.appendEvents(chunk)
          await view.nodeExecution.upsertOutputs(output)
          await view.nodeExecution.replaceOutputs(output)
          await view.nodeExecution.appendEvent(event)
          await view.nodeExecution.retagSessionEpochs(epochs)
          await f.db.update(nodeRuns).set({ status: 'running' }).where(eq(nodeRuns.id, f.runId))
          expect(await view.nodeRuns.transition(transition)).toEqual({
            from: 'running',
            to: 'done',
          })
          await f.db.update(nodeRuns).set({ status: 'running' }).where(eq(nodeRuns.id, f.runId))
          expect(await view.nodeRuns.set(set)).toEqual({ from: 'running', to: 'done' })
          for (const [name, input] of [
            ['patch', projection],
            ['appendEvents', chunk],
            ['upsertOutputs', output],
            ['replaceOutputs', output],
            ['appendEvent', event],
            ['retagSessionEpochs', epochs],
            ['transition', transition],
            ['set', set],
          ] as const)
            expect(
              calls.find((call) => call.name === name && call.args[0] === input)?.args[0],
            ).toBe(input)
          if (purpose === 'preparation') {
            const mintId = `${f.mintedId}-${environment}`
            const mint: Parameters<NodeRunLifecyclePersistence['mint']>[0] = {
              id: mintId,
              taskId: f.h.taskId,
              nodeId: 'explicit-mint',
              status: 'done',
              cause: 'io-virtual',
              outputs: [{ portName: 'explicit', content: environment }],
              executionContext: f.context,
            }
            expect(await view.nodeRuns.mint(mint)).toBe(mintId)
            expect(
              calls.find((call) => call.name === 'mint' && call.args[0] === mint)?.args[0],
            ).toBe(mint)
            expect(
              (
                await f.db.select().from(nodeRunOutputs).where(eq(nodeRunOutputs.nodeRunId, mintId))
              )[0]?.content,
            ).toBe(environment)
          }
          expect(currentTaskExecutionContext()).toBe(
            environment === 'absent' ? undefined : other.context,
          )
        }
        if (environment === 'absent') await exercise()
        else await runWithTaskExecutionContext(other.context, exercise)
        expect(currentTaskExecutionContext()).toBeUndefined()
      }
      expect(calls.find((call) => call.name === 'patch')?.args[0]).toBe(first)
      expect(calls.find((call) => call.name === 'appendEvents')?.args[0]).toBe(second)
      for (const call of calls) expect(call.context).toBe(f.context)
      const after = await f.rows()
      expect(after.runs.find((row) => row.id === f.runId)?.promptText).toBe('explicit without ALS')
      expect(after.observations).toHaveLength(3)
      const expectedWrites = purpose === 'preparation' ? 20 : 18
      expect(after.owners[0]?.revision).toBe(before.owners[0]!.revision + expectedWrites)
      expect(await other.rows()).toEqual(otherBefore)
      expectConsume(f, purpose, expectedWrites)
      expectOriginalWork(f, 2)
      expectOriginalWork(other, 2)
    }, 15_000)

    test(`${purpose}: observation-only is a real write and an empty replacement deletes`, async () => {
      const f = await nodeFixture(harness.db, `${purpose}-observation-only`)
      const before = await f.rows()
      if (purpose === 'issuedResults') f.h.lose()
      const view = f.views[purpose]
      await view.nodeExecution.appendEvents({
        nodeRunId: f.runId,
        events: [],
        observations: [f.observation],
        executionContext: f.context,
      })
      const observed = await f.rows()
      expect(observed.events).toEqual(before.events)
      expect(observed.observations).toHaveLength(1)
      expect(JSON.parse(observed.observations[0]!.evidenceJson)).toEqual(f.observation)
      await view.nodeExecution.replaceOutputs({
        nodeRunId: f.runId,
        outputs: [],
        executionContext: f.context,
        now: 501,
      })
      const replaced = await f.rows()
      expect(replaced.outputs).toEqual([])
      expect(replaced.observations).toEqual(observed.observations)
      expect(replaced.owners[0]?.revision).toBe(before.owners[0]!.revision + 2)
      expect(replaced.owners[0]?.updatedAt).toBe(501)
      expectConsume(f, purpose, 2)
      expectOriginalWork(f)
    })

    test(`${purpose}: original source-terminal and missing-node errors precede host consumption`, async () => {
      let fail = false
      const error = new Error('host must not replace the original business error')
      const f = await nodeFixture(harness.db, `${purpose}-business-errors`, {
        beforeNewWork() {
          if (fail) throw error
        },
        beforeIssuedAck() {
          if (fail) throw error
        },
      })
      fail = true
      const view = f.views[purpose]
      const before = await f.rows()
      await expect(
        view.nodeRuns.transition({
          nodeRunId: 'missing',
          event: { kind: 'mark-done' },
          executionContext: f.context,
        }),
      ).rejects.toMatchObject({ code: 'node-run-not-found' })
      await expect(
        view.nodeRuns.set({
          nodeRunId: 'missing',
          to: 'done',
          allowedFrom: ['running'],
          executionContext: f.context,
        }),
      ).rejects.toMatchObject({ code: 'node-run-not-found' })
      await expect(
        view.nodeRuns.transition({
          nodeRunId: f.runId,
          event: { kind: 'mark-running' },
          executionContext: f.context,
        }),
      ).rejects.toMatchObject({ code: 'illegal-node-run-transition' })
      expect(await f.rows()).toEqual(before)
      await f.db
        .update(tasks)
        .set({ sourceTerminationFence: 'closed' })
        .where(eq(tasks.id, f.h.taskId))
      await f.db.update(nodeRuns).set({ status: 'pending' }).where(eq(nodeRuns.id, f.runId))
      const fenced = await f.rows()
      await expect(
        view.nodeRuns.transition({
          nodeRunId: f.runId,
          event: { kind: 'mark-running' },
          executionContext: f.context,
        }),
      ).rejects.toMatchObject({ code: 'task-source-terminal-closed' })
      await expect(
        view.nodeRuns.set({
          nodeRunId: f.runId,
          to: 'running',
          allowedFrom: ['pending'],
          executionContext: f.context,
        }),
      ).rejects.toMatchObject({ code: 'task-source-terminal-closed' })
      expect(await f.rows()).toEqual(fenced)
      expect(f.calls).toEqual({ newWork: 0, issuedAck: 0 })
      expectOriginalWork(f)
    })
  }

  test('preparation rejects every original nonempty Node write after draining with real SQL rollback', async () => {
    const f = await nodeFixture(harness.db, 'draining-all-original-writes')
    f.h.lose()
    for (const operation of operations) {
      f.calls.newWork = 0
      f.calls.issuedAck = 0
      const before = await f.rows()
      const recording = harness.recordStatements()
      try {
        await expect(
          runWithTaskExecutionContext(f.context, () => write(f, 'preparation', operation)),
        ).rejects.toThrow()
        expectTransaction(recording, 'rollback')
      } finally {
        recording.stop()
      }
      expect(await f.rows()).toEqual(before)
      expectConsume(f, 'preparation')
      expectOriginalWork(f)
    }
  }, 15_000)

  test('mint keeps original input, native receiver and atomic row/output rollback and retry', async () => {
    let fail = false
    const error = new Error('original mint host rejection')
    const f = await nodeFixture(harness.db, 'mint-atomic', {
      beforeNewWork() {
        if (fail) throw error
      },
    })
    const calls: NativeCall[] = []
    const view = traceNative(f, calls).preparation
    const input: Parameters<NodeRunLifecyclePersistence['mint']>[0] = {
      id: f.mintedId,
      taskId: f.h.taskId,
      nodeId: 'io-input',
      status: 'done',
      cause: 'io-virtual',
      outputs: [{ portName: 'input', content: 'atomic original input' }],
      overrides: { envelopeNonce: 'mint-envelope' },
      executionContext: f.context,
    }
    const before = await f.rows()
    fail = true
    const recording = harness.recordStatements()
    try {
      await expect(view.nodeRuns.mint(input)).rejects.toBe(error)
      expectTransaction(recording, 'rollback')
    } finally {
      recording.stop()
    }
    expect(await f.rows()).toEqual(before)
    expect(
      await f.db.select().from(nodeRunOutputs).where(eq(nodeRunOutputs.nodeRunId, f.mintedId)),
    ).toEqual([])
    fail = false
    expect(await view.nodeRuns.mint(input)).toBe(f.mintedId)
    expect(
      (await f.db.select().from(nodeRuns).where(eq(nodeRuns.id, f.mintedId)))[0],
    ).toMatchObject({ status: 'done', envelopeNonce: 'mint-envelope' })
    expect(
      (await f.db.select().from(nodeRunOutputs).where(eq(nodeRunOutputs.nodeRunId, f.mintedId)))[0],
    ).toMatchObject({ portName: 'input', content: 'atomic original input' })
    for (const call of calls) {
      expect(call.name).toBe('mint')
      expect(call.args[0]).toBe(input)
      expect(call.context).toBe(f.context)
    }
    expectConsume(f, 'preparation', 2)
    expectOriginalWork(f)
  })

  test('born-done mint with empty initial outputs remains new preparation under draining', async () => {
    const f = await nodeFixture(harness.db, 'mint-draining')
    const before = await f.rows()
    f.h.lose()
    await expect(
      f.views.preparation.nodeRuns.mint({
        id: f.mintedId,
        taskId: f.h.taskId,
        nodeId: 'io',
        status: 'done',
        cause: 'io-virtual',
        outputs: [],
        executionContext: f.context,
      }),
    ).rejects.toThrow()
    expect(await f.rows()).toEqual(before)
    expect(Object.hasOwn(f.views.issuedResults.nodeRuns, 'mint')).toBe(false)
    expectConsume(f, 'preparation')
    expectOriginalWork(f)
  })

  test('all six reads and three genuine empty inputs stay independent of Task admission', async () => {
    const f = await nodeFixture(harness.db, 'read-empty')
    const before = await f.rows()
    f.h.lose()
    const recording = harness.recordStatements()
    try {
      for (const purpose of purposes) {
        const view = f.views[purpose]
        expect(await view.nodeExecution.read('missing')).toBeNull()
        expect(
          (await view.nodeExecution.list({ taskId: f.h.taskId })).map((row) => row.id),
        ).toEqual([f.runId])
        expect(await view.nodeExecution.listOutputs(f.runId)).toEqual(before.outputs)
        expect(await view.nodeExecution.countAgentTextEvents(f.runId, '[framework]')).toBe(1)
        expect(await view.nodeExecution.readStderr(f.runId)).toBe('native stderr')
        expect(await view.nodeRuns.loadEnvelopeNonce(f.runId)).toBe('original-envelope')
        expect(await view.nodeRuns.loadEnvelopeNonce('missing')).toBe('')
        await view.nodeExecution.upsertOutputs({ nodeRunId: f.runId, outputs: [] })
        await view.nodeExecution.appendEvents({ nodeRunId: f.runId, events: [], observations: [] })
        await view.nodeExecution.appendEvents({ nodeRunId: f.runId, events: [] })
        await view.nodeExecution.retagSessionEpochs({
          nodeRunId: f.runId,
          supersededSessionIds: [],
          logicalSessionId: 'ignored',
        })
      }
      expect(
        recording.statements.filter(({ sql }) => /^\s*(begin|commit|rollback)\b/i.test(sql)),
      ).toEqual([])
    } finally {
      recording.stop()
    }
    expect(await f.rows()).toEqual(before)
    expect(f.calls).toEqual({ newWork: 0, issuedAck: 0 })
    expect(currentTaskExecutionContext()).toBeUndefined()
    expectOriginalWork(f)
  })

  test('nonempty selected writes require the complete original work and never use native fallback', async () => {
    const f = await nodeFixture(harness.db, 'missing-work')
    const before = await f.rows()
    for (const purpose of purposes) {
      await expect(
        f.views[purpose].nodeExecution.patch({
          nodeRunId: f.runId,
          values: { promptText: 'must not write' },
        }),
      ).rejects.toThrow('task-host-execution-context-required')
    }
    const identity = createWorkerIdentity({
      ownerId: f.context.token.ownerId,
      daemonGeneration: f.context.token.daemonGeneration,
    })
    const unassociated = createOwnershipToken({
      taskId: f.h.taskId,
      identity,
      epoch: f.context.token.epoch,
      leaseUntil: f.context.token.leaseUntil,
      ownerRevision: f.context.token.ownerRevision,
    })
    const context = createTaskExecutionContext({
      intentId: f.h.intentId,
      token: unassociated,
      persistence: f.h.persistence,
      legacyConnection: f.db,
      compatibility: { db: f.db },
    })
    await expect(
      f.views.issuedResults.nodeExecution.patch({
        nodeRunId: f.runId,
        values: { promptText: 'must not write' },
        executionContext: context,
      }),
    ).rejects.toThrow('task-host-admitted-work-required')
    expect(() =>
      createSelectedTaskNodeWritePurposes({
        db: f.db,
        hostWrites: undefined as unknown as TaskHostWriteBinding,
        ...f.native,
      }),
    ).toThrow('task-host-write-selection-incomplete')
    expect(await f.rows()).toEqual(before)
    expect(f.calls).toEqual({ newWork: 0, issuedAck: 0 })
    expectOriginalWork(f)
  })

  test('the saved original method and complete explicit context survive an await and another Task', async () => {
    const f = await nodeFixture(harness.db, 'await-original')
    const other = await nodeFixture(harness.db, 'await-other', {}, f)
    const before = await f.rows(),
      otherBefore = await other.rows()
    const entered = deferred(),
      release = deferred()
    const native = f.native.nodeExecution
    const originalPatch = native.patch
    const input: Parameters<NodeExecutionPersistence['patch']>[0] = {
      nodeRunId: f.runId,
      values: { promptText: 'saved original input' },
      executionContext: f.context,
      now: 601,
    }
    const seen: NativeCall[] = []
    native.patch = async function (projection) {
      expect(this).toBe(native)
      expect(projection).toBe(input)
      seen.push({
        name: 'before',
        args: [projection],
        receiver: this,
        context: currentTaskExecutionContext(),
      })
      entered.resolve()
      await release.promise
      seen.push({
        name: 'after',
        args: [projection],
        receiver: this,
        context: currentTaskExecutionContext(),
      })
      return await originalPatch.call(this, projection)
    }
    const selected = createSelectedTaskNodeWritePurposes({
      db: f.db,
      hostWrites: f.h.binding,
      ...f.native,
    })
    await runWithTaskExecutionContext(other.context, async () => {
      const pending = selected.issuedResults.nodeExecution.patch(input)
      await entered.promise
      expect(currentTaskExecutionContext()).toBe(other.context)
      native.patch = async () => {
        throw new Error('replacement must not run')
      }
      f.h.lose()
      release.resolve()
      expect(await pending).toBe(true)
      expect(currentTaskExecutionContext()).toBe(other.context)
    })
    expect(seen.map((call) => call.context)).toEqual([f.context, f.context])
    for (const call of seen) expect(call.context).toBe(f.context)
    const after = await f.rows()
    expect(after.runs[0]?.promptText).toBe('saved original input')
    expect(after.owners[0]?.revision).toBe(before.owners[0]!.revision + 1)
    expect(await other.rows()).toEqual(otherBefore)
    expectConsume(f, 'issuedResults')
    expectOriginalWork(f, 2)
    expectOriginalWork(other, 2)
  })

  test('original missing projection false/no-op and original row/task mismatch stay unchanged', async () => {
    const f = await nodeFixture(harness.db, 'native-missing')
    const other = await nodeFixture(harness.db, 'native-mismatch', {}, f)
    const before = await f.rows(),
      otherBefore = await other.rows()
    f.h.lose()
    const view = f.views.issuedResults.nodeExecution
    await runWithTaskExecutionContext(f.context, async () => {
      expect(await view.patch({ nodeRunId: 'missing', values: { promptText: 'ignored' } })).toBe(
        false,
      )
      await view.upsertOutputs({
        nodeRunId: 'missing',
        outputs: [{ portName: 'ignored', content: 'ignored' }],
      })
      await view.replaceOutputs({ nodeRunId: 'missing', outputs: [] })
      await view.appendEvent({ nodeRunId: 'missing', ts: 1, kind: 'text', payload: 'ignored' })
      await view.appendEvents({ nodeRunId: 'missing', events: [], observations: [f.observation] })
      await view.retagSessionEpochs({
        nodeRunId: 'missing',
        supersededSessionIds: ['old-1'],
        logicalSessionId: 'ignored',
      })
    })
    expect(await f.rows()).toEqual(before)
    expectConsume(f, 'issuedResults', 6)
    await expect(
      view.patch({
        nodeRunId: other.runId,
        values: { promptText: 'must not write' },
        executionContext: f.context,
      }),
    ).rejects.toThrow('task-execution-context-task-mismatch')
    expect(await f.rows()).toEqual(before)
    expect(await other.rows()).toEqual(otherBefore)
    expectConsume(f, 'issuedResults', 6)
    expectOriginalWork(f, 2)
    expectOriginalWork(other, 2)
  })

  test('the original business error object after actual SQL rolls back before any host consumption', async () => {
    let fail = false
    const hostError = new Error('host must not replace body error')
    const originalError = new Error('original native body failure after SQL')
    const f = await nodeFixture(harness.db, 'body-error', {
      beforeNewWork() {
        if (fail) throw hostError
      },
      beforeIssuedAck() {
        if (fail) throw hostError
      },
    })
    const other = await nodeFixture(harness.db, 'body-error-other', {}, f)
    const before = await f.rows(),
      otherBefore = await other.rows()
    const native = f.native.nodeExecution,
      original = native.patch
    native.patch = async function (input) {
      expect(this).toBe(native)
      expect(currentTaskExecutionContext()).toBe(f.context)
      expect(await original.call(this, input)).toBe(true)
      expect((await this.read(f.runId))?.promptText).toBe('real SQL before original error')
      throw originalError
    }
    const views = createSelectedTaskNodeWritePurposes({
      db: f.db,
      hostWrites: f.h.binding,
      ...f.native,
    })
    fail = true
    for (const purpose of purposes) {
      const recording = harness.recordStatements()
      try {
        await expect(
          views[purpose].nodeExecution.patch({
            nodeRunId: f.runId,
            values: { promptText: 'real SQL before original error' },
            executionContext: f.context,
          }),
        ).rejects.toBe(originalError)
        expectTransaction(recording, 'rollback')
      } finally {
        recording.stop()
      }
      expect(await f.rows()).toEqual(before)
      expect(await other.rows()).toEqual(otherBefore)
    }
    expect(f.calls).toEqual({ newWork: 0, issuedAck: 0 })
    expectOriginalWork(f, 2)
    expectOriginalWork(other, 2)
  })

  test('composition exposes only explicit purpose views while both full original native ports remain', async () => {
    const f = await nodeFixture(harness.db, 'composition')
    const native = createTaskExecutionPersistence(harness.db)
    expect(Object.hasOwn(native, 'nodeWritePurposes')).toBe(false)
    expect(native.nodeRuns).toBeInstanceOf(DrizzleNodeRunLifecyclePersistence)
    expect(native.nodeExecution).toBeInstanceOf(DrizzleNodeExecutionPersistence)
    expect(native.nodeRuns.mint).toBe(DrizzleNodeRunLifecyclePersistence.prototype.mint)
    expect(native.nodeExecution.patch).toBe(DrizzleNodeExecutionPersistence.prototype.patch)
    expect(f.h.persistence.nodeRuns).toBe(f.native.nodeRuns)
    expect(f.h.persistence.nodeExecution).toBe(f.native.nodeExecution)
    expect(f.native.nodeRuns).toBeInstanceOf(DrizzleNodeRunLifecyclePersistence)
    expect(f.native.nodeExecution).toBeInstanceOf(DrizzleNodeExecutionPersistence)
    expect(f.native.nodeRuns.mint).toBe(DrizzleNodeRunLifecyclePersistence.prototype.mint)
    expect(f.native.nodeExecution.patch).toBe(DrizzleNodeExecutionPersistence.prototype.patch)
    expect(Object.keys(f.views.preparation.nodeRuns).sort()).toEqual([
      'loadEnvelopeNonce',
      'mint',
      'set',
      'transition',
    ])
    expect(Object.keys(f.views.issuedResults.nodeRuns).sort()).toEqual([
      'loadEnvelopeNonce',
      'set',
      'transition',
    ])
    const methods = [
      'read',
      'list',
      'listOutputs',
      'countAgentTextEvents',
      'readStderr',
      ...operations.filter((operation) => operation !== 'set' && operation !== 'transition'),
    ].sort()
    for (const purpose of purposes) {
      expect(Object.keys(f.views[purpose].nodeExecution).sort()).toEqual(methods)
      expect(Object.isFrozen(f.views[purpose])).toBe(true)
      expect(Object.isFrozen(f.views[purpose].nodeExecution)).toBe(true)
      expect(Object.isFrozen(f.views[purpose].nodeRuns)).toBe(true)
    }
    expect(Object.isFrozen(f.views)).toBe(true)
    expect(f.calls).toEqual({ newWork: 0, issuedAck: 0 })
    expectOriginalWork(f)
  })
})

// RFC-370 §9.2 V1: durable hosted execution binding + per-event journal on both
// engines, observed with the v3 platform contract. Interruptions are decided by
// the execution layer: a daemon shutdown or authority loss DETACHES (the remote
// subtask keeps running for the successor), a user cancel / node deadline sends
// one platform cancel and waits for the result, transient platform failures only
// delay, and an unobservable outcome (410, rejected request, identity mismatch)
// settles the binding as an explicit unknown so it never blocks a volume.
import { expect, test } from 'bun:test'
import { DAEMON_SHUTDOWN_ABORT_REASON } from '@agent-workflow/shared'
import { emptyDeclaredManifest } from '@/services/execution/agentInjection'
import { nodeRuns, tasks, workflows } from '@/db/schema'
import type {
  BusinessEvent,
  BusinessEventPage,
  BusinessSubtask,
  CrewStationBusinessExecution,
} from '@/platform/crewstation/businessExecution'
import { CrewStationApiError } from '@/platform/crewstation/platformApi'
import type { CrewStationMutationFence } from '@/platform/crewstation/mutationFence'
import { createDatabaseHostedExecutionControl } from '@/modules/system-operations/infrastructure/hostedExecutionControl'
import {
  createHostedExecutionStore,
  type HostedExecutionIntent,
} from '@/modules/task-execution/infrastructure/crewstation/executionStore'
import {
  createHostedExecution,
  HostedExecutionDetachedError,
  HostedExecutionUnknownError,
  type HostedExecutionSink,
} from '@/modules/task-execution/infrastructure/crewstation/execution'
import { createHostedExecutionSettler } from '@/modules/task-execution/infrastructure/crewstation/executionSettler'
import { describeEachProvider } from './helpers/eachProvider'

const lease = {
  epoch: 1,
  leaseId: '01a0bf5d-8f4b-7100-8000-000000000001',
  instanceId: '01a0bf5d-8f4b-7100-8000-000000000002',
}
const intent: HostedExecutionIntent = {
  executionId: 'run-1',
  taskId: 'task-1',
  businessTaskId: 'parent-1',
  requestKey: 'request-1',
  request: { kind: 'command', name: 'test', argv: ['echo', 'hello'] },
}
const receipt: BusinessSubtask = {
  id: 'subtask-1',
  taskId: 'parent-1',
  kind: 'command',
  attempt: 1,
  state: 'running',
  executionId: 'platform-execution-1',
}
const output = (cursor: string, text: string): BusinessEvent => ({
  taskId: 'parent-1',
  subtaskId: 'subtask-1',
  attempt: 1,
  cursor,
  sourceEventId: cursor,
  occurredAt: new Date(1000).toISOString(),
  type: 'output',
  data: { stream: 'stdout', text },
})
const result = (cursor = 'c2', reason = 'completed'): BusinessEvent => ({
  taskId: 'parent-1',
  subtaskId: 'subtask-1',
  attempt: 1,
  cursor,
  sourceEventId: cursor,
  occurredAt: new Date(1001).toISOString(),
  type: 'result',
  data: {
    exitCode: reason === 'completed' ? 0 : null,
    reason,
    stdout: '',
    stderr: '',
    truncated: false,
    finalCursor: cursor,
  },
})
const apiError = (status: number, message = `platform ${status}`) =>
  new CrewStationApiError(status, 'test', message, {})
const unused = async (): Promise<never> => {
  throw new Error('unexpected platform call')
}
/** Waits (without polling) until the observer's signal stops the stream. */
async function* idleUntilAbort(signal?: AbortSignal): AsyncGenerator<BusinessEvent> {
  if (signal !== undefined && !signal.aborted)
    await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve()))
  yield* []
}
function platform() {
  const submits: unknown[] = [],
    cancels: unknown[] = [],
    queries: unknown[] = []
  let pages: BusinessEventPage[] = []
  const api: CrewStationBusinessExecution = {
    createTask: unused,
    getTask: unused,
    closeTask: unused,
    pauseTask: unused,
    resumeTask: unused,
    listSubtasks: unused,
    createMaterial: unused,
    getSubtask: unused,
    readFile: unused,
    listFiles: unused,
    async submitSubtask(taskId, request) {
      submits.push({ taskId, request })
      return receipt
    },
    async cancelSubtask(taskId, subtaskId, request) {
      cancels.push({ taskId, subtaskId, request })
    },
    async events(taskId, query) {
      queries.push({ taskId, query })
      return pages.shift() ?? { items: [], hasMore: false, nextCursor: null }
    },
    async *streamEvents() {
      yield* []
      throw new Error('disconnected')
    },
  }
  return {
    api,
    submits,
    cancels,
    queries,
    pages(...items: readonly BusinessEvent[][]) {
      pages = items.map((events, index) => ({
        items: events,
        nextCursor: events.at(-1)?.cursor ?? null,
        hasMore: index < items.length - 1,
      }))
    },
  }
}
function sink() {
  const records: BusinessEvent[] = []
  const calls: string[] = []
  const consumer: HostedExecutionSink = {
    async started() {
      calls.push('started')
    },
    async event(event) {
      records.push(event)
      calls.push(event.cursor)
    },
    async checkpoint() {
      calls.push('checkpoint')
    },
  }
  return { consumer, records, calls }
}

describeEachProvider('RFC-370 hosted execution binding, journal and lifecycle', (harness) => {
  const setup = async () => {
    const control = createDatabaseHostedExecutionControl({ db: harness.db })
    for (const phase of ['preparing', 'active'] as const)
      await control.write({
        epoch: lease.epoch,
        owner: lease.instanceId,
        leaseId: lease.leaseId,
        phase,
        expiresAt: Date.now() + 60_000,
      })
    let authority = true
    const fence: CrewStationMutationFence = {
      current: () => {
        if (!authority) throw new Error('execution authority lost')
        return lease
      },
      assertHeld: (tx, value) => control.assertHeld(tx, value),
    }
    const store = createHostedExecutionStore({ db: harness.db, fence })
    const transport = platform()
    const execute = () =>
      createHostedExecution({
        api: transport.api,
        store,
        fence,
        sleep: async () => undefined,
        workspaceTaskId: async () => 'parent-1',
      })
    return {
      control,
      fence,
      store,
      transport,
      execute,
      loseAuthority: () => {
        authority = false
      },
    }
  }

  test('accepted Agent interpretation survives a cold store and cannot change under the original request key', async () => {
    const f = await setup()
    const original: HostedExecutionIntent = {
      ...intent,
      nodeRunId: 'run',
      request: {
        kind: 'agent',
        name: 'frozen',
        prompt: 'original prompt',
        agentProfileId: 'profile',
        materialId: 'material',
      },
      agentContext: {
        version: 1,
        protocol: 'opencode',
        startupInventory: true,
        declared: { ...emptyDeclaredManifest(), skills: ['original-skill'] },
        node: {
          id: 'run',
          nodeId: 'n1',
          iteration: 2,
          retryIndex: 3,
          containerRunId: 'frame',
          parentNodeRunId: null,
          shardKey: null,
          envelopeNonce: 'original-nonce',
          preSnapshot: 'original-git-snapshot',
        },
      },
    }
    await f.store.prepare(original)
    const cold = createHostedExecutionStore({ db: harness.db, fence: f.fence })
    expect((await cold.get(original.executionId))?.agentContext).toEqual(original.agentContext)
    await expect(
      cold.prepare({
        ...original,
        agentContext: {
          ...original.agentContext!,
          declared: { ...emptyDeclaredManifest(), skills: ['changed'] },
        },
      }),
    ).rejects.toThrow('hosted-execution-intent-mismatch')
    await expect(cold.prepare({ ...original, nodeRunId: 'other' })).rejects.toThrow(
      'hosted-agent-context-node-mismatch',
    )
    await expect(cold.prepare({ ...original, request: intent.request })).rejects.toThrow(
      'hosted-command-agent-context-invalid',
    )
    expect(f.transport.submits).toHaveLength(0)
    expect((await cold.get(original.executionId))?.agentContext?.node?.envelopeNonce).toBe(
      'original-nonce',
    )
  })

  test('ACK precedes events, every event is journaled with its cursor, replay never resubmits', async () => {
    const f = await setup(),
      first = sink()
    f.transport.pages([output('c1', 'hello')], [result()])
    const completed = await f.execute().run(intent, first.consumer)
    expect(first.calls[0]).toBe('started')
    expect(first.records.map((event) => event.cursor)).toEqual(['c1', 'c2'])
    expect(completed).toMatchObject({ timedOut: false, cancelled: false })
    expect(await f.store.get(intent.executionId)).toMatchObject({
      state: 'running',
      lastCursor: 'c2',
      result: { reason: 'completed' },
    })
    expect((await f.store.replay(intent.executionId)).map((event) => event.cursor)).toEqual([
      'c1',
      'c2',
    ])
    await completed.settle()
    const replay = sink()
    await f.execute().adopt(intent.executionId, replay.consumer)
    expect(replay.records.map((event) => event.cursor)).toEqual(['c1', 'c2'])
    expect(f.transport.submits).toHaveLength(1)
    expect((await f.store.get(intent.executionId))?.state).toBe('settled')
  })

  test('a lost submit response is retried with the original frozen request key', async () => {
    const f = await setup()
    let lost = 2
    f.transport.api.submitSubtask = async (_task, request) => {
      f.transport.submits.push(request)
      if (lost-- > 0) throw new Error('response lost after acceptance')
      return receipt
    }
    f.transport.pages([result()])
    const completed = await f.execute().run(intent, sink().consumer)
    expect(completed.result.reason).toBe('completed')
    expect(f.transport.submits).toEqual(
      Array.from({ length: 3 }, () => ({
        ...intent.request,
        requestKey: intent.requestKey,
        fence: lease,
      })),
    )
  })

  test('a parent paused before the submit is resumed and the same request repeated', async () => {
    const f = await setup()
    let refusals = 0
    const resumed: string[] = []
    f.transport.api.submitSubtask = async (_task, request) => {
      f.transport.submits.push(request)
      if (refusals < 2) {
        refusals += 1
        throw new CrewStationApiError(409, 'conflict', 'task paused', {
          code: refusals === 1 ? 'task_paused' : 'task_not_running',
        })
      }
      return receipt
    }
    f.transport.pages([result()])
    const completed = await createHostedExecution({
      api: f.transport.api,
      store: f.store,
      fence: f.fence,
      sleep: async () => undefined,
      workspaceTaskId: async () => 'parent-1',
      readyWorkspace: async (taskId) => {
        resumed.push(taskId)
      },
    }).run(intent, sink().consumer)
    expect(completed.result.reason).toBe('completed')
    expect(resumed).toEqual(['task-1', 'task-1'])
    expect(f.transport.submits).toHaveLength(3)
  })

  test('a rejected submission settles the binding as an explicit unknown outcome', async () => {
    const f = await setup()
    f.transport.api.submitSubtask = async () => {
      throw apiError(422, 'agent profile is not available')
    }
    await expect(f.execute().run(intent, sink().consumer)).rejects.toBeInstanceOf(
      HostedExecutionUnknownError,
    )
    expect(await f.store.get(intent.executionId)).toMatchObject({
      state: 'settled',
      result: { exitCode: null, truncated: true },
    })
    expect((await f.store.get(intent.executionId))?.result?.reason).toStartWith('abandoned:')
    expect(await f.store.unsettled()).toEqual([])
  })

  test('a projection failure keeps the journaled prefix and resumes after its durable cursor', async () => {
    const f = await setup()
    f.transport.pages([output('c1', 'kept')])
    await expect(
      f.execute().run(intent, {
        ...sink().consumer,
        async event() {
          throw new Error('projection crashed')
        },
      }),
    ).rejects.toThrow('projection crashed')
    // Journal first, projection second: the event is durable and is replayed.
    expect((await f.store.get(intent.executionId))?.lastCursor).toBe('c1')
    f.transport.pages([result()])
    const replay = sink()
    await f.execute().adopt(intent.executionId, replay.consumer)
    expect(replay.records.map((event) => event.cursor)).toEqual(['c1', 'c2'])
    expect(f.transport.queries.at(-1)).toEqual({
      taskId: 'parent-1',
      query: { after: 'c1', subtaskId: 'subtask-1' },
    })
    expect(f.transport.submits).toHaveLength(1)
  })

  test('cancel is durable and targets the acknowledged attempt even without a live observer', async () => {
    const f = await setup()
    await f.store.prepare(intent)
    await f.store.accepted(intent.executionId, receipt)
    await f.execute().cancel(intent.executionId)
    expect((await f.store.get(intent.executionId))?.cancelRequested).toBe(true)
    const cancel = {
      taskId: 'parent-1',
      subtaskId: 'subtask-1',
      request: { requestKey: 'request-1:cancel', expectedAttempt: 1, fence: lease },
    }
    expect(f.transport.cancels).toEqual([cancel])
    f.transport.pages([result('c2', 'cancelled')])
    const completed = await f.execute().adopt(intent.executionId, sink().consumer)
    expect(completed).toMatchObject({ cancelled: true, result: { reason: 'cancelled' } })
    // The adopting observer repeats the same idempotent platform cancel.
    expect(f.transport.cancels).toEqual([cancel, cancel])
    await completed.settle()
  })

  test('a daemon shutdown detaches: no platform cancel, the binding stays for the successor', async () => {
    const f = await setup()
    const shutdown = new AbortController()
    f.transport.api.streamEvents = async function* (_task, _query, signal) {
      shutdown.abort(DAEMON_SHUTDOWN_ABORT_REASON)
      yield* idleUntilAbort(signal)
    }
    await expect(f.execute().run(intent, sink().consumer, shutdown.signal)).rejects.toBeInstanceOf(
      HostedExecutionDetachedError,
    )
    expect(f.transport.cancels).toEqual([])
    expect(await f.store.get(intent.executionId)).toMatchObject({
      state: 'running',
      cancelRequested: false,
      result: null,
    })
    // The successor adopts the same subtask from the durable cursor.
    f.transport.pages([result()])
    const adopted = await f.execute().adopt(intent.executionId, sink().consumer)
    expect(adopted.result.reason).toBe('completed')
    expect(f.transport.submits).toHaveLength(1)
  })

  test('losing the execution authority detaches instead of failing the node', async () => {
    const f = await setup()
    f.transport.api.streamEvents = async function* () {
      f.loseAuthority()
      yield* []
      throw new Error('disconnected')
    }
    await expect(f.execute().run(intent, sink().consumer)).rejects.toBeInstanceOf(
      HostedExecutionDetachedError,
    )
    expect(f.transport.cancels).toEqual([])
  })

  test('a user abort sends one platform cancel and waits for the platform result', async () => {
    const f = await setup()
    const user = new AbortController()
    f.transport.api.streamEvents = async function* (_task, _query, signal) {
      if (f.transport.cancels.length === 0) {
        user.abort('user-cancel')
        yield* idleUntilAbort(signal)
        return
      }
      yield result('c9', 'cancelled')
    }
    const completed = await f.execute().run(intent, sink().consumer, user.signal)
    expect(completed).toMatchObject({ cancelled: true, result: { reason: 'cancelled' } })
    expect(f.transport.cancels).toHaveLength(1)
    expect((await f.store.get(intent.executionId))?.cancelReason).toBe('user')
  })

  test('a user abort before the platform receipt records the cancel and leaves it to settlement', async () => {
    const f = await setup()
    const user = new AbortController()
    user.abort('user-cancel')
    await expect(f.execute().run(intent, sink().consumer, user.signal)).rejects.toBeInstanceOf(
      HostedExecutionDetachedError,
    )
    expect(f.transport.submits).toEqual([])
    expect(await f.store.get(intent.executionId)).toMatchObject({
      state: 'submitting',
      cancelRequested: true,
      cancelReason: 'user',
    })
  })

  test('the node deadline cancels once and reports a timeout with the platform result', async () => {
    const f = await setup()
    f.transport.api.streamEvents = async function* (_task, _query, signal) {
      if (f.transport.cancels.length === 0) {
        yield* idleUntilAbort(signal)
        return
      }
      yield result('c3', 'cancelled')
    }
    const completed = await f.execute().run({ ...intent, timeoutMs: 0 }, sink().consumer)
    expect(completed).toMatchObject({ timedOut: true, result: { reason: 'cancelled' } })
    expect(f.transport.cancels).toHaveLength(1)
    expect((await f.store.get(intent.executionId))?.cancelReason).toBe('timeout')
  })

  test('cancellation arriving before ACK is applied to the acknowledged original attempt', async () => {
    const f = await setup(),
      submitted = Promise.withResolvers<void>(),
      ack = Promise.withResolvers<BusinessSubtask>()
    const execution = f.execute()
    f.transport.api.submitSubtask = async () => {
      submitted.resolve()
      return ack.promise
    }
    const running = execution.run(intent, sink().consumer)
    await submitted.promise
    expect(execution.observing(intent.executionId)).toBe(true)
    await execution.cancel(intent.executionId)
    expect(f.transport.cancels).toHaveLength(0)
    f.transport.pages([result('c1', 'cancelled')])
    ack.resolve(receipt)
    expect((await running).result.reason).toBe('cancelled')
    expect(f.transport.cancels).toHaveLength(1)
    expect(execution.observing(intent.executionId)).toBe(false)
  })

  test('a refused receipt cancels the remote run and leaves the binding to settlement', async () => {
    const f = await setup()
    await expect(
      f.execute().run(intent, {
        ...sink().consumer,
        async started() {
          throw new Error('caller fenced')
        },
      }),
    ).rejects.toBeInstanceOf(HostedExecutionUnknownError)
    expect(f.transport.cancels).toHaveLength(1)
    expect(await f.store.get(intent.executionId)).toMatchObject({
      state: 'running',
      cancelRequested: true,
      cancelReason: 'user',
    })
  })

  test('restart preserves the first cancellation cause', async () => {
    const f = await setup()
    await f.store.prepare(intent)
    await f.store.accepted(intent.executionId, receipt)
    await f.store.requestCancel(intent.executionId, 'timeout')
    await f.store.requestCancel(intent.executionId, 'user')
    f.transport.pages([result('c1', 'cancelled')])
    expect((await f.execute().adopt(intent.executionId, sink().consumer)).timedOut).toBe(true)
    expect((await f.store.get(intent.executionId))?.cancelReason).toBe('timeout')
  })

  test('a restored binding without a receipt is looked up by its request key, cancelled and settled', async () => {
    const f = await setup()
    await f.store.prepare(intent)
    await f.execute().cancel(intent.executionId, 'restored')
    expect(f.transport.cancels).toEqual([])
    f.transport.pages([result('c1', 'cancelled')])
    const stopped = await f.execute().adopt(intent.executionId, sink().consumer)
    expect(stopped).toMatchObject({ cancelled: true, result: { reason: 'cancelled' } })
    expect(f.transport.submits).toHaveLength(1)
    expect(f.transport.cancels).toHaveLength(1)
    expect((await f.store.get(intent.executionId))?.cancelReason).toBe('restored')
    await stopped.settle()
    expect(await f.store.unsettled()).toEqual([])
  })

  test('expired platform history settles the binding as an explicit unknown outcome', async () => {
    const f = await setup()
    await f.store.prepare(intent)
    await f.store.accepted(intent.executionId, receipt)
    f.transport.api.events = async () => {
      throw apiError(410, 'history expired')
    }
    await expect(f.execute().adopt(intent.executionId, sink().consumer)).rejects.toBeInstanceOf(
      HostedExecutionUnknownError,
    )
    const binding = await f.store.get(intent.executionId)
    expect(binding?.state).toBe('settled')
    expect(binding?.result?.reason).toStartWith('abandoned: expired')
    expect(binding?.result?.exitCode).toBeNull()
  })

  test('a result whose cursor is not its own is unknown, never a model result', async () => {
    const f = await setup()
    const bad = result()
    if (bad.type !== 'result') throw new Error('fixture')
    f.transport.pages([{ ...bad, data: { ...bad.data, finalCursor: 'missing-output' } }])
    await expect(f.execute().run(intent, sink().consumer)).rejects.toThrow('result cursor mismatch')
    expect((await f.store.get(intent.executionId))?.result?.reason).toStartWith(
      'abandoned: identity',
    )
    expect(await f.store.unsettled()).toEqual([])
  })

  test('transient platform failures only delay the observation', async () => {
    const f = await setup()
    const failures = [apiError(503), apiError(429), new Error('socket closed'), apiError(502)]
    f.transport.api.events = async (taskId, query) => {
      f.transport.queries.push({ taskId, query })
      const failure = failures.shift()
      if (failure !== undefined) throw failure
      return { items: [result()], hasMore: false, nextCursor: 'c2' }
    }
    const completed = await f.execute().run(intent, sink().consumer)
    expect(completed.result.reason).toBe('completed')
    expect(f.transport.queries).toHaveLength(5)
  })

  test('a retention gap is journaled and the observation continues to the platform result', async () => {
    const f = await setup(),
      consumer = sink()
    f.transport.pages(
      [
        {
          ...output('gap', ''),
          type: 'gap',
          data: { reason: 'retention-expired', earliestCursor: 'later' },
        },
      ],
      [result('c3')],
    )
    const completed = await f.execute().run(intent, consumer.consumer)
    expect(completed.result.reason).toBe('completed')
    expect(consumer.records.map((event) => event.type)).toEqual(['gap', 'result'])
    expect((await f.store.replay(intent.executionId)).map((event) => event.type)).toEqual([
      'gap',
      'result',
    ])
  })

  test('physical volume settlement includes inherited children and excludes other volumes', async () => {
    const f = await setup()
    await f.store.prepare({
      ...intent,
      executionId: 'child',
      taskId: 'logical-child',
      requestKey: 'child',
      request: {
        kind: 'command',
        name: 'child writer',
        argv: ['write'],
        cwd: '/work/shared/child',
      },
    })
    await f.store.prepare({
      ...intent,
      executionId: 'other',
      taskId: 'other-task',
      businessTaskId: 'other-parent',
      requestKey: 'other',
      request: { kind: 'command', name: 'other volume', argv: ['write'], cwd: '/work/shared' },
    })
    const execution = f.execute()
    expect(await execution.workspaceSettled('physical-parent', '/work/shared')).toBe(false)
    expect(await execution.workspaceSettled('physical-parent', '/work/unrelated')).toBe(true)
    await f.store.record('child', result('done'))
    await f.store.settle('child')
    expect(await execution.workspaceSettled('physical-parent', '/work/shared')).toBe(true)
    expect(f.transport.submits).toEqual([])
    expect(f.transport.cancels).toEqual([])
  })

  test('old epochs cannot journal, cancel or settle and phase cannot regress', async () => {
    const f = await setup()
    await f.store.prepare(intent)
    await expect(
      f.control.write({
        epoch: 1,
        owner: lease.instanceId,
        leaseId: lease.leaseId,
        phase: 'preparing',
        expiresAt: Date.now() + 60_000,
      }),
    ).rejects.toThrow('phase-regression')
    await f.control.write({
      epoch: 2,
      owner: 'successor',
      leaseId: 'new',
      phase: 'preparing',
      expiresAt: Date.now() + 60_000,
    })
    await expect(f.store.requestCancel(intent.executionId)).rejects.toThrow('epoch changed')
    await expect(f.store.record(intent.executionId, output('c1', 'late'))).rejects.toThrow(
      'epoch changed',
    )
    await expect(f.store.abandon(intent.executionId, 'late')).rejects.toThrow('epoch changed')
    await expect(f.store.settle(intent.executionId)).rejects.toThrow('epoch changed')
  })

  test('SSE disconnect refills after the last durable cursor without starting another attempt', async () => {
    const f = await setup(),
      consumer = sink()
    let streamed = 0
    f.transport.api.streamEvents = async function* () {
      streamed += 1
      yield output('c1', 'before disconnect')
      f.transport.pages([output('c2', 'after disconnect'), result('c3')])
      throw new Error('connection lost')
    }
    await f.execute().run(intent, consumer.consumer)
    expect(streamed).toBe(1)
    expect(consumer.records.map((event) => event.cursor)).toEqual(['c1', 'c2', 'c3'])
    expect(f.transport.queries.at(-1)).toEqual({
      taskId: 'parent-1',
      query: { subtaskId: 'subtask-1', after: 'c1' },
    })
    expect(f.transport.submits).toHaveLength(1)
  })

  test('a replay projection failure stays recoverable with the complete original journal', async () => {
    const f = await setup()
    f.transport.pages([output('c1', 'kept'), result()])
    await f.execute().run(intent, sink().consumer)
    await expect(
      f.execute().adopt(intent.executionId, {
        ...sink().consumer,
        async event() {
          throw new Error('replay consumer failed')
        },
      }),
    ).rejects.toThrow('replay consumer failed')
    expect(await f.store.replay(intent.executionId)).toHaveLength(2)
    expect((await f.store.get(intent.executionId))?.state).toBe('running')
  })

  test('one execution has at most one observer per process', async () => {
    const f = await setup()
    const execution = f.execute()
    const shutdown = new AbortController(),
      streaming = Promise.withResolvers<void>()
    f.transport.api.streamEvents = async function* (_task, _query, signal) {
      streaming.resolve()
      yield* idleUntilAbort(signal)
    }
    const running = execution.run(intent, sink().consumer, shutdown.signal)
    await streaming.promise
    expect(execution.observing(intent.executionId)).toBe(true)
    await expect(execution.adopt(intent.executionId, sink().consumer)).rejects.toThrow(
      'hosted-execution-observer-already-running',
    )
    shutdown.abort(DAEMON_SHUTDOWN_ABORT_REASON)
    await expect(running).rejects.toBeInstanceOf(HostedExecutionDetachedError)
  })
})

describeEachProvider('RFC-370 hosted execution settlement in the background', (harness) => {
  const snapshot = JSON.stringify({ $schema_version: 2, inputs: [], nodes: [], edges: [] })
  const current = { ...lease, epoch: 2 }
  const subtaskOf = (executionId: string): BusinessSubtask => ({
    ...receipt,
    id: `sub-${executionId}`,
  })
  const resultOf = (executionId: string, cursor: string, reason = 'completed'): BusinessEvent => {
    const event = result(cursor, reason)
    return { ...event, subtaskId: `sub-${executionId}` }
  }
  const setup = async () => {
    const control = createDatabaseHostedExecutionControl({ db: harness.db })
    for (const phase of ['preparing', 'active'] as const)
      await control.write({
        epoch: current.epoch,
        owner: lease.instanceId,
        leaseId: lease.leaseId,
        phase,
        expiresAt: Date.now() + 60_000,
      })
    const fence: CrewStationMutationFence = {
      current: () => current,
      assertHeld: (tx, value) => control.assertHeld(tx, value),
    }
    await harness.db.insert(workflows).values({
      id: 'workflow',
      name: 'hosted',
      definition: snapshot,
      version: 1,
      schemaVersion: 2,
    })
    await harness.db.insert(tasks).values({
      id: 'task-1',
      name: 'hosted',
      workflowId: 'workflow',
      workflowSnapshot: snapshot,
      workflowVersion: 1,
      repoPath: 'cs-workspace:task-1/repos/repo',
      worktreePath: 'cs-workspace:task-1/worktrees/task-1',
      baseBranch: 'main',
      branch: 'aw/task-1',
      status: 'running',
      inputs: '{}',
      startedAt: Date.now(),
    })
    await harness.db.insert(nodeRuns).values([
      { id: 'pending-run', taskId: 'task-1', nodeId: 'a', status: 'pending' },
      { id: 'canceled-run', taskId: 'task-1', nodeId: 'b', status: 'canceled' },
      { id: 'done-run', taskId: 'task-1', nodeId: 'c', status: 'done' },
    ])
    const store = createHostedExecutionStore({ db: harness.db, fence })
    const transport = platform()
    // One platform subtask per execution; each observation reads its own history.
    const histories = new Map<string, BusinessEvent[] | 'gone'>()
    transport.api.events = async (taskId, query) => {
      transport.queries.push({ taskId, query })
      const history = histories.get(query.subtaskId ?? '')
      if (history === 'gone') throw apiError(404, 'subtask not found')
      return { items: history ?? [], hasMore: false, nextCursor: null }
    }
    transport.api.cancelSubtask = async (taskId, subtaskId, request) => {
      transport.cancels.push({ taskId, subtaskId, request })
      if (histories.get(subtaskId) === 'gone') throw apiError(404, 'subtask not found')
    }
    const executions = createHostedExecution({
      api: transport.api,
      store,
      fence,
      sleep: async () => undefined,
      workspaceTaskId: async () => 'parent-1',
    })
    const logs: { level: string; message: string }[] = []
    const settler = createHostedExecutionSettler({
      db: harness.db,
      store,
      executions,
      fence,
      log: {
        info: (message: string) => logs.push({ level: 'info', message }),
        warn: (message: string) => logs.push({ level: 'warn', message }),
      },
    })
    const bind = async (
      executionId: string,
      extra: Partial<HostedExecutionIntent> = {},
      epoch = current.epoch,
    ) => {
      const writer =
        epoch === current.epoch
          ? store
          : createHostedExecutionStore({
              db: harness.db,
              fence: { current: () => ({ ...lease, epoch }), assertHeld: async () => undefined },
            })
      await writer.prepare({ ...intent, executionId, requestKey: executionId, ...extra })
      await writer.accepted(executionId, subtaskOf(executionId))
    }
    const history = (executionId: string, events: BusinessEvent[] | 'gone') =>
      histories.set(`sub-${executionId}`, events)
    return { store, transport, settler, logs, bind, history }
  }
  const pass = (settler: { pass(signal: AbortSignal): Promise<void> }) =>
    settler.pass(new AbortController().signal)

  test('a pending run keeps its execution for the scheduler; ended runs are cancelled or settled', async () => {
    const f = await setup()
    await f.bind('pending', { nodeRunId: 'pending-run' })
    await f.bind('canceled', { nodeRunId: 'canceled-run' })
    await f.bind('done', { nodeRunId: 'done-run' })
    await f.store.record('done', resultOf('done', 'c5'))
    f.history('canceled', [resultOf('canceled', 'c7', 'cancelled')])
    await pass(f.settler)
    expect(f.logs).toEqual([])
    // Only the canceled run's unconsumed execution is cancelled on the platform.
    expect(f.transport.cancels).toEqual([
      {
        taskId: 'parent-1',
        subtaskId: 'sub-canceled',
        request: { requestKey: 'canceled:cancel', expectedAttempt: 1, fence: current },
      },
    ])
    expect((await f.store.unsettled()).map((binding) => binding.executionId)).toEqual(['pending'])
    expect((await f.store.get('canceled'))?.result?.reason).toBe('cancelled')
    expect((await f.store.get('done'))?.result?.reason).toBe('completed')
  })

  test('restored bindings are always stopped and settled, even for a pending run', async () => {
    const f = await setup()
    await f.bind('restored', { nodeRunId: 'pending-run' })
    await f.store.requestCancel('restored', 'restored')
    f.history('restored', [resultOf('restored', 'c1', 'cancelled')])
    await pass(f.settler)
    expect(f.transport.cancels).toHaveLength(1)
    expect(await f.store.unsettled()).toEqual([])
  })

  test('ownerless executions from an earlier epoch are observed to their result, never cancelled', async () => {
    const f = await setup()
    await f.bind('earlier', {}, 1)
    await f.bind('current', {})
    f.history('earlier', [resultOf('earlier', 'c1')])
    await pass(f.settler)
    expect(f.transport.cancels).toEqual([])
    expect((await f.store.unsettled()).map((binding) => binding.executionId)).toEqual(['current'])
    expect((await f.store.get('earlier'))?.result?.reason).toBe('completed')
  })

  test('an unobservable execution is settled as unknown without blocking the others', async () => {
    const f = await setup()
    await f.bind('gone', { nodeRunId: 'canceled-run' })
    await f.bind('done', { nodeRunId: 'done-run' })
    await f.store.record('done', resultOf('done', 'c5'))
    f.history('gone', 'gone')
    await pass(f.settler)
    // The refused cancel is left to the observation, which reports the 404.
    expect(f.logs).toEqual([
      { level: 'info', message: 'hosted execution settled with an unknown outcome' },
    ])
    expect(await f.store.unsettled()).toEqual([])
    expect((await f.store.get('gone'))?.result?.reason).toStartWith('abandoned: rejected')
    expect((await f.store.get('done'))?.state).toBe('settled')
  })

  test('a daemon shutdown during settlement detaches without cancelling', async () => {
    const f = await setup()
    await f.bind('earlier', {}, 1)
    const shutdown = new AbortController()
    f.transport.api.streamEvents = async function* (_task, _query, signal) {
      shutdown.abort(DAEMON_SHUTDOWN_ABORT_REASON)
      yield* idleUntilAbort(signal)
    }
    await f.settler.pass(shutdown.signal)
    expect(f.transport.cancels).toEqual([])
    expect((await f.store.unsettled()).map((binding) => binding.executionId)).toEqual(['earlier'])
    expect(f.logs).toEqual([])
  })
})

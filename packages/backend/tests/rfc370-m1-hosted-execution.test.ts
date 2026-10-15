// RFC-370 v2 M1: actual durable binding/journal and fences on both engines;
// platform effects use the v3 contract, including loss of ACK and SSE reconnect.
import { expect, test } from 'bun:test'
import type {
  BusinessEvent,
  BusinessEventPage,
  BusinessSubtask,
  CrewStationBusinessExecution,
} from '@/platform/crewstation/businessExecution'
import type { CrewStationMutationFence } from '@/platform/crewstation/mutationFence'
import { createDatabaseHostedExecutionControl } from '@/modules/system-operations/infrastructure/hostedExecutionControl'
import {
  createHostedExecutionStore,
  type HostedExecutionIntent,
} from '@/modules/task-execution/infrastructure/crewstation/executionStore'
import {
  createHostedExecution,
  HostedExecutionUnknownError,
  type HostedExecutionSink,
} from '@/modules/task-execution/infrastructure/crewstation/execution'
import { createHostedWorkspaceHelper } from '@/modules/task-execution/infrastructure/crewstation/workspaceCommands'
import { WORKSPACE_RESULT_PREFIX } from '@/platform/crewstation/workspaceProtocol'
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
const unused = async (): Promise<never> => {
  throw new Error('unexpected platform call')
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

describeEachProvider('RFC-370 M1 hosted binding, replay and cancellation', (harness) => {
  const setup = async () => {
    const control = createDatabaseHostedExecutionControl({ db: harness.db })
    await control.write({
      epoch: lease.epoch,
      owner: lease.instanceId,
      leaseId: lease.leaseId,
      phase: 'preparing',
      expiresAt: Date.now() + 60_000,
    })
    await control.write({
      epoch: lease.epoch,
      owner: lease.instanceId,
      leaseId: lease.leaseId,
      phase: 'active',
      expiresAt: Date.now() + 60_000,
    })
    const fence: CrewStationMutationFence = {
      current: () => lease,
      assertHeld: (tx, value) => control.assertHeld(tx, value),
    }
    const store = createHostedExecutionStore({ db: harness.db, fence })
    const transport = platform()
    const execute = () =>
      createHostedExecution({ api: transport.api, store, fence, sleep: async () => undefined })
    return { control, fence, store, transport, execute }
  }

  test('ACK precedes events, terminal cursor includes all pages, replay never resubmits', async () => {
    const f = await setup(),
      first = sink()
    f.transport.pages([output('c1', 'hello')], [result()])
    const completed = await f.execute().run(intent, first.consumer)
    expect(first.calls[0]).toBe('started')
    expect(first.records.map((event) => event.cursor)).toEqual(['c1', 'c2'])
    expect((await f.store.get(intent.executionId))?.state).toBe('running')
    await completed.settle()
    const replay = sink()
    await f.execute().adopt(intent.executionId, replay.consumer)
    expect(replay.records.map((event) => event.cursor)).toEqual(['c1', 'c2'])
    expect(f.transport.submits).toHaveLength(1)
    expect((await f.store.get(intent.executionId))?.state).toBe('settled')
  })

  test('a lost submit response retries the original frozen request key after restart', async () => {
    const f = await setup()
    f.transport.api.submitSubtask = async (_task, request) => {
      f.transport.submits.push(request)
      throw new Error('response lost after acceptance')
    }
    await expect(f.execute().run(intent, sink().consumer)).rejects.toThrow('response lost')
    f.transport.api.submitSubtask = async (_task, request) => {
      f.transport.submits.push(request)
      return receipt
    }
    f.transport.pages([result()])
    await f.execute().adopt(intent.executionId, sink().consumer)
    expect(f.transport.submits).toEqual([
      { ...intent.request, requestKey: intent.requestKey, fence: lease },
      { ...intent.request, requestKey: intent.requestKey, fence: lease },
    ])
  })

  test('a projection failure retains a journal prefix and resumes from its durable cursor', async () => {
    const f = await setup()
    f.transport.pages([output('c1', 'kept')])
    await expect(
      f.execute().run(intent, {
        ...sink().consumer,
        async event() {
          throw new Error('projection crashed')
        },
      }),
    ).rejects.toBeInstanceOf(HostedExecutionUnknownError)
    expect((await f.store.get(intent.executionId))?.lastCursor).toBeNull()
    f.transport.pages([result()])
    const replay = sink()
    await f.execute().adopt(intent.executionId, replay.consumer)
    expect(replay.records.map((event) => event.cursor)).toEqual(['c1', 'c2'])
    expect(f.transport.queries.at(-1)).toEqual({
      taskId: 'parent-1',
      query: { after: 'c1', subtaskId: 'subtask-1' },
    })
  })

  test('cancel is durable and targets the acknowledged attempt even without a live observer', async () => {
    const f = await setup()
    await f.store.prepare(intent)
    await f.store.accepted(intent.executionId, receipt)
    await f.execute().cancel(intent.executionId)
    expect((await f.store.get(intent.executionId))?.cancelRequested).toBe(true)
    expect(f.transport.cancels).toEqual([
      {
        taskId: 'parent-1',
        subtaskId: 'subtask-1',
        request: { requestKey: 'request-1:cancel', expectedAttempt: 1, fence: lease },
      },
    ])
    f.transport.pages([result('c2', 'cancelled')])
    const completed = await f.execute().adopt(intent.executionId, sink().consumer)
    expect(completed.result.reason).toBe('cancelled')
    await completed.settle()
  })

  test('retention gaps and mismatched results remain unknown and do not settle', async () => {
    const f = await setup()
    const bad = result()
    if (bad.type !== 'result') throw new Error('fixture')
    f.transport.pages([{ ...bad, data: { ...bad.data, finalCursor: 'missing-output' } }])
    await expect(f.execute().run(intent, sink().consumer)).rejects.toThrow('result cursor mismatch')
    expect((await f.store.unsettled()).map((binding) => binding.executionId)).toEqual(['run-1'])
  })

  test('old epochs cannot append, cancel or settle and phase cannot regress', async () => {
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
    await expect(f.store.journal(intent.executionId, output('c1', 'late'))).rejects.toThrow(
      'epoch changed',
    )
    await expect(f.store.settle(intent.executionId)).rejects.toThrow('epoch changed')
  })

  test('workspace helper reconstructs its full result after a response/projection loss', async () => {
    const f = await setup()
    const helper = createHostedWorkspaceHelper({
      executions: f.execute(),
      workspace: { ensure: async () => ({ businessTaskId: 'parent-1' }) },
    })
    f.transport.pages([
      output('c1', 'log\n' + WORKSPACE_RESULT_PREFIX + '{"ok":true,"value":{"ok":7}}\n'),
      result(),
    ])
    expect(await helper.call('task-1', 'exists', {}, { operationId: 'same' })).toEqual({ ok: 7 })
    expect(await helper.call('task-1', 'exists', {}, { operationId: 'same' })).toEqual({ ok: 7 })
    expect(f.transport.submits).toHaveLength(1)
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

  test('a retention gap cannot be treated as a successful or failed model result', async () => {
    const f = await setup()
    f.transport.pages([
      {
        ...output('gap', ''),
        type: 'gap',
        data: { reason: 'retention-expired', earliestCursor: 'later' },
      },
    ])
    await expect(f.execute().run(intent, sink().consumer)).rejects.toThrow('retention-expired')
    expect((await f.store.get(intent.executionId))?.result).toBeNull()
    expect(await f.store.replay(intent.executionId)).toHaveLength(0)
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
    await execution.cancel(intent.executionId)
    expect(f.transport.cancels).toHaveLength(0)
    f.transport.pages([result('c1', 'cancelled')])
    ack.resolve(receipt)
    expect((await running).result.reason).toBe('cancelled')
    expect(f.transport.cancels).toHaveLength(1)
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
    ).rejects.toBeInstanceOf(HostedExecutionUnknownError)
    expect(await f.store.replay(intent.executionId)).toHaveLength(2)
  })

  test('workspace compensation recovers a lost materialization result without new submit', async () => {
    const f = await setup()
    const helper = createHostedWorkspaceHelper({
      executions: f.execute(),
      workspace: { ensure: async () => ({ businessTaskId: 'parent-1' }) },
    })
    expect(await helper.recover('task-1', 'missing')).toBeNull()
    f.transport.pages([
      output('c1', WORKSPACE_RESULT_PREFIX + '{"ok":true,"value":{"cleanup":"retained"}}\n'),
      result(),
    ])
    await helper.call('task-1', 'materialize-single', {}, { operationId: 'materialize' })
    expect(await helper.recover('task-1', 'materialize')).toEqual({
      value: { cleanup: 'retained' },
    })
    expect(f.transport.submits).toHaveLength(1)
  })
})

// RFC-379: dependency ordering, ready/health and shutdown-only stop budgets.
import { expect, test } from 'bun:test'
import { startOnExecutionActive } from '../src/cli/executionActivation'
import type { ExecutionFence } from '../src/modules/system-operations/public/participants'
import {
  createPollingDaemonRuntimeHandleFactory,
  createManagedWorkerRuntimeHandleFactory,
} from '../src/cli/daemonProviderRuntimeHandles'
import { deferred, runtimeSession, lifecycle } from './helpers/daemonLifecycle'

const factory = (id: string, dependsOn?: readonly string[]) => ({
  id,
  dependsOn,
  start: () => ({ stop() {}, drain() {} }),
})
for (const dependencies of [['missing'], ['second'], ['first']])
  test(`rejects non-earlier dependencies: ${dependencies}`, async () => {
    await expect(
      runtimeSession({ runtimeFactories: [factory('first', dependencies), factory('second')] }),
    ).rejects.toThrow('non-earlier')
  })
test('dependencies cross runtime/background boundary, ready waits, and receipts survive stop', async () => {
  const ready = deferred(),
    started = deferred()
  const session = await runtimeSession({
    runtimeFactories: [
      {
        id: 'first',
        start: () => {
          return {
            get ready() {
              started.resolve()
              return ready.promise
            },
            stop() {},
            drain() {},
          }
        },
      },
    ],
    backgroundWriterFactories: [factory('second', ['first'])],
  })
  const resume = session.resume(lifecycle)
  await started.promise
  expect(session.state().phase).toBe('frozen')
  expect(session.state().jobs[0]!.readyAt).toBeUndefined()
  ready.resolve()
  await resume
  await session.close({ reason: 'daemon-shutdown' })
  expect(session.state().jobs).toHaveLength(2)
  for (const job of session.state().jobs) {
    expect(job.readyAt).toBeGreaterThanOrEqual(job.startedAt)
    expect(job.stopOutcome).toBe('stopped')
    expect(job.stopDurationMs).toBeGreaterThanOrEqual(0)
  }
})
test('ready rejection rolls back the admitted handle', async () => {
  let stopped = false
  const session = await runtimeSession({
    runtimeFactories: [
      {
        id: 'bad',
        start: () => ({
          ready: Promise.reject(new Error('not ready')),
          stop() {
            stopped = true
          },
          drain() {},
        }),
      },
    ],
  })
  await expect(session.resume(lifecycle)).rejects.toThrow('not ready')
  expect(stopped).toBe(true)
})
for (const operation of ['stop', 'drain'] as const)
  test(`daemon shutdown bounds ${operation} and continues other closes`, async () => {
    const stuck = deferred()
    let closed = false
    const session = await runtimeSession({
      runtimeFactories: [
        {
          id: 'stuck',
          stopTimeoutMs: 15,
          start: () => ({
            stop: () => (operation === 'stop' ? stuck.promise : undefined),
            drain: () => (operation === 'drain' ? stuck.promise : undefined),
          }),
        },
      ],
      closeProvider() {
        closed = true
      },
    })
    await session.resume(lifecycle)
    await session.close({ reason: 'daemon-shutdown' })
    expect(closed).toBe(true)
    expect(session.state().jobs[0]).toMatchObject({ stopOutcome: 'timeout' })
    stuck.resolve()
  })
for (const operation of ['pause', 'switch'] as const)
  test(`${operation} waits beyond the shutdown budget`, async () => {
    const stuck = deferred(),
      stopping = deferred()
    let completed = false
    const session = await runtimeSession({
      runtimeFactories: [
        {
          id: 'slow',
          stopTimeoutMs: 1,
          start: () => ({
            stop: () => {
              stopping.resolve()
              return stuck.promise
            },
            drain() {},
          }),
        },
      ],
    })
    await session.resume(lifecycle)
    const waiting = (
      operation === 'pause'
        ? session.pause(lifecycle)
        : session.close({ reason: 'provider-switch' })
    ).then(() => {
      completed = true
    })
    await stopping.promise
    await new Promise((resolve) => setTimeout(resolve, 15))
    expect(completed).toBe(false)
    stuck.resolve()
    await waiting
    expect(session.state().jobs[0]!.stopOutcome).toBe('stopped')
  })
test('stop errors remain retryable and retain the provider', async () => {
  let closed = false
  const session = await runtimeSession({
    runtimeFactories: [
      {
        id: 'bad',
        start: () => ({
          stop() {
            throw new Error('stop failed')
          },
          drain() {},
        }),
      },
    ],
    closeProvider() {
      closed = true
    },
  })
  await session.resume(lifecycle)
  await expect(session.close({ reason: 'daemon-shutdown' })).rejects.toThrow('stop failed')
  expect(closed).toBe(false)
  expect(session.state().jobs[0]).toMatchObject({
    stopOutcome: 'error',
    error: 'Error: stop failed',
  })
})
test('polling health records errors and resets the consecutive failure streak after success', async () => {
  const failed = deferred(),
    recovered = deferred(),
    finish = deferred()
  let runs = 0
  const handle = await createPollingDaemonRuntimeHandleFactory({
    id: 'poll',
    intervalMs: 1,
    runImmediately: true,
    async run() {
      if (++runs === 1) throw new Error('tick failed')
      recovered.resolve()
      await finish.promise
    },
    onError() {
      failed.resolve()
    },
  }).start(lifecycle)
  await failed.promise
  expect(handle.health?.()).toMatchObject({
    consecutiveFailures: 1,
    lastError: 'Error: tick failed',
  })
  await recovered.promise
  finish.resolve()
  await handle.stop()
  await handle.drain()
  expect(handle.health?.()).toMatchObject({ consecutiveFailures: 0 })
  expect(handle.health?.().lastSuccessAt).toBeGreaterThan(0)
})
test('managed worker adapter forwards the worker health', async () => {
  const handle = await createManagedWorkerRuntimeHandleFactory({
    id: 'managed',
    stopReason: 'test',
    start: () => ({
      done: Promise.resolve(),
      stop: async () => {},
      health: () => ({ status: 'healthy', checkedAt: 'now' }),
    }),
  }).start(lifecycle)
  expect(handle.health?.()).toMatchObject({ status: 'healthy', checkedAt: 'now' })
  await handle.stop()
  await handle.drain()
})

// An activation wrapper must observe the real handle's readiness rejection.
test('deferred activation waits for ready and reports its failure', async () => {
  const active = deferred<ExecutionFence>(),
    failed = deferred<unknown>(),
    ready = deferred()
  let stopped = false
  const gated = startOnExecutionActive(
    { current: () => ({ kind: 'standby', reason: 'test' }), whenActive: () => active.promise },
    {
      id: 'deferred',
      start: () => ({
        ready: ready.promise,
        stop() {
          stopped = true
        },
        drain() {},
      }),
    },
    failed.resolve,
  )
  const handle = await gated.start(lifecycle)
  active.resolve({ epoch: 1 } as ExecutionFence)
  const error = new Error('activation readiness failed')
  ready.reject(error)
  expect(await failed.promise).toBe(error)
  await handle.stop('daemon-shutdown')
  await handle.drain()
  expect(stopped).toBe(true)
})

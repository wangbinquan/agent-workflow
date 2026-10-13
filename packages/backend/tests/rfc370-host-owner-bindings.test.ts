// RFC-370: the root must call each owner's loss policy and wait its original ACK.
import { expect, test } from 'bun:test'
import {
  bindAfterCommitHostOwner,
  bindIntentQueuedHostOwner,
  bindHumanGateContinuationHostOwner,
  bindMaintenanceHostOwner,
  bindTaskExecutionHostOwner,
} from '../src/cli/daemonHostExecutionOwners'
import { composeIntentQueuedResumption } from '@/modules/intent/composition/queuedResumption'
import { createHumanGateContinuationWorkerDefinition } from '@/modules/collaboration/application/humanGateContinuationWorker'
import type {
  TaskExecutionBackgroundControl,
  TaskExecutionBackgroundStartDependencies,
} from '@/modules/task-execution/composition/providerRuntime'
import type { ColdMaintenanceService } from '@/platform/background/maintenanceService'
import { createColdAfterCommitEventPump } from '@/platform/events/committed/afterCommitEventPump'
import {
  publishCommittedEventsAfterCommit,
  registerAfterCommitEventPump,
} from '@/platform/events/committed/runtime'
import { ConfigSchema, DEFAULT_CONFIG } from '@agent-workflow/shared'
import { deferred } from './helpers/taskHostExecution'

function unexpected(): never {
  throw new Error('unexpected native or cancellation path')
}

function grant() {
  let active = true
  const context = {
    generation: 'root-owner-generation',
    reference: Object.freeze({}),
    current() {
      expect(this).toBe(context)
      return active
    },
  }
  return {
    context,
    scope: {
      provider: 'sqlite' as const,
      generationId: context.generation,
      operationId: 'root-owner',
    },
    lose() {
      active = false
    },
  }
}

test('Human-gate owner retains unadmitted IDs after a delayed read and drains the actual continuation', async () => {
  const listEntered = deferred<void>(),
    listRelease = deferred<void>()
  const driveEntered = deferred<void>(),
    driveRelease = deferred<void>()
  const pending = [
    { taskId: 'human-first', continuationRef: 'continuation-first' },
    { taskId: 'human-second', continuationRef: 'continuation-second' },
  ]
  const driven: string[] = []
  const worker = createHumanGateContinuationWorkerDefinition({
    async listPending() {
      listEntered.resolve()
      await listRelease.promise
      return pending
    },
    async drive(continuation) {
      driven.push(continuation.continuationRef)
      driveEntered.resolve()
      await driveRelease.promise
    },
    onError: unexpected,
  })
  const binding = bindHumanGateContinuationHostOwner(worker.definition),
    first = grant()
  const handle = await binding.start(first)
  await listEntered.promise
  first.lose()
  await binding.quiesceAuthorityLoss({ context: first.context, handle })
  let drained = false
  const draining = Promise.resolve(
    binding.drainAuthorityLoss({ context: first.context, handle }),
  ).then(() => {
    drained = true
  })
  await expect(binding.start(grant())).rejects.toThrow('prior-lifetime-not-drained')
  expect(drained).toBe(false)
  listRelease.resolve()
  await draining
  expect(driven).toEqual([])
  const second = grant(),
    next = await binding.start(second)
  await driveEntered.promise
  // An old ACK must not make a newer in-flight lifetime replaceable.
  await binding.drainAuthorityLoss({ context: first.context, handle })
  await expect(binding.start(grant())).rejects.toThrow('prior-lifetime-not-drained')
  second.lose()
  await binding.quiesceAuthorityLoss({ context: second.context, handle: next })
  let nextDrained = false
  const nextDrain = Promise.resolve(
    binding.drainAuthorityLoss({ context: second.context, handle: next }),
  ).then(() => {
    nextDrained = true
  })
  await Promise.resolve()
  expect(nextDrained).toBe(false)
  expect(driven).toEqual(['continuation-first'])
  driveRelease.resolve()
  await nextDrain
  expect(driven).toEqual(['continuation-first'])
  expect(worker.definition.state()).toMatchObject({
    attempted: 1,
    completed: 1,
    failed: 0,
    running: false,
  })
})

test('Human-gate native runCycle still visits its full list and reports original errors', async () => {
  const failure = new Error('continuation failed')
  const driven: string[] = [],
    errors: unknown[] = []
  const worker = createHumanGateContinuationWorkerDefinition({
    listPending: async () => [
      { taskId: 'one', continuationRef: 'first' },
      { taskId: 'two', continuationRef: 'second' },
    ],
    async drive(continuation) {
      driven.push(continuation.continuationRef)
      if (continuation.taskId === 'one') throw failure
    },
    onError: (error) => {
      errors.push(error)
    },
  })
  expect(await worker.runCycle()).toEqual({ attempted: 2, completed: 1, failed: 1 })
  expect(driven).toEqual(['first', 'second'])
  expect(errors).toEqual([{ taskId: 'one', continuationRef: 'first', error: failure }])
})

test('Task owner keeps the same grant and awaits loss ACK without normal pause', async () => {
  const g = grant(),
    drain = deferred<void>()
  const calls: string[] = []
  const dependencies = Object.freeze({}) as TaskExecutionBackgroundStartDependencies
  const lifetime = {
    async pause() {
      calls.push('pause')
    },
    async quiesceAuthorityLoss() {
      expect(this).toBe(lifetime)
      calls.push('loss')
    },
    drain() {
      expect(this).toBe(lifetime)
      calls.push('drain')
      return drain.promise
    },
  }
  const background: TaskExecutionBackgroundControl = {
    start: unexpected,
    pause: unexpected,
    resume: unexpected,
    stop: unexpected,
    close: unexpected,
    awaitIdle: unexpected,
    quiesceAuthorityLoss: unexpected,
    async startAuthority(actualDependencies, authority) {
      expect(this).toBe(background)
      expect(actualDependencies).toBe(dependencies)
      expect(authority.recoveryGrant).toBe(g.context)
      expect(authority.current()).toBe(true)
      return lifetime
    },
  }
  const binding = bindTaskExecutionHostOwner({ background, dependencies })
  const handle = await binding.start(g)
  g.lose()
  await binding.quiesceAuthorityLoss({ handle, context: g.context })
  let acknowledged = false
  const waiting = Promise.resolve(binding.drainAuthorityLoss({ handle, context: g.context })).then(
    () => {
      acknowledged = true
    },
  )
  await Promise.resolve()
  expect(acknowledged).toBe(false)
  expect(calls).toEqual(['loss', 'drain'])
  drain.resolve()
  await waiting
  expect(acknowledged).toBe(true)
  expect(() => binding.quiesceAuthorityLoss({ handle, context: { ...g.context } })).toThrow(
    'daemon-host-owner-lifetime-mismatch:task-execution',
  )
})

test('Intent owner retains IDs when authority is lost during the actual configuration read', async () => {
  const first = grant(),
    entered = deferred<void>(),
    config = deferred<ReturnType<typeof ConfigSchema.parse>>()
  const dispatched = deferred<void>()
  const admitted: string[][] = []
  const resumption = composeIntentQueuedResumption({
    configuration: {
      async read() {
        entered.resolve()
        return config.promise
      },
    },
    async resume(ids) {
      admitted.push([...ids])
      dispatched.resolve()
    },
    onError: unexpected,
  })
  const binding = bindIntentQueuedHostOwner(resumption.runtimeFactory)
  const handle = await binding.start(first)
  resumption.enqueue(['pending-intent'])
  await entered.promise
  first.lose()
  await binding.quiesceAuthorityLoss({ handle, context: first.context })
  config.resolve(ConfigSchema.parse(DEFAULT_CONFIG))
  await binding.drainAuthorityLoss({ handle, context: first.context })
  expect(admitted).toEqual([])
  const second = grant()
  const next = await binding.start(second)
  await dispatched.promise
  await next.stop()
  await next.drain()
  expect(admitted).toEqual([['pending-intent']])
})

test('Maintenance loss uses cold owner quiesce and real drain, not bounded normal pause', async () => {
  const g = grant(),
    ack = deferred<void>(),
    calls: string[] = []
  const service: ColdMaintenanceService = {
    status: unexpected,
    reconfigure: unexpected,
    runSoon: unexpected,
    pause: unexpected,
    resume: unexpected,
    stop: unexpected,
    async start(context) {
      expect(this).toBe(service)
      expect(context).toBe(g.context)
      calls.push('start')
    },
    async quiesce(context) {
      expect(this).toBe(service)
      expect(context).toBe(g.context)
      calls.push('loss')
    },
    awaitDrained(context) {
      expect(this).toBe(service)
      expect(context).toBe(g.context)
      calls.push('drain')
      return ack.promise
    },
  }
  const binding = bindMaintenanceHostOwner(service)
  const handle = await binding.start(g)
  g.lose()
  await binding.quiesceAuthorityLoss({ handle, context: g.context })
  let done = false
  const pending = Promise.resolve(binding.drainAuthorityLoss({ handle, context: g.context })).then(
    () => {
      done = true
    },
  )
  await Promise.resolve()
  expect(done).toBe(false)
  expect(calls).toEqual(['start', 'loss', 'drain'])
  ack.resolve()
  await pending
  expect(done).toBe(true)
})

test('After-commit owner drains its accepted projection and leaves a newer registration intact', async () => {
  const g = grant(),
    entered = deferred<void>(),
    loaded = deferred<[]>()
  let nudges = 0
  const pump = createColdAfterCommitEventPump({
    persistence: {
      async getStored() {
        entered.resolve()
        return loaded.promise
      },
      claimNext: unexpected,
      accept: unexpected,
      reject: unexpected,
      retry: unexpected,
      deliveryPage: unexpected,
      health: unexpected,
    },
    codecs: { eventTypes: [], decode: unexpected },
    projectors: [],
    nudgeDispatcher() {
      nudges++
    },
  })
  const binding = bindAfterCommitHostOwner(pump)
  const handle = await binding.start(g)
  const publish = pump.publishNow([])
  await entered.promise
  const replacement = { async publishNow() {}, nudge() {} }
  registerAfterCommitEventPump(replacement)
  try {
    g.lose()
    await binding.quiesceAuthorityLoss({ handle, context: g.context })
    let done = false
    const draining = Promise.resolve(
      binding.drainAuthorityLoss({ handle, context: g.context }),
    ).then(() => {
      done = true
    })
    await Promise.resolve()
    expect(done).toBe(false)
    expect(await publishCommittedEventsAfterCommit([])).toBe(true)
    loaded.resolve([])
    await publish
    await draining
    expect(nudges).toBe(0)
    expect(done).toBe(true)
    expect(await publishCommittedEventsAfterCommit([])).toBe(true)
  } finally {
    loaded.resolve([])
    await publish
    registerAfterCommitEventPump(null)
  }
})

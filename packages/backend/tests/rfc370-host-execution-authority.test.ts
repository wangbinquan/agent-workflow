import { expect, test } from 'bun:test'
import {
  createHostExecutionAuthorityLifecycle,
  type CreateHostExecutionAuthorityLifecycleInput,
} from '../src/modules/system-operations/application/hostExecutionAuthority'
import type {
  HostExecutionAuthorityDriver,
  HostExecutionAuthorityObservation,
  HostExecutionAuthorityReference,
  HostExecutionPreparation,
  HostExecutionRecoveryFamily,
  HostExecutionRuntimeFamily,
} from '../src/modules/system-operations/application/ports/hostExecutionAuthority'

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((accept, refuse) => {
    resolve = accept
    reject = refuse
  })
  return { promise, resolve, reject }
}

const nextTurn = () => new Promise<void>((accept) => setImmediate(accept))

function harness(
  overrides: {
    readonly mode?: CreateHostExecutionAuthorityLifecycleInput['mode']
    readonly reference?: HostExecutionAuthorityReference
    readonly driver?: Partial<HostExecutionAuthorityDriver>
    readonly recovery?: Partial<HostExecutionRecoveryFamily>
    readonly runtime?: Partial<HostExecutionRuntimeFamily>
    readonly subscriptionClose?: () => void | Promise<void>
  } = {},
) {
  const events: string[] = []
  const failures: unknown[] = []
  const waiters = new Map<string, (() => void)[]>()
  const record = (event: string) => {
    events.push(event)
    for (const resolve of waiters.get(event) ?? []) resolve()
    waiters.delete(event)
  }
  const waitFor = (event: string): Promise<void> => {
    if (events.includes(event)) return Promise.resolve()
    return new Promise((resolve) => {
      waiters.set(event, [...(waiters.get(event) ?? []), resolve])
    })
  }
  const references = [
    overrides.reference ?? Object.freeze({}),
    Object.freeze({}),
    Object.freeze({}),
  ]
  let claimCount = 0
  let observer: Parameters<HostExecutionAuthorityDriver['subscribe']>[0] | undefined
  const prepared: HostExecutionPreparation = {
    kind: 'prepared',
    preparationDigest: 'durable-recovery-preparation',
    acceptedTaskContractVersions: ['task-intent:v1'],
    readyGroups: ['task'],
  }
  const driver: HostExecutionAuthorityDriver = Object.freeze<HostExecutionAuthorityDriver>({
    claim() {
      expect<HostExecutionAuthorityDriver>(this).toBe(driver)
      record('driver.claim')
      if (overrides.driver?.claim) return overrides.driver.claim.call(this)
      return { kind: 'granted', reference: references[claimCount++]! }
    },
    renew(reference) {
      expect<HostExecutionAuthorityDriver>(this).toBe(driver)
      record('driver.renew')
      return overrides.driver?.renew?.call(this, reference) ?? { kind: 'granted', reference }
    },
    activate(input) {
      expect<HostExecutionAuthorityDriver>(this).toBe(driver)
      record('driver.activate')
      expect(input.preparationDigest).toBe('durable-recovery-preparation')
      expect(input.acceptedTaskContractVersions).toEqual(['task-intent:v1'])
      return (
        overrides.driver?.activate?.call(this, input) ?? {
          kind: 'granted',
          reference: input.reference,
        }
      )
    },
    quiesce(input) {
      expect<HostExecutionAuthorityDriver>(this).toBe(driver)
      record(`driver.quiesce:${input.reason}`)
      return overrides.driver?.quiesce?.call(this, input)
    },
    release(reference) {
      expect<HostExecutionAuthorityDriver>(this).toBe(driver)
      record('driver.release')
      return overrides.driver?.release?.call(this, reference)
    },
    subscribe(input) {
      expect<HostExecutionAuthorityDriver>(this).toBe(driver)
      record('driver.subscribe')
      observer = input
      return (
        overrides.driver?.subscribe?.call(this, input) ??
        Object.freeze({
          close() {
            record('driver.subscription-close')
            return overrides.subscriptionClose?.()
          },
        })
      )
    },
  })
  const recovery: HostExecutionRecoveryFamily = Object.freeze<HostExecutionRecoveryFamily>({
    kind: overrides.recovery?.kind ?? 'durable-intent',
    prepare(context) {
      expect<HostExecutionRecoveryFamily>(this).toBe(recovery)
      record('recovery.prepare')
      return overrides.recovery?.prepare?.call(this, context) ?? prepared
    },
    quiesce(input) {
      expect<HostExecutionRecoveryFamily>(this).toBe(recovery)
      record(`recovery.quiesce:${input.reason}`)
      return overrides.recovery?.quiesce?.call(this, input)
    },
    drain(context) {
      expect<HostExecutionRecoveryFamily>(this).toBe(recovery)
      record('recovery.drain')
      return overrides.recovery?.drain?.call(this, context)
    },
  })
  const runtime: HostExecutionRuntimeFamily = Object.freeze<HostExecutionRuntimeFamily>({
    start(input) {
      expect<HostExecutionRuntimeFamily>(this).toBe(runtime)
      record('runtime.start')
      expect(input.groups).toEqual(['task'])
      return overrides.runtime?.start?.call(this, input)
    },
    quiesce(input) {
      expect<HostExecutionRuntimeFamily>(this).toBe(runtime)
      record(`runtime.quiesce:${input.reason}`)
      return overrides.runtime?.quiesce?.call(this, input)
    },
    drain(context) {
      expect<HostExecutionRuntimeFamily>(this).toBe(runtime)
      record('runtime.drain')
      return overrides.runtime?.drain?.call(this, context)
    },
  })
  const input: CreateHostExecutionAuthorityLifecycleInput = {
    generation: 'selected-provider-generation',
    mode: overrides.mode ?? 'execution',
    driver,
    recovery,
    runtime,
    onFailure(error) {
      failures.push(error)
    },
  }
  const lifecycle = createHostExecutionAuthorityLifecycle(input)
  return {
    lifecycle,
    input,
    references,
    events,
    failures,
    prepared,
    record,
    waitFor,
    observe(observation: HostExecutionAuthorityObservation) {
      if (!observer) throw new Error('test subscription not established')
      observer.onObservation(observation)
    },
  }
}

test('resource-only mode never claims, recovers or starts any execution group', async () => {
  const f = harness({ mode: 'resource-only' })
  await f.lifecycle.start()
  await f.lifecycle.renew()
  expect(f.lifecycle.queries.snapshot()).toEqual({
    phase: 'standby',
    generation: 'selected-provider-generation',
    readyGroups: [],
    reason: 'host-execution-resource-only',
  })
  expect(f.lifecycle.admission.acquire('task').kind).toBe('unavailable')
  expect(f.lifecycle.admission.acquire('purpose').kind).toBe('unavailable')
  await f.lifecycle.close()
  expect(f.events).toEqual([])
  expect(f.lifecycle.queries.snapshot().phase).toBe('closed')
})

test('admission opens only after subscribe, claim, recovery, activate and runtime ACKs', async () => {
  const subscribed = deferred<{ close(): void }>()
  const claimed = deferred<HostExecutionAuthorityObservation>()
  const recovered = deferred<HostExecutionPreparation>()
  const activated = deferred<HostExecutionAuthorityObservation>()
  const started = deferred<void>()
  const f = harness({
    driver: {
      subscribe: () => subscribed.promise,
      claim: () => claimed.promise,
      activate: () => activated.promise,
    },
    recovery: { prepare: () => recovered.promise },
    runtime: { start: () => started.promise },
  })
  const starting = f.lifecycle.start()
  await f.waitFor('driver.subscribe')
  expect(f.events).toEqual(['driver.subscribe'])
  expect(f.lifecycle.admission.acquire('task').kind).toBe('unavailable')
  subscribed.resolve({ close() {} })
  await f.waitFor('driver.claim')
  expect(f.events).not.toContain('recovery.prepare')
  claimed.resolve({ kind: 'granted', reference: f.references[0]! })
  await f.waitFor('recovery.prepare')
  expect(f.lifecycle.queries.snapshot().phase).toBe('preparing')
  recovered.resolve(f.prepared)
  await f.waitFor('driver.activate')
  expect(f.events).not.toContain('runtime.start')
  activated.resolve({ kind: 'granted', reference: f.references[0]! })
  await f.waitFor('runtime.start')
  expect(f.lifecycle.admission.acquire('task').kind).toBe('unavailable')
  started.resolve()
  await starting
  const admitted = f.lifecycle.admission.acquire('task')
  expect(admitted.kind).toBe('admitted')
  if (admitted.kind !== 'admitted') throw new Error('expected task admission')
  expect(admitted.lease.reference).toBe(f.references[0]!)
  admitted.lease.complete()
  expect(f.lifecycle.admission.acquire('purpose').kind).toBe('unavailable')
  await f.lifecycle.close()
})

test('opaque references and all selected method receivers remain intact', async () => {
  const reference = new Proxy(Object.freeze({}), {
    get() {
      throw new Error('reference fields must remain opaque')
    },
    ownKeys() {
      throw new Error('reference enumeration must remain opaque')
    },
  })
  const f = harness({ reference })
  await f.lifecycle.start()
  await f.lifecycle.renew()
  const admitted = f.lifecycle.admission.acquire('task')
  if (admitted.kind !== 'admitted') throw new Error('expected selected admission')
  expect(admitted.lease.reference).toBe(reference)
  admitted.lease.complete()
  await f.lifecycle.close()
  expect(f.failures).toEqual([])
})

test('close tracks a late claim grant and waits for its exact release ACK', async () => {
  const claimed = deferred<HostExecutionAuthorityObservation>()
  const released = deferred<void>()
  const f = harness({ driver: { claim: () => claimed.promise, release: () => released.promise } })
  const starting = f.lifecycle.start()
  await f.waitFor('driver.claim')
  let closed = false
  const closing = f.lifecycle.close().then(() => {
    closed = true
  })
  await f.waitFor('driver.subscription-close')
  expect(f.lifecycle.admission.acquire('task').kind).toBe('unavailable')
  claimed.resolve({ kind: 'granted', reference: f.references[0]! })
  await f.waitFor('driver.release')
  expect(closed).toBe(false)
  expect(f.events).not.toContain('recovery.prepare')
  expect(f.events).not.toContain('runtime.start')
  released.resolve()
  await starting
  await closing
  expect(f.lifecycle.queries.snapshot().phase).toBe('closed')
  expect(f.events.filter((x) => x === 'driver.release')).toHaveLength(1)
})

test('a late activate after loss is retired and a fresh grant must recover again', async () => {
  const activated = deferred<HostExecutionAuthorityObservation>()
  let activations = 0
  const f = harness({
    driver: {
      activate(input) {
        return activations++ === 0
          ? activated.promise
          : { kind: 'granted', reference: input.reference }
      },
    },
  })
  const starting = f.lifecycle.start()
  await f.waitFor('driver.activate')
  f.observe({ kind: 'lost', reason: 'selected-lease-lost' })
  expect(f.lifecycle.admission.acquire('task').kind).toBe('unavailable')
  activated.resolve({ kind: 'granted', reference: f.references[0]! })
  await starting
  await f.lifecycle.settled()
  expect(f.events).not.toContain('runtime.start')
  expect(f.events.filter((x) => x === 'driver.release')).toHaveLength(1)
  await f.lifecycle.start()
  expect(f.events.filter((x) => x === 'recovery.prepare')).toHaveLength(2)
  expect(f.events.filter((x) => x === 'runtime.start')).toHaveLength(1)
  expect(f.lifecycle.queries.snapshot().phase).toBe('active')
  await f.lifecycle.close()
})

test('close waits for a pending renew and never reopens that retired generation', async () => {
  const renewed = deferred<HostExecutionAuthorityObservation>()
  const f = harness({ driver: { renew: () => renewed.promise } })
  await f.lifecycle.start()
  const renewing = f.lifecycle.renew()
  await f.waitFor('driver.renew')
  let closed = false
  const closing = f.lifecycle.close().then(() => {
    closed = true
  })
  await f.waitFor('driver.subscription-close')
  await nextTurn()
  expect(closed).toBe(false)
  expect(f.lifecycle.admission.acquire('task').kind).toBe('unavailable')
  renewed.resolve({ kind: 'granted', reference: f.references[0]! })
  await renewing
  await closing
  expect(f.events.filter((x) => x === 'runtime.start')).toHaveLength(1)
  expect(f.events.filter((x) => x === 'driver.release')).toHaveLength(1)
})

test('a grant observed during subscription close is retired before close returns', async () => {
  const closeAck = deferred<void>()
  const f = harness({
    driver: { claim: () => ({ kind: 'standby', reason: 'standby-slot' }) },
    subscriptionClose: () => closeAck.promise,
  })
  await f.lifecycle.start()
  const closing = f.lifecycle.close().then(() => f.record('close.ack'))
  await f.waitFor('driver.subscription-close')
  f.observe({ kind: 'granted', reference: f.references[0]! })
  closeAck.resolve()
  await closing
  expect(f.events.indexOf('driver.release')).toBeLessThan(f.events.indexOf('close.ack'))
  expect(f.events.filter((x) => x === 'driver.release')).toHaveLength(1)
  expect(f.events).not.toContain('recovery.prepare')
  await f.lifecycle.settled()
})

test('loss synchronously stops new admission and waits for admitted owner completion', async () => {
  const f = harness()
  await f.lifecycle.start()
  const admitted = f.lifecycle.admission.acquire('task')
  if (admitted.kind !== 'admitted') throw new Error('expected owned task admission')
  f.observe({ kind: 'lost', reason: 'lost-during-task-write' })
  expect(f.lifecycle.admission.acquire('task').kind).toBe('unavailable')
  await expect(admitted.lease.stopped).resolves.toBe('authority-loss')
  const restarting = f.lifecycle.start()
  await f.waitFor('runtime.drain')
  await nextTurn()
  expect(f.events.filter((x) => x === 'driver.claim')).toHaveLength(1)
  expect(f.events).not.toContain('driver.release')
  admitted.lease.complete()
  admitted.lease.complete()
  await restarting
  expect(f.events.filter((x) => x === 'driver.claim')).toHaveLength(2)
  expect(f.events.filter((x) => x === 'driver.release')).toHaveLength(1)
  expect(f.events).toContain('runtime.quiesce:authority-loss')
  await f.lifecycle.close()
})

for (const failedStage of [
  'driver.quiesce',
  'runtime.quiesce',
  'recovery.quiesce',
  'runtime.drain',
  'recovery.drain',
  'driver.release',
  'subscription.close',
] as const) {
  test(`failed ${failedStage} ACK retries only unfinished retirement work`, async () => {
    const failure = new Error(`selected-${failedStage}-failed`)
    let remaining = true
    const failOnce = (stage: string) => {
      if (stage === failedStage && remaining) {
        remaining = false
        throw failure
      }
    }
    const f = harness({
      driver: {
        quiesce: () => failOnce('driver.quiesce'),
        release: () => failOnce('driver.release'),
      },
      recovery: {
        quiesce: () => failOnce('recovery.quiesce'),
        drain: () => failOnce('recovery.drain'),
      },
      runtime: {
        quiesce: () => failOnce('runtime.quiesce'),
        drain: () => failOnce('runtime.drain'),
      },
      subscriptionClose: () => failOnce('subscription.close'),
    })
    await f.lifecycle.start()
    await expect(f.lifecycle.close()).rejects.toBe(failure)
    expect(f.lifecycle.queries.snapshot().phase).toBe('draining')
    expect(f.lifecycle.admission.acquire('task').kind).toBe('unavailable')
    await f.lifecycle.close()
    expect(f.lifecycle.queries.snapshot().phase).toBe('closed')
    const calls: Record<string, string> = {
      'driver.quiesce': 'driver.quiesce:shutdown',
      'runtime.quiesce': 'runtime.quiesce:shutdown',
      'recovery.quiesce': 'recovery.quiesce:shutdown',
      'runtime.drain': 'runtime.drain',
      'recovery.drain': 'recovery.drain',
      'driver.release': 'driver.release',
      'subscription.close': 'driver.subscription-close',
    }
    for (const [stage, event] of Object.entries(calls)) {
      expect(f.events.filter((x) => x === event)).toHaveLength(stage === failedStage ? 2 : 1)
    }
  })
}

test('renewal failure closes admission and preserves the exact original error', async () => {
  const failure = new Error('selected-renewal-failed')
  const f = harness({
    driver: {
      renew() {
        throw failure
      },
    },
  })
  await f.lifecycle.start()
  await expect(f.lifecycle.renew()).rejects.toBe(failure)
  expect(f.lifecycle.queries.snapshot().phase).toBe('standby')
  expect(f.lifecycle.admission.acquire('task').kind).toBe('unavailable')
  expect(f.events).toContain('runtime.quiesce:authority-loss')
  await f.lifecycle.close()
})

test('recovery and release failures retain both facts and retry the exact unacknowledged release', async () => {
  const preparationFailure = new Error('selected-recovery-failed')
  const releaseFailure = new Error('selected-release-failed')
  let prepareFails = true
  let releaseFails = true
  const f = harness({
    recovery: {
      prepare() {
        if (prepareFails) {
          prepareFails = false
          throw preparationFailure
        }
        return f.prepared
      },
    },
    driver: {
      release() {
        if (releaseFails) {
          releaseFails = false
          throw releaseFailure
        }
      },
    },
  })
  const failure = await f.lifecycle.start().catch((error) => error as unknown)
  expect(failure).toBeInstanceOf(AggregateError)
  expect((failure as AggregateError).errors).toEqual([preparationFailure, releaseFailure])
  expect(f.events).not.toContain('runtime.start')
  await f.lifecycle.start()
  expect(f.events.filter((x) => x === 'driver.release')).toHaveLength(2)
  expect(f.events.filter((x) => x === 'recovery.quiesce:authority-loss')).toHaveLength(1)
  await f.lifecycle.close()
})

test('deferred recovery never activates the grant or starts an unadapted group', async () => {
  const f = harness({
    recovery: { prepare: () => ({ kind: 'deferred', reason: 'task-recovery-not-adapted' }) },
  })
  await f.lifecycle.start()
  expect(f.lifecycle.queries.snapshot()).toMatchObject({
    phase: 'standby',
    readyGroups: [],
    reason: 'task-recovery-not-adapted',
  })
  expect(f.events).not.toContain('driver.activate')
  expect(f.events).not.toContain('runtime.start')
  expect(f.events.filter((x) => x === 'driver.release')).toHaveLength(1)
  await f.lifecycle.close()
})

test('incomplete selected families fail before any driver or owner effect', () => {
  const f = harness()
  for (const name of ['claim', 'renew', 'activate', 'quiesce', 'release', 'subscribe'] as const) {
    expect(() =>
      createHostExecutionAuthorityLifecycle({
        ...f.input,
        driver: { ...f.input.driver, [name]: undefined },
      } as unknown as CreateHostExecutionAuthorityLifecycleInput),
    ).toThrow(`host-execution-authority-missing-${name}`)
  }
  for (const name of ['prepare', 'quiesce', 'drain'] as const) {
    expect(() =>
      createHostExecutionAuthorityLifecycle({
        ...f.input,
        recovery: { ...f.input.recovery, [name]: undefined },
      } as unknown as CreateHostExecutionAuthorityLifecycleInput),
    ).toThrow(`host-execution-recovery-missing-${name}`)
  }
  for (const name of ['start', 'quiesce', 'drain'] as const) {
    expect(() =>
      createHostExecutionAuthorityLifecycle({
        ...f.input,
        runtime: { ...f.input.runtime, [name]: undefined },
      } as unknown as CreateHostExecutionAuthorityLifecycleInput),
    ).toThrow(`host-execution-runtime-missing-${name}`)
  }
  expect(() =>
    createHostExecutionAuthorityLifecycle({
      ...f.input,
      mode: undefined,
    } as unknown as CreateHostExecutionAuthorityLifecycleInput),
  ).toThrow('host-execution-mode-missing')
  expect(f.events).toEqual([])
})

// SOURCE7-R1 F01: observations can replace a grant before its first adoption.
test('synchronous startup observations retire the replaced grant before starting only the latest grant', async () => {
  const first = Object.freeze({}),
    latest = Object.freeze({})
  const prepared: HostExecutionAuthorityReference[] = [],
    started: HostExecutionAuthorityReference[] = [],
    retired: HostExecutionAuthorityReference[] = []
  const f: ReturnType<typeof harness> = harness({
    driver: {
      subscribe(input) {
        input.onObservation({ kind: 'granted', reference: first })
        input.onObservation({ kind: 'granted', reference: first })
        input.onObservation({ kind: 'granted', reference: latest })
        input.onObservation({ kind: 'granted', reference: latest })
        return {
          close() {
            f.record('driver.subscription-close')
          },
        }
      },
      release(reference) {
        retired.push(reference)
      },
    },
    recovery: {
      prepare(context) {
        prepared.push(context.reference)
        return f.prepared
      },
    },
    runtime: {
      start({ context }) {
        expect(retired).toEqual([first])
        started.push(context.reference)
      },
    },
  })
  try {
    await f.lifecycle.start()
    await f.lifecycle.settled()
    expect(prepared).toEqual([latest])
    expect(started).toEqual([latest])
    expect(retired).toEqual([first])
    expect(f.events).not.toContain('driver.claim')
    expect(f.lifecycle.queries.snapshot()).toMatchObject({ phase: 'active', readyGroups: ['task'] })
  } finally {
    await f.lifecycle.close()
  }
  expect(retired).toEqual([first, latest])
})

test('a fresh observation during pending claim retires its distinct late response before the fresh grant starts', async () => {
  const late = Object.freeze({}),
    latest = Object.freeze({})
  const response = deferred<HostExecutionAuthorityObservation>()
  const started: HostExecutionAuthorityReference[] = [],
    retired: HostExecutionAuthorityReference[] = []
  const f = harness({
    driver: {
      claim() {
        return response.promise
      },
      release(reference) {
        retired.push(reference)
      },
    },
    runtime: {
      start({ context }) {
        expect(retired).toEqual([late])
        started.push(context.reference)
      },
    },
  })
  const starting = f.lifecycle.start()
  try {
    await f.waitFor('driver.claim')
    f.observe({ kind: 'granted', reference: latest })
    response.resolve({ kind: 'granted', reference: late })
    await starting
    await f.lifecycle.settled()
    expect(started).toEqual([latest])
    expect(retired).toEqual([late])
    expect(f.events.filter((event) => event === 'recovery.prepare')).toHaveLength(1)
    expect(f.lifecycle.queries.snapshot().phase).toBe('active')
  } finally {
    response.resolve({ kind: 'granted', reference: late })
    await starting
    await f.lifecycle.close()
  }
})

// SOURCE7-R1 F02: an observed grant must not survive a rejected startup control.
for (const stage of ['subscribe', 'claim'] as const) {
  for (const timing of ['sync', 'async'] as const) {
    test(`${timing} ${stage} failure retires its observed grant without recovery or runtime activation`, async () => {
      const failure = new Error(`startup-${stage}-${timing}-failed`)
      const reference = Object.freeze({})
      const fail = (): Promise<never> => {
        if (timing === 'async') return Promise.reject(failure)
        throw failure
      }
      const f: ReturnType<typeof harness> = harness({
        driver:
          stage === 'subscribe'
            ? {
                subscribe(input) {
                  input.onObservation({ kind: 'granted', reference })
                  return fail()
                },
              }
            : {
                claim() {
                  f.observe({ kind: 'granted', reference })
                  return fail()
                },
              },
      })
      try {
        let observed: unknown
        await f.lifecycle.start().catch((error: unknown) => {
          observed = error
        })
        await f.lifecycle.settled()
        expect(observed).toBe(failure)
        expect(f.lifecycle.queries.snapshot()).toMatchObject({ phase: 'standby', readyGroups: [] })
        expect(f.events).not.toContain('recovery.prepare')
        expect(f.events).not.toContain('driver.activate')
        expect(f.events).not.toContain('runtime.start')
        expect(f.events.filter((event) => event === 'driver.release')).toHaveLength(1)
      } finally {
        await f.lifecycle.close()
      }
    })
  }
}

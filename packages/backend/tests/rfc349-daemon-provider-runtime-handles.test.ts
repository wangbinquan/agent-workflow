import { describe, expect, test } from 'bun:test'

import {
  createLazyPausableDaemonRuntimeServiceBindings,
  createManagedWorkerRuntimeHandleFactory,
  createPausableDaemonRuntimeServiceBindings,
  createPollingDaemonRuntimeHandleFactory,
  type PausableDaemonRuntimeService,
} from '../src/cli/daemonProviderRuntimeHandles'
import type { DaemonProviderSessionLifecycleInput } from '../src/cli/daemonProviderSession'

const lifecycle: DaemonProviderSessionLifecycleInput = {
  operationId: 'operation-1',
  provider: 'postgresql',
  generationId: 'pg-1',
}

function deferred(): {
  readonly promise: Promise<void>
  readonly resolve: () => void
  readonly reject: (error: unknown) => void
} {
  let resolvePromise: (() => void) | undefined
  let rejectPromise: ((error: unknown) => void) | undefined
  const promise = new Promise<void>((resolve, reject) => {
    resolvePromise = resolve
    rejectPromise = reject
  })
  return {
    promise,
    resolve: () => resolvePromise?.(),
    reject: (error) => rejectPromise?.(error),
  }
}

describe('RFC-349 daemon provider runtime handle adapters', () => {
  test('signals a managed worker once and drains its exact done promise', async () => {
    const done = deferred()
    const stopCalls: Array<string | undefined> = []
    const receivedLifecycle: DaemonProviderSessionLifecycleInput[] = []
    const factory = createManagedWorkerRuntimeHandleFactory({
      id: 'committed-events',
      stopReason: 'provider-session-paused',
      start(input) {
        receivedLifecycle.push(input)
        return {
          stop(reason) {
            stopCalls.push(reason)
            return Promise.resolve()
          },
          done: done.promise,
        }
      },
    })

    const handle = await factory.start(lifecycle)
    const firstStop = handle.stop()
    const secondStop = handle.stop()

    expect(Object.isFrozen(factory)).toBe(true)
    expect(Object.isFrozen(handle)).toBe(true)
    expect(receivedLifecycle).toEqual([lifecycle])
    expect(firstStop).toBe(secondStop)
    await firstStop
    expect(stopCalls).toEqual(['provider-session-paused'])
    expect(handle.drain()).toBe(done.promise)

    done.resolve()
    await handle.drain()
  })

  test('does not signal a managed worker twice when its stop rejects', async () => {
    const stopError = new Error('worker-stop-failed')
    let stopCalls = 0
    const factory = createManagedWorkerRuntimeHandleFactory({
      id: 'human-gates',
      stopReason: 'provider-session-paused',
      start() {
        return {
          stop() {
            stopCalls += 1
            return Promise.reject(stopError)
          },
          done: Promise.resolve(),
        }
      },
    })
    const handle = await factory.start(lifecycle)

    const firstStop = handle.stop()
    const secondStop = handle.stop()
    expect(firstStop).toBe(secondStop)
    await expect(firstStop).rejects.toBe(stopError)
    await expect(secondStop).rejects.toBe(stopError)
    expect(stopCalls).toBe(1)
  })

  test('stops a polling runtime before its next tick and drains the exact in-flight tick', async () => {
    const inFlight = deferred()
    const started = deferred()
    const receivedLifecycle: DaemonProviderSessionLifecycleInput[] = []
    const factory = createPollingDaemonRuntimeHandleFactory({
      id: 'event-center',
      intervalMs: 60_000,
      runImmediately: true,
      async run(input) {
        receivedLifecycle.push(input)
        started.resolve()
        await inFlight.promise
      },
      onError() {},
    })
    const handle = await factory.start(lifecycle)
    await started.promise

    await handle.stop()
    let drained = false
    const drain = Promise.resolve(handle.drain()).then(() => {
      drained = true
    })
    await Promise.resolve()
    expect(drained).toBe(false)
    expect(receivedLifecycle).toEqual([lifecycle])

    inFlight.resolve()
    await drain
    expect(drained).toBe(true)
  })

  test('creates a fresh polling loop when the same provider session resumes', async () => {
    let ticks = 0
    const factory = createPollingDaemonRuntimeHandleFactory({
      id: 'digital-employee',
      intervalMs: 60_000,
      runImmediately: true,
      async run() {
        ticks += 1
      },
      onError() {},
    })

    const first = await factory.start(lifecycle)
    await first.stop()
    await first.drain()
    const second = await factory.start(lifecycle)
    await second.stop()
    await second.drain()

    expect(ticks).toBe(2)
  })

  test('freezes a pausable service and gives every resume an exact pause drain', async () => {
    const events: string[] = []
    const initialPause = deferred()
    const firstRuntimePause = deferred()
    const secondRuntimePause = deferred()
    const pauses = [initialPause, firstRuntimePause, secondRuntimePause]
    let pauseIndex = 0
    const service: PausableDaemonRuntimeService = {
      pause() {
        events.push(`pause:${pauseIndex}`)
        return pauses[pauseIndex++]!.promise
      },
      async resume() {
        events.push('resume')
      },
      async stop() {
        events.push('final-stop')
      },
    }

    const bindingPromise = createPausableDaemonRuntimeServiceBindings({
      runtimeId: 'maintenance',
      closeParticipantId: 'maintenance-close',
      service,
    })
    expect(events).toEqual(['pause:0'])
    initialPause.resolve()
    const bindings = await bindingPromise

    expect(Object.isFrozen(bindings)).toBe(true)
    expect(Object.isFrozen(bindings.runtimeFactory)).toBe(true)
    expect(Object.isFrozen(bindings.closeParticipant)).toBe(true)

    const firstHandle = await bindings.runtimeFactory.start(lifecycle)
    expect(events).toEqual(['pause:0', 'resume'])
    await expect(firstHandle.drain()).rejects.toMatchObject({
      code: 'daemon-provider-runtime-handle-drain-before-stop',
    })
    const firstStop = firstHandle.stop()
    expect(firstHandle.stop()).toBe(firstStop)
    expect(firstHandle.drain()).toBe(firstRuntimePause.promise)
    firstRuntimePause.resolve()
    await firstStop
    await firstHandle.drain()

    const secondHandle = await bindings.runtimeFactory.start(lifecycle)
    const secondStop = secondHandle.stop()
    expect(secondHandle.drain()).toBe(secondRuntimePause.promise)
    secondRuntimePause.resolve()
    await Promise.all([secondStop, secondHandle.drain()])
    expect(events).toEqual(['pause:0', 'resume', 'pause:1', 'resume', 'pause:2'])
  })

  test('keeps a lazily started service frozen until the provider session resumes', async () => {
    const events: string[] = []
    const service: PausableDaemonRuntimeService = {
      async pause() {
        events.push('pause')
      },
      async resume() {
        events.push('resume')
      },
      async stop() {
        events.push('stop')
      },
    }
    const bindings = createLazyPausableDaemonRuntimeServiceBindings({
      runtimeId: 'task-execution',
      closeParticipantId: 'task-execution-close',
      start() {
        events.push('start')
      },
      service,
    })

    expect(events).toEqual([])
    const first = await bindings.runtimeFactory.start(lifecycle)
    expect(events).toEqual(['start'])
    await first.stop()
    await first.drain()
    expect(events).toEqual(['start', 'pause'])

    const second = await bindings.runtimeFactory.start(lifecycle)
    expect(events).toEqual(['start', 'pause', 'resume'])
    await second.stop()
    await second.drain()
    await bindings.closeParticipant.close({
      reason: 'daemon-shutdown',
      provider: 'postgresql',
      generationId: 'pg-1',
    })
    expect(events).toEqual(['start', 'pause', 'resume', 'pause', 'stop'])
  })

  test('retries a failed service pause with a new exact drain promise', async () => {
    const retryDrain = deferred()
    let pauseCalls = 0
    const service: PausableDaemonRuntimeService = {
      pause() {
        pauseCalls += 1
        if (pauseCalls === 1) return Promise.resolve()
        if (pauseCalls === 2) return Promise.reject(new Error('maintenance-pause-failed'))
        return retryDrain.promise
      },
      resume: () => Promise.resolve(),
      stop: () => Promise.resolve(),
    }
    const bindings = await createPausableDaemonRuntimeServiceBindings({
      runtimeId: 'maintenance',
      closeParticipantId: 'maintenance-close',
      service,
    })
    const handle = await bindings.runtimeFactory.start(lifecycle)

    await expect(handle.stop()).rejects.toThrow('maintenance-pause-failed')
    await expect(handle.drain()).rejects.toMatchObject({
      code: 'daemon-provider-runtime-handle-drain-before-stop',
    })

    const retryStop = handle.stop()
    expect(handle.drain()).toBe(retryDrain.promise)
    retryDrain.resolve()
    await Promise.all([retryStop, handle.drain()])
    expect(pauseCalls).toBe(3)
  })

  test('retries final service stop after failure and never repeats it after success', async () => {
    let stopCalls = 0
    const service: PausableDaemonRuntimeService = {
      pause: () => Promise.resolve(),
      resume: () => Promise.resolve(),
      stop() {
        stopCalls += 1
        return stopCalls === 1
          ? Promise.reject(new Error('maintenance-stop-failed'))
          : Promise.resolve()
      },
    }
    const bindings = await createPausableDaemonRuntimeServiceBindings({
      runtimeId: 'maintenance',
      closeParticipantId: 'maintenance-close',
      service,
    })

    const firstAttempt = bindings.closeParticipant.close({
      reason: 'provider-switch',
      provider: 'postgresql',
      generationId: 'pg-1',
    })
    expect(
      bindings.closeParticipant.close({
        reason: 'provider-switch',
        provider: 'postgresql',
        generationId: 'pg-1',
      }),
    ).toBe(firstAttempt)
    await expect(firstAttempt).rejects.toThrow('maintenance-stop-failed')
    expect(stopCalls).toBe(1)

    await bindings.closeParticipant.close({
      reason: 'daemon-shutdown',
      provider: 'postgresql',
      generationId: 'pg-1',
    })
    await bindings.closeParticipant.close({
      reason: 'daemon-shutdown',
      provider: 'postgresql',
      generationId: 'pg-1',
    })
    expect(stopCalls).toBe(2)
  })
})

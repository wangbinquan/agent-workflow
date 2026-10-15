// RFC-349 — root-owned adapters from concrete worker/service lifetimes to the
// provider-session handle contract. Provider clients and business operations
// deliberately stay outside this module.

import type { DaemonProviderSessionLifecycleInput } from './daemonProviderSession'
import type {
  DaemonProviderCloseParticipant,
  DaemonProviderRuntimeHandle,
  DaemonProviderRuntimeHandleFactory,
} from './daemonProviderRuntimeSession'

type MaybePromise<T> = T | Promise<T>

export interface ManagedWorkerRuntime {
  readonly stop: (reason?: string) => Promise<void>
  readonly done: Promise<void>
}

export interface ManagedWorkerRuntimeHandleFactoryInput {
  readonly id: string
  readonly stopReason: string
  readonly start: (input: DaemonProviderSessionLifecycleInput) => MaybePromise<ManagedWorkerRuntime>
}

export interface PausableDaemonRuntimeService {
  readonly pause: () => Promise<void>
  readonly resume: () => Promise<void>
  readonly stop: () => Promise<void>
}

export interface PausableDaemonRuntimeServiceBindings {
  readonly runtimeFactory: DaemonProviderRuntimeHandleFactory
  readonly closeParticipant: DaemonProviderCloseParticipant
}

export interface PollingDaemonRuntimeHandleFactoryInput {
  readonly id: string
  readonly intervalMs: number
  readonly runImmediately?: boolean
  readonly beforeStart?: (input: DaemonProviderSessionLifecycleInput) => MaybePromise<void>
  readonly run: (input: DaemonProviderSessionLifecycleInput) => Promise<void>
  readonly onError: (
    error: unknown,
    input: DaemonProviderSessionLifecycleInput,
  ) => MaybePromise<void>
}

export class DaemonProviderRuntimeHandleAdapterError extends Error {
  constructor(
    public readonly code: 'daemon-provider-runtime-handle-drain-before-stop',
    message: string,
  ) {
    super(message)
    this.name = 'DaemonProviderRuntimeHandleAdapterError'
  }
}

function invokeAsPromise(operation: () => Promise<void>): Promise<void> {
  try {
    return operation()
  } catch (error) {
    return Promise.reject(error)
  }
}

/**
 * Adapt a `startManagedWorkerDefinition`-style lifetime. Stopping signals the
 * exact worker once; draining is always the worker's original `done` promise.
 */
export function createManagedWorkerRuntimeHandleFactory(
  input: ManagedWorkerRuntimeHandleFactoryInput,
): DaemonProviderRuntimeHandleFactory {
  return Object.freeze({
    id: input.id,
    async start(lifecycleInput: DaemonProviderSessionLifecycleInput) {
      const worker = await input.start(lifecycleInput)
      let stopPromise: Promise<void> | null = null

      const handle: DaemonProviderRuntimeHandle = {
        stop() {
          if (stopPromise === null) {
            stopPromise = invokeAsPromise(() => worker.stop(input.stopReason))
          }
          return stopPromise
        },
        drain() {
          return worker.done
        },
      }
      return Object.freeze(handle)
    },
  })
}

function waitForPollingInterval(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise<void>((resolve) => {
    let settled = false
    const settle = (): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal.removeEventListener('abort', settle)
      resolve()
    }
    const timer = setTimeout(settle, ms)
    signal.addEventListener('abort', settle, { once: true })
  })
}

/**
 * Own one provider-bound best-effort polling loop. Aborting prevents the next
 * tick, while `drain` awaits the exact in-flight tick before provider close.
 * A resumed provider session receives a fresh controller and loop instance.
 */
export function createPollingDaemonRuntimeHandleFactory(
  input: PollingDaemonRuntimeHandleFactoryInput,
): DaemonProviderRuntimeHandleFactory {
  if (!Number.isSafeInteger(input.intervalMs) || input.intervalMs <= 0) {
    throw new Error(`daemon polling runtime ${input.id} interval must be a positive integer`)
  }

  return Object.freeze({
    id: input.id,
    async start(lifecycleInput: DaemonProviderSessionLifecycleInput) {
      await input.beforeStart?.(lifecycleInput)
      const controller = new AbortController()
      const done = (async (): Promise<void> => {
        if (input.runImmediately !== true) {
          await waitForPollingInterval(input.intervalMs, controller.signal)
        }
        while (!controller.signal.aborted) {
          try {
            await input.run(lifecycleInput)
          } catch (error) {
            await input.onError(error, lifecycleInput)
          }
          await waitForPollingInterval(input.intervalMs, controller.signal)
        }
      })()
      let stopped = false
      return Object.freeze({
        stop() {
          if (!stopped) {
            stopped = true
            controller.abort('daemon-provider-runtime-paused')
          }
        },
        drain() {
          if (!stopped) {
            return Promise.reject(
              new DaemonProviderRuntimeHandleAdapterError(
                'daemon-provider-runtime-handle-drain-before-stop',
                `daemon provider runtime handle ${input.id} cannot drain before stop`,
              ),
            )
          }
          return done
        },
      } satisfies DaemonProviderRuntimeHandle)
    },
  })
}

export interface PausableDaemonRuntimeServiceBindingsInput {
  readonly runtimeId: string
  readonly closeParticipantId: string
  readonly service: PausableDaemonRuntimeService
}

export interface LazyPausableDaemonRuntimeServiceBindingsInput extends Omit<
  PausableDaemonRuntimeServiceBindingsInput,
  'service'
> {
  /** Bind/start the provider-owned service on the first session resume only. */
  readonly start: () => MaybePromise<void>
  readonly service: PausableDaemonRuntimeService
}

/**
 * Freeze an already-composed service, then bind each provider-session resume
 * to a fresh terminal handle. A failed pause or final stop is retryable; a
 * successful final stop is never repeated.
 */
export async function createPausableDaemonRuntimeServiceBindings(
  input: PausableDaemonRuntimeServiceBindingsInput,
): Promise<PausableDaemonRuntimeServiceBindings> {
  await input.service.pause()

  const runtimeFactory: DaemonProviderRuntimeHandleFactory = Object.freeze({
    id: input.runtimeId,
    async start() {
      await input.service.resume()
      let pausePromise: Promise<void> | null = null

      const handle: DaemonProviderRuntimeHandle = {
        stop() {
          if (pausePromise !== null) return pausePromise

          const attempt = invokeAsPromise(() => input.service.pause())
          pausePromise = attempt
          void attempt.then(
            () => undefined,
            () => {
              if (pausePromise === attempt) pausePromise = null
            },
          )
          return attempt
        },
        drain() {
          if (pausePromise === null) {
            return Promise.reject(
              new DaemonProviderRuntimeHandleAdapterError(
                'daemon-provider-runtime-handle-drain-before-stop',
                `daemon provider runtime handle ${input.runtimeId} cannot drain before stop`,
              ),
            )
          }
          return pausePromise
        },
      }
      return Object.freeze(handle)
    },
  })

  let stopped = false
  let stopPromise: Promise<void> | null = null
  const closeParticipant: DaemonProviderCloseParticipant = Object.freeze({
    id: input.closeParticipantId,
    close() {
      if (stopped) return Promise.resolve()
      if (stopPromise !== null) return stopPromise

      const attempt = invokeAsPromise(() => input.service.stop())
      stopPromise = attempt
      void attempt.then(
        () => {
          stopped = true
        },
        () => {
          if (stopPromise === attempt) stopPromise = null
        },
      )
      return attempt
    },
  })

  return Object.freeze({ runtimeFactory, closeParticipant })
}

/**
 * Adapt a provider service whose composition is side-effect free but whose
 * first `start` binds runtime dependencies and admits work.  The provider
 * session factory can therefore return a genuinely frozen candidate: the
 * first controller resume calls `start`, later rollbacks call `resume`, and
 * final close is the only terminal `stop`.
 */
export function createLazyPausableDaemonRuntimeServiceBindings(
  input: LazyPausableDaemonRuntimeServiceBindingsInput,
): PausableDaemonRuntimeServiceBindings {
  let started = false
  let stopped = false

  const runtimeFactory: DaemonProviderRuntimeHandleFactory = Object.freeze({
    id: input.runtimeId,
    async start() {
      if (stopped) throw new Error(`daemon provider runtime ${input.runtimeId} is stopped`)
      if (!started) {
        await input.start()
        started = true
      } else {
        await input.service.resume()
      }

      let pausePromise: Promise<void> | null = null
      const handle: DaemonProviderRuntimeHandle = Object.freeze({
        stop() {
          if (pausePromise !== null) return pausePromise
          const attempt = invokeAsPromise(() => input.service.pause())
          pausePromise = attempt
          void attempt.then(
            () => undefined,
            () => {
              if (pausePromise === attempt) pausePromise = null
            },
          )
          return attempt
        },
        drain() {
          if (pausePromise === null) {
            return Promise.reject(
              new DaemonProviderRuntimeHandleAdapterError(
                'daemon-provider-runtime-handle-drain-before-stop',
                `daemon provider runtime handle ${input.runtimeId} cannot drain before stop`,
              ),
            )
          }
          return pausePromise
        },
      })
      return handle
    },
  })

  let stopPromise: Promise<void> | null = null
  const closeParticipant: DaemonProviderCloseParticipant = Object.freeze({
    id: input.closeParticipantId,
    close() {
      if (stopped) return Promise.resolve()
      if (stopPromise !== null) return stopPromise
      const attempt = invokeAsPromise(() => input.service.stop())
      stopPromise = attempt
      void attempt.then(
        () => {
          stopped = true
        },
        () => {
          if (stopPromise === attempt) stopPromise = null
        },
      )
      return attempt
    },
  })

  return Object.freeze({ runtimeFactory, closeParticipant })
}

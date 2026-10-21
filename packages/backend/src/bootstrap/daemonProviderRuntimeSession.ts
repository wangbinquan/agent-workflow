// RFC-349 — concrete root-owned lifetime for one provider composition.
//
// The session exposes only HTTP/WS delegates to the daemon listener. Provider
// clients stay captured by the factories and close callbacks supplied by the
// composition root; they never cross this boundary in the runtime payload.

import type {
  DaemonProviderKind,
  DaemonProviderSessionLifecycleInput,
  ManagedDaemonProviderSession,
} from './daemonProviderSession'

import { createLogger } from '@/util/log'

const log = createLogger('daemon-runtime')

type MaybePromise<T> = T | Promise<T>

export type DaemonProviderUpgradeResult = true | false | Response

/** Closed delegate surface read dynamically through controller.current(). */
export interface DaemonProviderRuntimePayload<
  UpgradeServer = unknown,
  WebSocketHandlers = unknown,
> {
  readonly fetch: (request: Request) => MaybePromise<Response>
  readonly tryUpgrade: (
    request: Request,
    server: UpgradeServer,
  ) => MaybePromise<DaemonProviderUpgradeResult>
  readonly websocketHandlers: WebSocketHandlers
}

export interface DaemonProviderRuntimeAdmission {
  /** Writers stay closed until every runtime handle has started successfully. */
  readonly closeWriterAdmission: () => MaybePromise<void>
  readonly openWriterAdmission: () => MaybePromise<void>
  /** Existing sockets are fenced/drained by the adapter behind this callback. */
  readonly closeWebSocketAdmission: () => MaybePromise<void>
  readonly openWebSocketAdmission: () => MaybePromise<void>
}

/**
 * A handle is single-use. `stop` terminally signals this exact handle and
 * `drain` proves its admitted work has settled. A later resume invokes the
 * factory again and receives a new handle.
 */
export interface DaemonProviderRuntimeHandle {
  readonly ready?: Promise<void>
  readonly health?: () => DaemonJobHealth
  readonly stop: (reason?: 'provider-switch' | 'daemon-shutdown') => MaybePromise<void>
  readonly drain: () => MaybePromise<void>
}

export interface DaemonProviderRuntimeHandleFactory {
  readonly id: string
  readonly dependsOn?: readonly string[]
  readonly stopTimeoutMs?: number
  /** Must not admit work before returning its handle. */
  readonly start: (
    input: DaemonProviderSessionLifecycleInput,
  ) => MaybePromise<DaemonProviderRuntimeHandle>
}

export interface DaemonProviderCloseParticipant {
  readonly id: string
  readonly close: (input: {
    readonly reason: 'provider-switch' | 'daemon-shutdown'
    readonly provider: DaemonProviderKind
    readonly generationId: string
  }) => MaybePromise<void>
}

export type DaemonProviderRuntimeSessionPhase = 'frozen' | 'running' | 'closing' | 'closed'

export interface DaemonJobHealth {
  readonly lastRunAt?: number
  readonly lastSuccessAt?: number
  readonly lastError?: string
  readonly consecutiveFailures?: number
  readonly status?: string
  readonly checkedAt?: string
  readonly reason?: string
}
export interface DaemonBootStepReceipt {
  readonly id: string
  readonly phase: 'prepare' | 'execution-recovery' | 'post-ready'
  readonly outcome: 'ok' | 'failed' | 'skipped' | 'running' | 'abandoned'
  readonly durationMs: number
  readonly error?: string
}
export interface DaemonJobReceipt {
  readonly id: string
  startedAt: number
  readyAt?: number
  stoppedAt?: number
  stopOutcome?: 'stopped' | 'timeout' | 'error'
  stopDurationMs?: number
  error?: string
  health?: DaemonJobHealth
}
export interface DaemonProviderRuntimeSessionState {
  readonly phase: DaemonProviderRuntimeSessionPhase
  readonly activeHandleIds: readonly string[]
  readonly jobs: readonly DaemonJobReceipt[]
  readonly steps: readonly DaemonBootStepReceipt[]
}

export interface DaemonProviderRuntimeSession<
  UpgradeServer = unknown,
  WebSocketHandlers = unknown,
> extends ManagedDaemonProviderSession {
  /** No provider client is present on this deliberately closed payload. */
  readonly runtime: DaemonProviderRuntimePayload<UpgradeServer, WebSocketHandlers>
  readonly state: () => DaemonProviderRuntimeSessionState
  readonly postReady: () => Promise<void>
}

export interface CreateDaemonProviderRuntimeSessionInput<
  UpgradeServer = unknown,
  WebSocketHandlers = unknown,
> {
  readonly provider: DaemonProviderKind
  readonly generationId: string
  readonly runtime: DaemonProviderRuntimePayload<UpgradeServer, WebSocketHandlers>
  readonly admission: DaemonProviderRuntimeAdmission
  /** Started first and stopped after all background writers. */
  readonly runtimeFactories?: readonly DaemonProviderRuntimeHandleFactory[]
  /** Started after runtime services and therefore stopped first. */
  readonly backgroundWriterFactories?: readonly DaemonProviderRuntimeHandleFactory[]
  /** Executed in declaration order after every handle has drained. */
  readonly providerCloseParticipants?: readonly DaemonProviderCloseParticipant[]
  readonly readyOnResume?: boolean
  readonly beforeResume?: () => MaybePromise<void>
  readonly beforeClose?: (reason: 'provider-switch' | 'daemon-shutdown') => MaybePromise<void>
  readonly bootSteps?: () => readonly DaemonBootStepReceipt[]
  readonly postReady?: () => Promise<void>
  readonly shutdownIdentity: () => MaybePromise<void>
  readonly closeProvider: () => MaybePromise<void>
}

export class DaemonProviderRuntimeSessionError extends Error {
  constructor(
    public readonly code:
      | 'daemon-provider-runtime-session-mismatch'
      | 'daemon-provider-runtime-session-closing',
    message: string,
  ) {
    super(message)
    this.name = 'DaemonProviderRuntimeSessionError'
  }
}

interface ActiveHandle {
  readonly id: string
  readonly handle: DaemonProviderRuntimeHandle
  stopped: boolean
  drained: boolean
  readonly timeoutMs: number
  readonly receipt: DaemonJobReceipt
  stopStartedAt?: number
}

interface CloseParticipantProgress {
  readonly participant: DaemonProviderCloseParticipant
  closed: boolean
}

function lifecycleFailure(message: string, failures: readonly unknown[]): unknown {
  if (failures.length === 1) return failures[0]
  return new AggregateError(failures, message)
}

export function validateDaemonJobFactories(
  factories: readonly DaemonProviderRuntimeHandleFactory[],
): void {
  const declared = new Set<string>()
  for (const factory of factories) {
    if (declared.has(factory.id)) throw new Error(`duplicate daemon job: ${factory.id}`)
    for (const dependency of factory.dependsOn ?? []) {
      if (!declared.has(dependency))
        throw new Error(`daemon job ${factory.id} depends on non-earlier job ${dependency}`)
    }
    if (
      factory.stopTimeoutMs !== undefined &&
      (!Number.isFinite(factory.stopTimeoutMs) || factory.stopTimeoutMs < 0)
    )
      throw new Error(`invalid daemon stop timeout: ${factory.id}`)
    declared.add(factory.id)
  }
}

/**
 * Create one fully composed but frozen provider session. The initial admission
 * close is awaited before the session can enter the controller.
 */
export async function createDaemonProviderRuntimeSession<UpgradeServer, WebSocketHandlers>(
  input: CreateDaemonProviderRuntimeSessionInput<UpgradeServer, WebSocketHandlers>,
): Promise<DaemonProviderRuntimeSession<UpgradeServer, WebSocketHandlers>> {
  const handleFactories = [
    ...(input.runtimeFactories ?? []),
    ...(input.backgroundWriterFactories ?? []),
  ]
  validateDaemonJobFactories(handleFactories)
  const jobs: DaemonJobReceipt[] = []
  const closeProgress: CloseParticipantProgress[] = (input.providerCloseParticipants ?? []).map(
    (participant) => ({ participant, closed: false }),
  )

  const runtime = Object.freeze({
    fetch: input.runtime.fetch,
    tryUpgrade: input.runtime.tryUpgrade,
    websocketHandlers: input.runtime.websocketHandlers,
  })

  let phase: DaemonProviderRuntimeSessionPhase = 'frozen'
  let activeHandles: ActiveHandle[] = []
  let writerAdmissionMayBeOpen = true
  let webSocketAdmissionMayBeOpen = true
  let identityShutdown = false
  let providerClosed = false
  let lifecycleTail: Promise<void> = Promise.resolve()

  const serialize = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = lifecycleTail.then(operation, operation)
    lifecycleTail = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  const assertLifecycleMatches = (lifecycleInput: DaemonProviderSessionLifecycleInput): void => {
    if (
      lifecycleInput.provider !== input.provider ||
      lifecycleInput.generationId !== input.generationId
    ) {
      throw new DaemonProviderRuntimeSessionError(
        'daemon-provider-runtime-session-mismatch',
        `daemon provider runtime ${input.provider}/${input.generationId} does not match requested ${lifecycleInput.provider}/${lifecycleInput.generationId}`,
      )
    }
  }

  const closeAdmissions = async (): Promise<unknown[]> => {
    const failures: unknown[] = []
    if (writerAdmissionMayBeOpen) {
      try {
        await input.admission.closeWriterAdmission()
        writerAdmissionMayBeOpen = false
      } catch (error) {
        failures.push(error)
      }
    }
    if (webSocketAdmissionMayBeOpen) {
      try {
        await input.admission.closeWebSocketAdmission()
        webSocketAdmissionMayBeOpen = false
      } catch (error) {
        failures.push(error)
      }
    }
    return failures
  }

  const bounded = async (work: () => MaybePromise<void>, ms: number): Promise<boolean> => {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        Promise.resolve()
          .then(work)
          .then(() => true),
        new Promise<false>((resolve) => {
          timer = setTimeout(() => resolve(false), Math.max(0, ms))
        }),
      ])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }
  const stopAndDrainHandles = async (
    reason?: 'provider-switch' | 'daemon-shutdown',
  ): Promise<unknown[]> => {
    const failures: unknown[] = []
    const attempt = async (active: ActiveHandle, work: () => MaybePromise<void>) => {
      active.stopStartedAt ??= Date.now()
      try {
        const completed =
          reason === 'daemon-shutdown'
            ? await bounded(work, active.timeoutMs - (Date.now() - active.stopStartedAt))
            : (await work(), true)
        if (!completed) {
          active.receipt.stopOutcome = 'timeout'
          active.stopped = true
          active.drained = true
        }
        return completed
      } catch (error) {
        active.receipt.stopOutcome = 'error'
        active.receipt.error = String(error)
        failures.push(error)
        return false
      } finally {
        active.receipt.stopDurationMs = Date.now() - active.stopStartedAt
      }
    }
    for (const active of [...activeHandles].reverse()) {
      if (!active.stopped && (await attempt(active, () => active.handle.stop(reason))))
        active.stopped = true
    }
    for (const active of [...activeHandles].reverse()) {
      if (active.stopped && !active.drained && (await attempt(active, () => active.handle.drain())))
        active.drained = true
      if (active.drained) {
        active.receipt.stoppedAt = Date.now()
        active.receipt.stopOutcome ??= 'stopped'
        log.info('lifecycle job stopped', { ...active.receipt })
      }
    }
    activeHandles = activeHandles.filter((active) => !active.stopped || !active.drained)
    return failures
  }

  const freezeRuntime = async (
    reason?: 'provider-switch' | 'daemon-shutdown',
  ): Promise<unknown[]> => {
    const failures = await closeAdmissions()
    failures.push(...(await stopAndDrainHandles(reason)))
    return failures
  }

  const closeFrozenComposition = async (reason: 'provider-switch' | 'daemon-shutdown') => {
    for (const progress of closeProgress) {
      if (progress.closed) continue
      const close = () =>
        progress.participant.close({
          reason,
          provider: input.provider,
          generationId: input.generationId,
        })
      if (reason === 'daemon-shutdown') {
        // A timed-out service must not re-enter its unbounded final stop wait.
        const runtimeId = progress.participant.id.replace(/-final-close$/, '')
        const timedOut = jobs.some((job) => job.id === runtimeId && job.stopOutcome === 'timeout')
        const completed = await bounded(close, timedOut ? 0 : 10_000)
        if (!completed) log.warn('lifecycle close timeout', { id: progress.participant.id })
      } else await close()
      progress.closed = true
    }
    if (!identityShutdown) {
      await input.shutdownIdentity()
      identityShutdown = true
    }
    if (!providerClosed) {
      await input.closeProvider()
      providerClosed = true
    }
  }

  // No session is returned when the initial admission fence fails, so there is
  // no later retry owner. Attempt every cleanup stage now while preserving the
  // same provider-participants -> identity -> provider ordering as close().
  const disposeRejectedComposition = async (
    reason: 'provider-switch' | 'daemon-shutdown',
  ): Promise<unknown[]> => {
    const failures: unknown[] = []
    for (const progress of closeProgress) {
      if (progress.closed) continue
      try {
        await progress.participant.close({
          reason,
          provider: input.provider,
          generationId: input.generationId,
        })
        progress.closed = true
      } catch (error) {
        failures.push(error)
      }
    }
    if (!identityShutdown) {
      try {
        await input.shutdownIdentity()
        identityShutdown = true
      } catch (error) {
        failures.push(error)
      }
    }
    if (!providerClosed) {
      try {
        await input.closeProvider()
        providerClosed = true
      } catch (error) {
        failures.push(error)
      }
    }
    return failures
  }

  const initialFreezeFailures = await closeAdmissions()
  if (initialFreezeFailures.length > 0) {
    initialFreezeFailures.push(...(await disposeRejectedComposition('provider-switch')))
    throw lifecycleFailure(
      'failed to freeze initial daemon provider runtime session',
      initialFreezeFailures,
    )
  }

  const session: DaemonProviderRuntimeSession<UpgradeServer, WebSocketHandlers> = {
    provider: input.provider,
    generationId: input.generationId,
    runtime,
    state: () =>
      Object.freeze({
        phase,
        activeHandleIds: Object.freeze(activeHandles.map(({ id }) => id)),
        jobs: jobs.map((receipt) => {
          const active = activeHandles.find((handle) => handle.receipt === receipt)
          return {
            ...receipt,
            ...(active?.handle.health === undefined ? {} : { health: active.handle.health() }),
          }
        }),
        steps: input.bootSteps?.() ?? [],
      }),

    postReady: () =>
      phase === 'closing' || phase === 'closed'
        ? Promise.resolve()
        : (input.postReady?.() ?? Promise.resolve()),

    pause(lifecycleInput) {
      return serialize(async () => {
        assertLifecycleMatches(lifecycleInput)
        if (phase === 'closing' || phase === 'closed') {
          throw new DaemonProviderRuntimeSessionError(
            'daemon-provider-runtime-session-closing',
            `cannot pause daemon provider runtime while ${phase}`,
          )
        }
        const failures = await freezeRuntime()
        phase = 'frozen'
        if (failures.length > 0) {
          throw lifecycleFailure('failed to pause daemon provider runtime session', failures)
        }
      })
    },

    resume(lifecycleInput) {
      return serialize(async () => {
        assertLifecycleMatches(lifecycleInput)
        if (phase === 'closing' || phase === 'closed') {
          throw new DaemonProviderRuntimeSessionError(
            'daemon-provider-runtime-session-closing',
            `cannot resume daemon provider runtime while ${phase}`,
          )
        }
        if (phase === 'running') return

        // A prior failed rollback may still own a handle or an admission gate.
        // Settle that exact generation before any factory can start again.
        const staleFailures = await freezeRuntime()
        if (staleFailures.length > 0) {
          throw lifecycleFailure(
            'failed to settle daemon provider runtime before resume',
            staleFailures,
          )
        }

        try {
          await input.beforeResume?.()
          for (const factory of handleFactories) {
            const receipt: DaemonJobReceipt = { id: factory.id, startedAt: Date.now() }
            const handle = await factory.start(lifecycleInput)
            jobs.push(receipt)
            activeHandles.push({
              id: factory.id,
              handle,
              stopped: false,
              drained: false,
              timeoutMs: factory.stopTimeoutMs ?? 10_000,
              receipt,
            })
            await handle.ready
            receipt.readyAt = Date.now()
          }
          webSocketAdmissionMayBeOpen = true
          await input.admission.openWebSocketAdmission()
          writerAdmissionMayBeOpen = true
          await input.admission.openWriterAdmission()
          phase = 'running'
          if (input.readyOnResume) await input.postReady?.()
        } catch (error) {
          const rollbackFailures = await freezeRuntime()
          phase = 'frozen'
          if (rollbackFailures.length === 0) throw error
          throw new AggregateError(
            [error, ...rollbackFailures],
            'failed to resume daemon provider runtime session and roll back started handles',
          )
        }
      })
    },

    close({ reason }) {
      return serialize(async () => {
        if (phase === 'closed') return
        phase = 'closing'
        await input.beforeClose?.(reason)
        const freezeFailures = await freezeRuntime(reason)
        if (freezeFailures.length > 0) {
          throw lifecycleFailure(
            'failed to freeze daemon provider runtime session for close',
            freezeFailures,
          )
        }
        await closeFrozenComposition(reason)
        phase = 'closed'
      })
    },
  }

  return Object.freeze(session)
}

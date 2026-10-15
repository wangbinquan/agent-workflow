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
  readonly stop: () => MaybePromise<void>
  readonly drain: () => MaybePromise<void>
}

export interface DaemonProviderRuntimeHandleFactory {
  readonly id: string
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

export interface DaemonProviderRuntimeSessionState {
  readonly phase: DaemonProviderRuntimeSessionPhase
  readonly activeHandleIds: readonly string[]
}

export interface DaemonProviderRuntimeSession<
  UpgradeServer = unknown,
  WebSocketHandlers = unknown,
> extends ManagedDaemonProviderSession {
  /** No provider client is present on this deliberately closed payload. */
  readonly runtime: DaemonProviderRuntimePayload<UpgradeServer, WebSocketHandlers>
  readonly state: () => DaemonProviderRuntimeSessionState
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
}

interface CloseParticipantProgress {
  readonly participant: DaemonProviderCloseParticipant
  closed: boolean
}

function lifecycleFailure(message: string, failures: readonly unknown[]): unknown {
  if (failures.length === 1) return failures[0]
  return new AggregateError(failures, message)
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

  const stopAndDrainHandles = async (): Promise<unknown[]> => {
    const failures: unknown[] = []
    for (let index = activeHandles.length - 1; index >= 0; index -= 1) {
      const active = activeHandles[index]!
      if (active.stopped) continue
      try {
        await active.handle.stop()
        active.stopped = true
      } catch (error) {
        failures.push(error)
      }
    }
    for (let index = activeHandles.length - 1; index >= 0; index -= 1) {
      const active = activeHandles[index]!
      if (!active.stopped || active.drained) continue
      try {
        await active.handle.drain()
        active.drained = true
      } catch (error) {
        failures.push(error)
      }
    }
    activeHandles = activeHandles.filter((active) => !active.stopped || !active.drained)
    return failures
  }

  const freezeRuntime = async (): Promise<unknown[]> => {
    const failures = await closeAdmissions()
    failures.push(...(await stopAndDrainHandles()))
    return failures
  }

  const closeFrozenComposition = async (reason: 'provider-switch' | 'daemon-shutdown') => {
    for (const progress of closeProgress) {
      if (progress.closed) continue
      await progress.participant.close({
        reason,
        provider: input.provider,
        generationId: input.generationId,
      })
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
      }),

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
          for (const factory of handleFactories) {
            const handle = await factory.start(lifecycleInput)
            activeHandles.push({ id: factory.id, handle, stopped: false, drained: false })
          }
          webSocketAdmissionMayBeOpen = true
          await input.admission.openWebSocketAdmission()
          writerAdmissionMayBeOpen = true
          await input.admission.openWriterAdmission()
          phase = 'running'
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
        const freezeFailures = await freezeRuntime()
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

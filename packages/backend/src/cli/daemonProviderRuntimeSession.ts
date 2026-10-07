// RFC-349 — concrete root-owned lifetime for one provider composition.
//
// The session exposes only HTTP/WS delegates to the daemon listener. Provider
// clients stay captured by the factories and close callbacks supplied by the
// composition root; they never cross this boundary in the runtime payload.

import type { DaemonExecutionRuntimeControl } from '@/modules/system-operations/composition/daemonExecutionRuntime'
import type {
  HostExecutionGrantContext,
  HostExecutionGroup,
  HostExecutionRuntimeFamily,
} from '@/modules/system-operations/public/participants'
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

/** The root pairs every actual handle with its owner and loss-specific ACKs. */
export interface DaemonProviderHostExecutionHandleBinding {
  readonly id: string
  readonly group: HostExecutionGroup
  readonly start: (input: {
    readonly scope: DaemonProviderSessionLifecycleInput
    readonly context: HostExecutionGrantContext
  }) => MaybePromise<DaemonProviderRuntimeHandle>
  readonly quiesceAuthorityLoss: (input: {
    readonly handle: DaemonProviderRuntimeHandle
    readonly context: HostExecutionGrantContext
  }) => MaybePromise<void>
  readonly drainAuthorityLoss: (input: {
    readonly handle: DaemonProviderRuntimeHandle
    readonly context: HostExecutionGrantContext
  }) => MaybePromise<void>
}

export interface DaemonProviderHostExecutionRuntimeSelection {
  readonly handles: readonly DaemonProviderHostExecutionHandleBinding[]
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
  /** Pause execution handles independently of the resource HTTP/WS delegates. */
  readonly execution: DaemonExecutionRuntimeControl
  /** Present only for the complete selection supplied by the actual root. */
  readonly hostExecutionRuntime?: HostExecutionRuntimeFamily
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
  readonly hostExecutionRuntime?: DaemonProviderHostExecutionRuntimeSelection
  /** Executed in declaration order after every handle has drained. */
  readonly providerCloseParticipants?: readonly DaemonProviderCloseParticipant[]
  readonly shutdownIdentity: () => MaybePromise<void>
  readonly closeProvider: () => MaybePromise<void>
}

export class DaemonProviderRuntimeSessionError extends Error {
  constructor(
    public readonly code:
      | 'daemon-provider-runtime-session-mismatch'
      | 'daemon-provider-runtime-session-closing'
      | 'daemon-provider-execution-unavailable',
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
  readonly authority?: {
    readonly binding: DaemonProviderHostExecutionHandleBinding
    readonly context: HostExecutionGrantContext
  }
  stopMode?: 'normal' | 'authority-loss'
  stopAcknowledgedMode?: 'normal' | 'authority-loss'
  drainAcknowledgedMode?: 'normal' | 'authority-loss'
}

interface CloseParticipantProgress {
  readonly participant: DaemonProviderCloseParticipant
  closed: boolean
}

function lifecycleFailure(message: string, failures: readonly unknown[]): unknown {
  if (failures.length === 1) return failures[0]
  return new AggregateError(failures, message)
}

function stoppedForCurrentMode(active: ActiveHandle): boolean {
  return active.authority === undefined
    ? active.stopped
    : active.stopMode !== undefined && active.stopAcknowledgedMode === active.stopMode
}

function drainedForCurrentMode(active: ActiveHandle): boolean {
  return active.authority === undefined
    ? active.drained
    : active.stopMode !== undefined && active.drainAcknowledgedMode === active.stopMode
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
  const authorityBindings = new Map<string, DaemonProviderHostExecutionHandleBinding>()
  if (input.hostExecutionRuntime !== undefined) {
    const ids = new Set(handleFactories.map((factory) => factory.id))
    if (ids.size !== handleFactories.length)
      throw new Error('host-execution-runtime-handle-id-duplicated')
    for (const binding of input.hostExecutionRuntime.handles) {
      if (!ids.has(binding.id) || authorityBindings.has(binding.id))
        throw new Error('host-execution-runtime-handle-selection-mismatch')
      if (typeof binding.group !== 'string' || binding.group.length === 0)
        throw new Error('host-execution-runtime-handle-group-missing')
      for (const method of ['start', 'quiesceAuthorityLoss', 'drainAuthorityLoss'] as const) {
        if (typeof binding[method] !== 'function')
          throw new Error(`host-execution-runtime-handle-missing-${method}`)
      }
      authorityBindings.set(binding.id, binding)
    }
    if (authorityBindings.size !== ids.size)
      throw new Error('host-execution-runtime-handle-selection-incomplete')
  }
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
  let executionEnabled = input.hostExecutionRuntime === undefined
  let executionRunning = false
  let authorityVersion = 0
  let authorityClosing = false
  let requestedAuthorityContext: HostExecutionGrantContext | undefined
  const retiredAuthorityContexts = new WeakSet<HostExecutionGrantContext>()
  const authorityRetirementModes = new WeakMap<
    HostExecutionGrantContext,
    'normal' | 'authority-loss'
  >()
  let authorityGrant:
    | {
        readonly context: HostExecutionGrantContext
        readonly groups: readonly HostExecutionGroup[]
        readonly version: number
      }
    | undefined
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

  const stopHandles = async (context?: HostExecutionGrantContext): Promise<unknown[]> => {
    executionRunning = false
    const failures: unknown[] = []
    for (let index = activeHandles.length - 1; index >= 0; index -= 1) {
      const active = activeHandles[index]!
      if (context !== undefined && active.authority?.context !== context) continue
      try {
        if (active.authority !== undefined && active.stopMode === undefined) {
          const explicitMode = authorityRetirementModes.get(active.authority.context)
          if (explicitMode === undefined && !active.authority.context.current()) {
            failures.push(new Error('host-execution-runtime-stop-reason-pending'))
            continue
          }
          active.stopMode = explicitMode ?? 'normal'
        }
        while (!stoppedForCurrentMode(active)) {
          // The requested mode can change during an awaited normal stop. Its
          // ACK proves only that exact operation; loss still needs its owner ACK.
          const acknowledgedMode = active.stopMode
          if (active.authority !== undefined && acknowledgedMode === 'authority-loss') {
            await active.authority.binding.quiesceAuthorityLoss({
              handle: active.handle,
              context: active.authority.context,
            })
          } else {
            await active.handle.stop()
          }
          active.stopped = true
          if (active.authority !== undefined) active.stopAcknowledgedMode = acknowledgedMode
        }
      } catch (error) {
        failures.push(error)
      }
    }
    return failures
  }

  const drainHandles = async (context?: HostExecutionGrantContext): Promise<unknown[]> => {
    const failures: unknown[] = []
    for (let index = activeHandles.length - 1; index >= 0; index -= 1) {
      const active = activeHandles[index]!
      if (context !== undefined && active.authority?.context !== context) continue
      if (!stoppedForCurrentMode(active) || drainedForCurrentMode(active)) continue
      try {
        const acknowledgedMode = active.stopMode
        if (active.authority !== undefined && acknowledgedMode === 'authority-loss') {
          await active.authority.binding.drainAuthorityLoss({
            handle: active.handle,
            context: active.authority.context,
          })
        } else {
          await active.handle.drain()
        }
        active.drained = true
        if (active.authority !== undefined) active.drainAcknowledgedMode = acknowledgedMode
      } catch (error) {
        failures.push(error)
      }
    }
    activeHandles = activeHandles.filter(
      (active) => !stoppedForCurrentMode(active) || !drainedForCurrentMode(active),
    )
    return failures
  }

  const stopAndDrainHandles = async (): Promise<unknown[]> => {
    const failures = await stopHandles()
    failures.push(...(await drainHandles()))
    return failures
  }

  const rollbackStartedHandles = async (): Promise<unknown[]> => {
    // SO can invalidate a pending start before its queued retire delivers the
    // reason. Keep that exact handle for quiesce(reason); false current alone
    // does not distinguish ordinary shutdown from authority loss.
    if (
      authorityGrant !== undefined &&
      !authorityGrant.context.current() &&
      !authorityRetirementModes.has(authorityGrant.context)
    ) {
      return []
    }
    return await stopAndDrainHandles()
  }

  const startHandles = async (
    lifecycleInput: DaemonProviderSessionLifecycleInput,
  ): Promise<void> => {
    const grant = authorityGrant
    if (input.hostExecutionRuntime !== undefined && grant === undefined) return
    for (const factory of handleFactories) {
      const binding = grant === undefined ? undefined : authorityBindings.get(factory.id)!
      if (grant !== undefined && !grant.groups.includes(binding!.group)) continue
      const current = () =>
        grant === undefined ||
        (!authorityClosing && grant.version === authorityVersion && grant.context.current())
      if (!current()) throw new Error('host-execution-runtime-grant-lost')
      const handle =
        grant === undefined
          ? await factory.start(lifecycleInput)
          : await binding!.start({ scope: lifecycleInput, context: grant.context })
      activeHandles.push({
        id: factory.id,
        handle,
        stopped: false,
        drained: false,
        ...(grant === undefined
          ? {}
          : {
              authority: { binding: binding!, context: grant.context },
              stopMode: authorityRetirementModes.get(grant.context),
            }),
      })
      if (!current()) throw new Error('host-execution-runtime-grant-lost')
    }
    executionRunning = true
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

  const hostExecutionRuntime = Object.freeze<HostExecutionRuntimeFamily>({
    start({ context, groups }) {
      if (context.generation !== input.generationId)
        return Promise.reject(new Error('host-execution-runtime-generation-mismatch'))
      if (groups.length === 0 || retiredAuthorityContexts.has(context))
        return Promise.reject(new Error('host-execution-runtime-unavailable'))
      requestedAuthorityContext = context
      const requestedVersion = authorityVersion
      return serialize(async () => {
        if (
          authorityClosing ||
          phase !== 'running' ||
          !context.current() ||
          requestedVersion !== authorityVersion
        ) {
          throw new Error('host-execution-runtime-unavailable')
        }
        if (authorityGrant?.context === context && executionEnabled && executionRunning) return
        if (activeHandles.length !== 0)
          throw new Error('host-execution-runtime-prior-handles-not-drained')
        authorityGrant = {
          context,
          groups: Object.freeze([...new Set(groups)]),
          version: authorityVersion,
        }
        executionEnabled = true
        try {
          await startHandles({
            operationId: 'host-execution-activation',
            provider: input.provider,
            generationId: input.generationId,
          })
        } catch (error) {
          executionEnabled = false
          const rollback = await rollbackStartedHandles()
          if (rollback.length === 0) throw error
          throw new AggregateError(
            [error, ...rollback],
            'failed to start host execution handles and settle rollback',
          )
        }
      })
    },
    quiesce({ context, reason }) {
      if (context.generation !== input.generationId)
        return Promise.reject(new Error('host-execution-runtime-generation-mismatch'))
      if (authorityGrant?.context !== context && requestedAuthorityContext !== context)
        return Promise.resolve()
      retiredAuthorityContexts.add(context)
      const stopMode =
        reason === 'authority-loss' || authorityRetirementModes.get(context) === 'authority-loss'
          ? 'authority-loss'
          : 'normal'
      authorityRetirementModes.set(context, stopMode)
      authorityVersion += 1
      executionEnabled = false
      executionRunning = false
      for (const active of activeHandles) {
        if (
          active.authority?.context === context &&
          (active.stopMode === undefined || stopMode === 'authority-loss')
        )
          active.stopMode = stopMode
      }
      return serialize(async () => {
        const failures = await stopHandles(context)
        if (failures.length > 0)
          throw lifecycleFailure('failed to quiesce host execution handles', failures)
      })
    },
    drain(context) {
      if (context.generation !== input.generationId)
        return Promise.reject(new Error('host-execution-runtime-generation-mismatch'))
      return serialize(async () => {
        const owned = activeHandles.filter((active) => active.authority?.context === context)
        if (owned.some((active) => !stoppedForCurrentMode(active)))
          throw new Error('host-execution-runtime-drain-before-quiesce')
        const failures = await drainHandles(context)
        if (failures.length > 0)
          throw lifecycleFailure('failed to drain host execution handles', failures)
      })
    },
  })

  const session: DaemonProviderRuntimeSession<UpgradeServer, WebSocketHandlers> = {
    provider: input.provider,
    generationId: input.generationId,
    runtime,
    ...(input.hostExecutionRuntime === undefined ? {} : { hostExecutionRuntime }),
    execution: Object.freeze<DaemonExecutionRuntimeControl>({
      state: () =>
        Object.freeze({
          enabled: executionEnabled,
          running: phase === 'running' && executionEnabled && executionRunning,
          activeHandleIds: Object.freeze(activeHandles.map(({ id }) => id)),
        }),

      pause(lifecycleInput) {
        return serialize(async () => {
          assertLifecycleMatches(lifecycleInput)
          if (phase === 'closing' || phase === 'closed') {
            throw new DaemonProviderRuntimeSessionError(
              'daemon-provider-runtime-session-closing',
              `cannot pause daemon execution runtime while ${phase}`,
            )
          }
          executionEnabled = false
          const failures = await stopAndDrainHandles()
          if (failures.length > 0) {
            throw lifecycleFailure('failed to pause daemon execution runtime', failures)
          }
        })
      },

      resume(lifecycleInput) {
        const requestedVersion = authorityVersion
        return serialize(async () => {
          assertLifecycleMatches(lifecycleInput)
          if (phase === 'closing' || phase === 'closed') {
            throw new DaemonProviderRuntimeSessionError(
              'daemon-provider-runtime-session-closing',
              `cannot resume daemon execution runtime while ${phase}`,
            )
          }
          if (executionEnabled && executionRunning) return
          if (input.hostExecutionRuntime !== undefined) {
            if (requestedVersion !== authorityVersion) return
            if (
              authorityClosing ||
              !authorityGrant?.context.current() ||
              authorityGrant.version !== authorityVersion
            ) {
              throw new DaemonProviderRuntimeSessionError(
                'daemon-provider-execution-unavailable',
                'host execution has no current prepared grant',
              )
            }
          }
          executionEnabled = true
          if (phase === 'frozen') return

          const staleFailures = await stopAndDrainHandles()
          if (staleFailures.length > 0) {
            executionEnabled = false
            throw lifecycleFailure(
              'failed to settle daemon execution runtime before resume',
              staleFailures,
            )
          }

          try {
            await startHandles(lifecycleInput)
          } catch (error) {
            executionEnabled = false
            const rollbackFailures = await rollbackStartedHandles()
            if (rollbackFailures.length === 0) throw error
            throw new AggregateError(
              [error, ...rollbackFailures],
              'failed to resume daemon execution runtime and roll back started handles',
            )
          }
        })
      },
    }),
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
          if (executionEnabled) await startHandles(lifecycleInput)
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
      if (input.hostExecutionRuntime !== undefined) {
        authorityClosing = true
        authorityVersion += 1
        executionEnabled = false
      }
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

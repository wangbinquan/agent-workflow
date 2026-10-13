import type { ProviderNeutralDatabase } from '@/db/query'
import type { DatabaseProvider } from '@/platform/persistence/schemaContract'
import {
  composeHostExecutionAuthorityBinding,
  type HostExecutionAuthorityBinding,
} from '@/modules/system-operations/composition/hostExecutionAuthority'
import { composeHostExecutionWriteContext } from '@/modules/system-operations/composition/hostExecutionWriteContext'
import { composeHostExecutionWriteLifecycle } from '@/modules/system-operations/composition/hostExecutionWriteLifecycle'
import { composeHostExecutionStatusQuery } from '@/modules/system-operations/composition/hostExecutionStatus'
import { composeHostExecutionRecoveryCommands } from '@/modules/system-operations/composition/hostExecutionRecovery'
import type {
  HostExecutionAuthorityFactory,
  HostExecutionRecoveryFamily,
  HostExecutionRuntimeFamily,
  HostExecutionWriteLeaseFacts,
} from '@/modules/system-operations/public/participants'
import {
  composeTaskHostExecutionAdmission,
  createTaskHostWriteContextAdapter,
} from '@/modules/task-execution/composition/hostExecutionAdmission'
import type { TaskExecutionProviderHostSelection } from '@/modules/task-execution/composition/taskDriveBinding'
import {
  DaemonProviderRuntimeSessionError,
  type DaemonProviderRuntimeSession,
} from './daemonProviderRuntimeSession'
import type { DaemonHostRecoveryCompositionInput } from './daemonHostExecutionRecovery'

/** A complete selection; a missing method must never select native execution. */
export interface DaemonHostExecutionSelection {
  readonly mode: 'execution' | 'resource-only'
  readonly authority: HostExecutionAuthorityFactory
  readonly leaseFacts: HostExecutionWriteLeaseFacts
  readonly recoveryKind: HostExecutionRecoveryFamily['kind']
  /** A durable-intent deployment supplies its own complete recovery adapter. */
  readonly recovery?: (input: DaemonHostRecoveryCompositionInput) => HostExecutionRecoveryFamily
}

export interface DaemonHostExecutionOwnerScope {
  readonly provider: DatabaseProvider
  readonly generation: string
}

/** Real application roots must reject an incomplete selection before opening effects. */
export function assertDaemonHostExecutionRootSelection(
  selection: DaemonHostExecutionSelection,
): void {
  if (selection.mode !== 'execution' && selection.mode !== 'resource-only')
    throw new Error('daemon-host-execution-mode-missing')
  if (
    typeof selection.authority?.create !== 'function' ||
    typeof selection.leaseFacts?.forGrant !== 'function'
  )
    throw new Error('daemon-host-selection-incomplete')
  if (selection.recoveryKind !== 'local-startup' && selection.recoveryKind !== 'durable-intent')
    throw new Error('daemon-host-recovery-kind-missing')
  if (
    (selection.recovery !== undefined && typeof selection.recovery !== 'function') ||
    (selection.recoveryKind === 'durable-intent' && typeof selection.recovery !== 'function')
  )
    throw new Error('daemon-host-recovery-adapter-missing')
}

/**
 * Bootstrap-only construction order. Task needs admission before the provider
 * graph exists; authority needs the graph's real recovery and session runtime.
 * The lifecycle is released only after both exact owner families are installed.
 */
export async function composeDaemonHostExecutionBootstrap(input: {
  readonly db: ProviderNeutralDatabase
  readonly provider: DatabaseProvider
  readonly generation: string
  readonly selection: DaemonHostExecutionSelection
  readonly onFailure: (error: unknown) => void
}) {
  const { mode, authority, leaseFacts, recoveryKind } = input.selection
  if (recoveryKind !== 'local-startup' && recoveryKind !== 'durable-intent') {
    throw new Error('daemon-host-recovery-kind-missing')
  }
  if (typeof authority?.create !== 'function' || typeof leaseFacts?.forGrant !== 'function') {
    throw new Error('daemon-host-selection-incomplete')
  }
  const scope: DaemonHostExecutionOwnerScope = Object.freeze({
    provider: input.provider,
    generation: input.generation,
  })
  let owners:
    | Readonly<{
        recovery: HostExecutionRecoveryFamily
        runtime: HostExecutionRuntimeFamily
      }>
    | undefined
  const requireOwners = () => {
    if (owners === undefined) throw new Error('daemon-host-owners-not-installed')
    return owners
  }
  const recovery = Object.freeze<HostExecutionRecoveryFamily>({
    kind: recoveryKind,
    prepare: (context) => requireOwners().recovery.prepare(context),
    quiesce: (request) => requireOwners().recovery.quiesce(request),
    drain: (context) => requireOwners().recovery.drain(context),
  })
  const runtime = Object.freeze<HostExecutionRuntimeFamily>({
    start: (request) => requireOwners().runtime.start(request),
    quiesce: (request) => requireOwners().runtime.quiesce(request),
    drain: (context) => requireOwners().runtime.drain(context),
  })
  const writes = composeHostExecutionWriteContext(input.db)
  const writeLifecycle = composeHostExecutionWriteLifecycle({
    context: writes.context,
    facts: leaseFacts,
  })
  const binding = await composeHostExecutionAuthorityBinding({
    provider: scope.provider,
    generation: scope.generation,
    mode,
    selection: { kind: 'selected', factory: authority, recovery, runtime, writeLifecycle },
    onFailure: input.onFailure,
  })
  const taskWrites = createTaskHostWriteContextAdapter(writes)
  const taskHost: TaskExecutionProviderHostSelection = Object.freeze({
    daemonGeneration: scope.generation,
    writes: taskWrites,
    admission: composeTaskHostExecutionAdmission({
      admission: binding.admission,
      writes: taskWrites.port,
    }),
  })
  const status = composeHostExecutionStatusQuery({ mode, queries: binding.queries })
  const recoveryCommands = composeHostExecutionRecoveryCommands({
    mode,
    lifecycle: binding.lifecycle,
  })

  return Object.freeze({
    scope,
    taskHost,
    admission: binding.admission,
    queries: binding.queries,
    status,
    http: Object.freeze({
      queries: status,
      admission: binding.admission,
      recovery: recoveryCommands,
    }),
    /** Terminal cleanup also works for a rejected, still-cold root. */
    beforeCloseProvider: binding.lifecycle.close.bind(binding.lifecycle),
    install(input: {
      readonly scope: DaemonHostExecutionOwnerScope
      readonly recovery: HostExecutionRecoveryFamily
      readonly runtime: HostExecutionRuntimeFamily
    }): HostExecutionAuthorityBinding {
      if (owners !== undefined) throw new Error('daemon-host-owners-already-installed')
      if (input.scope !== scope) throw new Error('daemon-host-owner-scope-mismatch')
      const selectedRecovery = input.recovery
      const selectedRuntime = input.runtime
      if (selectedRecovery?.kind !== recoveryKind)
        throw new Error('daemon-host-recovery-kind-mismatch')
      for (const method of ['prepare', 'quiesce', 'drain'] as const) {
        if (typeof selectedRecovery[method] !== 'function')
          throw new Error(`daemon-host-recovery-missing-${method}`)
      }
      for (const method of ['start', 'quiesce', 'drain'] as const) {
        if (typeof selectedRuntime?.[method] !== 'function')
          throw new Error(`daemon-host-runtime-missing-${method}`)
      }
      // Commit both families together only after validation. Capturing methods
      // also keeps their actual receivers if a caller later replaces a property.
      owners = Object.freeze({
        recovery: Object.freeze({
          kind: recoveryKind,
          prepare: selectedRecovery.prepare.bind(selectedRecovery),
          quiesce: selectedRecovery.quiesce.bind(selectedRecovery),
          drain: selectedRecovery.drain.bind(selectedRecovery),
        }),
        runtime: Object.freeze({
          start: selectedRuntime.start.bind(selectedRuntime),
          quiesce: selectedRuntime.quiesce.bind(selectedRuntime),
          drain: selectedRuntime.drain.bind(selectedRuntime),
        }),
      })
      return binding
    },
  })
}

export type DaemonHostExecutionBootstrap = Awaited<
  ReturnType<typeof composeDaemonHostExecutionBootstrap>
>

/** A selected host can serve already-ready resources while original execution
 * recovery blocks activation. Native/resource initialization failures retain
 * their original fail-fast behavior. The same session remains the retry owner. */
export async function resumeDaemonResourcesForServing(input: {
  readonly session: Pick<DaemonProviderRuntimeSession<unknown, unknown>, 'resume' | 'state'>
  readonly scope: Parameters<DaemonProviderRuntimeSession<unknown, unknown>['resume']>[0]
  readonly host?: Pick<DaemonHostExecutionBootstrap, 'queries'>
  readonly onExecutionUnavailable: (error: unknown) => void
}): Promise<void> {
  const resume = input.session.resume.bind(input.session),
    state = input.session.state.bind(input.session)
  const readHost = input.host?.queries.snapshot.bind(input.host.queries)
  const onExecutionUnavailable = input.onExecutionUnavailable.bind(input)
  try {
    await resume(input.scope)
  } catch (error) {
    const host = readHost?.()
    if (
      state().phase !== 'running' ||
      !host ||
      !['standby', 'draining'].includes(host.phase) ||
      ![
        'host-execution-start-failed',
        'host-execution-activation-failed',
        'host-execution-owner-failed',
      ].includes(host.reason ?? '')
    )
      throw error
    onExecutionUnavailable(error)
  }
}

/** Join the real session only after all of its selected owners exist. */
export function installDaemonHostExecutionSession<UpgradeServer, WebSocketHandlers>(input: {
  readonly bootstrap: DaemonHostExecutionBootstrap
  readonly recovery: HostExecutionRecoveryFamily
  readonly session: DaemonProviderRuntimeSession<UpgradeServer, WebSocketHandlers>
}) {
  const { bootstrap, session } = input
  if (
    session.provider !== bootstrap.scope.provider ||
    session.generationId !== bootstrap.scope.generation ||
    session.hostExecutionRuntime === undefined
  )
    throw new Error('daemon-host-session-scope-mismatch')
  const resume = session.resume.bind(session)
  const pause = session.pause.bind(session)
  const authority = bootstrap.install({
    scope: bootstrap.scope,
    recovery: input.recovery,
    runtime: session.hostExecutionRuntime,
  })
  const start = authority.lifecycle.start.bind(authority.lifecycle)
  const pauseAuthority = authority.lifecycle.pause.bind(authority.lifecycle)
  const closeAdmission = authority.lifecycle.quiesceAdmissions.bind(authority.lifecycle)
  const closeAuthority = authority.lifecycle.close.bind(authority.lifecycle)
  const close = session.close.bind(session)
  const assertScope = (scope: Parameters<typeof session.pause>[0]) => {
    if (scope.provider !== session.provider || scope.generationId !== session.generationId)
      throw new DaemonProviderRuntimeSessionError(
        'daemon-provider-runtime-session-mismatch',
        'Host execution session scope does not match the requested provider generation',
      )
  }
  const selectedSession = Object.freeze<
    DaemonProviderRuntimeSession<UpgradeServer, WebSocketHandlers>
  >({
    ...session,
    async resume(scope) {
      assertScope(scope)
      const state = authority.queries.snapshot()
      if (state.phase === 'draining') {
        if (state.reason === 'host-execution-pause-unsettled') {
          await pause(scope)
          await pauseAuthority()
        } else {
          await pauseAuthority()
          await pause(scope)
        }
      }
      await resume(scope)
      await start()
    },
    async pause(scope) {
      assertScope(scope)
      // Original normal stops run while their grant can still record their
      // normal cancellation receipts. Only then retire the write context.
      const state = authority.queries.snapshot()
      if (state.phase === 'active' || state.reason === 'host-execution-pause-unsettled')
        await closeAdmission()
      else await pauseAuthority()
      await pause(scope)
      await pauseAuthority()
    },
    async close(reason) {
      const state = authority.queries.snapshot()
      if (state.phase === 'active' || state.reason === 'host-execution-pause-unsettled') {
        await closeAdmission()
        // Normal owner stop/drain retains its current write epoch. Retire the
        // authority before core close takes the provider-session queue; its
        // beforeCloseProvider callback must never wait on that same queue.
        await pause({
          provider: session.provider,
          generationId: session.generationId,
          operationId: 'host-execution-close',
        })
        await pauseAuthority()
      } else if (state.phase !== 'closed') await pauseAuthority()
      await close(reason)
    },
  })
  return Object.freeze({
    authority,
    session: selectedSession,
    resume: selectedSession.resume.bind(selectedSession),
    pause: selectedSession.pause.bind(selectedSession),
    beforeCloseProvider: closeAuthority,
  })
}

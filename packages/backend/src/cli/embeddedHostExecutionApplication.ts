import {
  composeSqliteApplicationDeps,
  createComposedApp,
  type AppDeps,
  type SqliteAppComposition,
  type UnstartedApplicationScope,
} from '@/server'
import { TaskExecutionModule } from '@/modules/task-execution/composition'
import { createTaskExecutionPersistence } from '@/modules/task-execution/composition/taskExecutionPersistence'
import { createDatabaseTaskDriverLifecyclePort } from '@/modules/task-execution/composition/providerRuntime'
import { finishClaimedWebhookWorkspacePrune } from '@/services/gc'
import { composeLocalMcpDiagnostics } from '@/modules/resource-catalog/composition/localMcpDiagnostics'
import type { composeCompleteObservationReports } from '@/modules/run-observability/composition/completeObservationReports'
import type {
  HostExecutionGrantContext,
  HostExecutionRecoveryFamily,
} from '@/modules/system-operations/public/participants'
import { sha256Hex } from '@/util/hash'
import { createLogger } from '@/util/log'
import type { buildWebSocketAdapter } from '@/ws/server'
import {
  composeDaemonHostExecutionBootstrap,
  installDaemonHostExecutionSession,
  resumeDaemonResourcesForServing,
  assertDaemonHostExecutionRootSelection,
  type DaemonHostExecutionSelection,
} from './daemonHostExecutionBootstrap'
import {
  bindEmbeddedTaskHostOwner,
  bindEmbeddedIntentHostOwner,
  bindMcpDiagnosticsHostOwner,
  bindObservationReportsHostOwner,
  bindWebhookTerminalHostOwner,
} from './daemonHostExecutionOwners'
import { createDaemonProviderRuntimeSession } from './daemonProviderRuntimeSession'
import { composeIntentTurnExecution } from '@/modules/intent/composition/execution'
import { awaitOriginalHostPreparation } from './daemonHostExecutionRecovery'
import type { composeMrTerminalControl } from '@/modules/integration/composition/webhookTerminalControl'

type EmbeddedResourceDependencies = Omit<
  AppDeps,
  | 'taskDriveBinding'
  | 'schedulerDriver'
  | 'taskExecutionReadModels'
  | 'taskRouteLaunch'
  | 'mcpRuntimeTests'
  | 'completeObservationReports'
  | 'webhookTerminalControl'
> & { readonly webhookTerminalControl?: ReturnType<typeof composeMrTerminalControl> }

/** A real embedded HTTP root, with the original request-driven owner inventory.
 * Its caller owns the database and, optionally, the original socket transport.
 * No daemon PID lease, global orphan recovery or daemon scheduler is created. */
export async function composeEmbeddedHostExecutionApplication(input: {
  readonly generation: string
  readonly deps: EmbeddedResourceDependencies
  readonly selection: DaemonHostExecutionSelection
  readonly reports?: ReturnType<typeof composeCompleteObservationReports>
  readonly createWebSocket?: (
    application: SqliteAppComposition,
  ) => ReturnType<typeof buildWebSocketAdapter>
  readonly onFailure: (error: unknown) => void
}) {
  assertDaemonHostExecutionRootSelection(input.selection)
  if (input.deps.webhookTerminalControl && !input.deps.webhookTerminalControl.execution)
    throw new Error('embedded-host-webhook-lifecycle-missing')
  if (input.reports && !input.reports.execution)
    throw new Error('embedded-host-report-lifecycle-missing')
  const bootstrap = await composeDaemonHostExecutionBootstrap({
    db: input.deps.db,
    provider: 'sqlite',
    generation: input.generation,
    selection: input.selection,
    onFailure: input.onFailure,
  })
  const module = new TaskExecutionModule(input.generation, bootstrap.taskHost)
  const intentTurnExecution = composeIntentTurnExecution()
  const persistence = createTaskExecutionPersistence(input.deps.db, {
    hostWrites: bootstrap.taskHost.writes,
    workspacePresence: input.deps.workspacePresence,
    nativeUsage: input.deps.nativeUsage,
  })
  const driverLifecycle = createDatabaseTaskDriverLifecyclePort({
    db: input.deps.db,
    module,
    persistence,
    log: createLogger('embedded-host-task'),
    finalizeWorkspace: async (taskId) => {
      await finishClaimedWebhookWorkspacePrune(input.deps.db, taskId)
    },
  })
  const driveBinding = Object.freeze({ executionModule: module, persistence, driverLifecycle })
  const readiness: Promise<unknown>[] = []
  const constructedRuntimeTests =
    Promise.withResolvers<ReturnType<typeof composeLocalMcpDiagnostics>>()
  const runtimeDisposals: Array<() => Promise<void>> = []
  let shutdownIdentity: (() => void | Promise<void>) | undefined
  let closeConstructedSession: (() => Promise<void>) | undefined
  const disposeTasks = async (reason: string) => {
    const tickets = await module.dispose(reason)
    const stopped = await Promise.all(
      tickets.map((ticket) => module.runtimeRegistry.awaitStopped(ticket)),
    )
    if (stopped.some((result) => result.kind === 'unreaped'))
      throw new Error('embedded-host-task-unreaped')
    await module.host!.finalizations.drain()
  }
  const scope: UnstartedApplicationScope = {
    trackReady(ready) {
      readiness.push(ready)
      void ready.catch(() => {})
      return ready
    },
    createMcpRuntimeTests(deps) {
      if (runtimeDisposals.length) throw new Error('embedded-host-mcp-already-composed')
      const runtimeTests = composeLocalMcpDiagnostics({ ...deps, executionMode: 'host' })
      runtimeDisposals.push(() => runtimeTests.dispose())
      constructedRuntimeTests.resolve(runtimeTests)
      return runtimeTests
    },
  }
  try {
    const composition = composeSqliteApplicationDeps(
      {
        ...input.deps,
        taskDriveBinding: driveBinding,
        mcpExecutionMode: 'host',
        hostExecutionHttp: bootstrap.http,
        intentTurnExecution,
        ...(input.reports ? { completeObservationReports: input.reports.queries } : {}),
      },
      scope,
    )
    const resourceReady = Promise.all(readiness).then(() => undefined)
    shutdownIdentity = composition.core.identityAccess.shutdown.bind(
      composition.core.identityAccess,
    )
    await resourceReady
    if (runtimeDisposals.length !== 1) throw new Error('embedded-host-mcp-lifecycle-missing')
    const runtimeTests = await constructedRuntimeTests.promise
    if (!runtimeTests.execution) throw new Error('embedded-host-mcp-lifecycle-missing')
    const handles = Object.freeze([
      bindEmbeddedTaskHostOwner({ module, onError: input.onFailure }),
      bindEmbeddedIntentHostOwner(intentTurnExecution),
      bindMcpDiagnosticsHostOwner(runtimeTests.execution),
      ...(input.deps.webhookTerminalControl
        ? [bindWebhookTerminalHostOwner(input.deps.webhookTerminalControl.execution!)]
        : []),
      ...(input.reports ? [bindObservationReportsHostOwner(input.reports.execution!)] : []),
    ])
    const app = createComposedApp(composition),
      socket = input.createWebSocket?.(composition)
    let accepting = false
    const requests = new Set<Promise<Response>>()
    const session = await createDaemonProviderRuntimeSession({
      provider: 'sqlite',
      generationId: input.generation,
      hostExecutionRuntime: { handles },
      runtime: {
        fetch(request: Request) {
          if (!accepting)
            return Promise.resolve(
              new Response(
                JSON.stringify({
                  ok: false,
                  code: 'database-maintenance',
                  message: 'Application is paused',
                }),
                { status: 503, headers: { 'Content-Type': 'application/json' } },
              ),
            )
          const result = Promise.resolve().then(() => app.fetch(request))
          requests.add(result)
          void result.finally(() => requests.delete(result)).catch(() => {})
          return result
        },
        tryUpgrade: socket ? socket.tryUpgrade.bind(socket) : () => false,
        websocketHandlers: socket?.handlers,
      },
      admission: {
        async closeWriterAdmission() {
          accepting = false
          await Promise.allSettled([...requests])
        },
        openWriterAdmission() {
          accepting = true
        },
        closeWebSocketAdmission: socket ? socket.admission.close.bind(socket.admission) : () => {},
        openWebSocketAdmission: socket ? socket.admission.open.bind(socket.admission) : () => {},
      },
      providerCloseParticipants: [
        {
          id: 'embedded-task-final-close',
          close: () => disposeTasks('embedded-application-closed'),
        },
        { id: 'embedded-mcp-final-close', close: () => runtimeTests!.dispose() },
        ...(input.reports
          ? [
              {
                id: 'embedded-report-final-close',
                close: input.reports.worker.stop.bind(input.reports.worker),
              },
            ]
          : []),
        ...(input.deps.webhookTerminalControl
          ? [
              {
                id: 'embedded-webhook-final-close',
                close: input.deps.webhookTerminalControl.stop.bind(
                  input.deps.webhookTerminalControl,
                ),
              },
            ]
          : []),
      ],
      shutdownIdentity,
      beforeCloseProvider: bootstrap.beforeCloseProvider,
      // Borrowed database: the caller can close it after this root's ACK.
      closeProvider: () => {},
    })
    closeConstructedSession = () => session.close({ reason: 'daemon-shutdown' })
    const localRecovery: HostExecutionRecoveryFamily = (() => {
      const preparations = new WeakMap<HostExecutionGrantContext, Promise<void>>()
      return {
        kind: 'local-startup',
        async prepare(context) {
          if (context.generation !== module.daemonGeneration || preparations.has(context))
            throw new Error('embedded-host-recovery-scope-mismatch')
          const preparing = resourceReady.then(() => intentTurnExecution.prepare())
          preparations.set(context, preparing)
          await preparing
          if (!context.current())
            return { kind: 'deferred', reason: 'embedded-host-execution-quiesced' }
          return {
            kind: 'prepared',
            preparationDigest: sha256Hex(
              JSON.stringify([
                input.generation,
                module.moduleId,
                readiness.length,
                handles.map((handle) => handle.id),
              ]),
            ),
            acceptedTaskContractVersions: [],
            readyGroups: [...new Set(handles.map((handle) => handle.group))],
          }
        },
        quiesce({ context }) {
          if (!preparations.has(context)) throw new Error('embedded-host-recovery-lifetime-missing')
        },
        async drain(context) {
          const ready = preparations.get(context)
          if (!ready) throw new Error('embedded-host-recovery-lifetime-missing')
          await awaitOriginalHostPreparation(ready)
        },
      }
    })()
    const recovery =
      input.selection.recovery?.({
        generation: input.generation,
        taskPersistence: persistence,
        resourceReady,
        handles,
      }) ?? localRecovery
    const installed = installDaemonHostExecutionSession({ bootstrap, recovery, session })
    const lifecycle = {
      provider: 'sqlite' as const,
      generationId: input.generation,
      operationId: 'embedded-host',
    }
    return Object.freeze({
      fetch: installed.session.runtime.fetch,
      tryUpgrade: installed.session.runtime.tryUpgrade,
      websocketHandlers: installed.session.runtime.websocketHandlers,
      execution: bootstrap.queries,
      state: installed.session.state,
      resume: () => installed.resume(lifecycle),
      resumeForServing: () =>
        resumeDaemonResourcesForServing({
          session: installed.session,
          scope: lifecycle,
          host: bootstrap,
          onExecutionUnavailable: input.onFailure,
        }),
      pause: () => installed.pause(lifecycle),
      close: () => installed.session.close({ reason: 'daemon-shutdown' }),
    })
  } catch (error) {
    await Promise.allSettled(readiness)
    const cleanup: unknown[] = []
    const operations = closeConstructedSession
      ? [closeConstructedSession]
      : [
          () => disposeTasks('embedded-application-construction-failed'),
          ...runtimeDisposals,
          ...(shutdownIdentity ? [shutdownIdentity] : []),
          bootstrap.beforeCloseProvider,
        ]
    for (const operation of operations) {
      try {
        await operation()
      } catch (failure) {
        cleanup.push(failure)
      }
    }
    if (cleanup.length)
      throw new AggregateError([error, ...cleanup], 'Embedded host construction cleanup failed')
    throw error
  }
}

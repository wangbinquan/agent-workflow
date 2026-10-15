// RFC-349 — closed production composition for the root-owned provider runtime.
//
// This is the only bootstrap surface that joins provider-session ownership,
// migration admission and stable listener routing. The returned aggregate does
// not expose its controller, sessions or provider clients.

import {
  createDaemonProviderMigrationAdmission,
  type DatabaseMigrationDaemonAdmissionFactory,
  type DaemonProviderMigrationAdmission,
  type DaemonProviderMigrationInitialGeneration,
} from './daemonProviderMigrationAdmission'
import {
  createDaemonProviderListenerTraffic,
  createDaemonProviderRuntimeRouter,
  type DaemonProviderListenerRuntimeSession,
  type DaemonProviderListenerWebSocket,
  type DaemonProviderRuntimeRouter,
} from './daemonProviderRuntimeRouter'
import {
  createDaemonProviderSessionController,
  DaemonProviderSessionError,
  type DaemonProviderSessionController,
  type DaemonProviderSessionFactory,
  type DaemonProviderSessionLifecycleInput,
} from './daemonProviderSession'

export interface DaemonProviderBootstrap<WebSocket = DaemonProviderListenerWebSocket> {
  readonly fetch: DaemonProviderRuntimeRouter<WebSocket>['fetch']
  readonly tryUpgrade: DaemonProviderRuntimeRouter<WebSocket>['tryUpgrade']
  readonly websocketHandlers: DaemonProviderRuntimeRouter<WebSocket>['websocketHandlers']
  /** Module-facing migration port supplied to the application composition. */
  readonly databaseMigration: DaemonProviderMigrationAdmission['migration']
  /** Listener admission wrapper for business HTTP and WebSocket requests. */
  readonly runBusinessRequest: DaemonProviderMigrationAdmission['runBusinessRequest']
  readonly live: DaemonProviderMigrationAdmission['live']
  /** Fence admission first, then retry every incomplete provider close stage. */
  readonly stop: DaemonProviderMigrationAdmission['stop']
}

export interface CreateDaemonProviderBootstrapInput<WebSocket = DaemonProviderListenerWebSocket> {
  readonly initialSession: DaemonProviderListenerRuntimeSession<WebSocket>
  readonly sessionFactory: DaemonProviderSessionFactory<
    DaemonProviderListenerRuntimeSession<WebSocket>
  >
  /** Production passes the public System Operations factory explicitly. */
  readonly createMigrationAdmission?: DatabaseMigrationDaemonAdmissionFactory
  /**
   * Notified with the session that owns the listener after every composition
   * attempt. Bootstrap uses it to keep process-wide provider selection pinned
   * to the serving composition, including after a failed cutover.
   */
  readonly onCurrentSelected?: (session: DaemonProviderListenerRuntimeSession<WebSocket>) => void
}

export interface DaemonProviderBootstrapBindings {
  readonly migrationAdmission: DaemonProviderMigrationAdmission['migration']
  /** Readable while the initial frozen application is still being constructed. */
  readonly sourceWriteWindow: Readonly<{ writable(): boolean }>
}

export interface ComposedDaemonProviderInitialSession<
  Application,
  WebSocket = DaemonProviderListenerWebSocket,
> {
  readonly application: Application
  readonly session: DaemonProviderListenerRuntimeSession<WebSocket>
}

export interface ComposeDaemonProviderBootstrapInput<
  Application,
  WebSocket = DaemonProviderListenerWebSocket,
> extends Pick<
  CreateDaemonProviderBootstrapInput<WebSocket>,
  'createMigrationAdmission' | 'onCurrentSelected'
> {
  readonly initial: DaemonProviderMigrationInitialGeneration
  /** Compose a frozen session; migration lifecycle calls require the completed bootstrap. */
  readonly composeInitial: (
    bindings: DaemonProviderBootstrapBindings,
  ) => Promise<ComposedDaemonProviderInitialSession<Application, WebSocket>>
  readonly sessionFactory: {
    create(
      lifecycle: DaemonProviderSessionLifecycleInput,
      bindings: DaemonProviderBootstrapBindings,
    ): Promise<DaemonProviderListenerRuntimeSession<WebSocket>>
  }
}

type DaemonProviderBootstrapInitialization =
  | { readonly phase: 'composing' }
  | { readonly phase: 'ready' }
  | { readonly phase: 'failed'; readonly error: unknown }

/**
 * Upper bound on draining in-flight listener calls before a cutover composes the
 * target. Ordinary requests finish in milliseconds; this only has to be longer
 * than that and shorter than an operator's patience. Exceeding it proceeds
 * anyway — a stuck request must never be able to strand a migration.
 */
const LISTENER_QUIESCE_MS = 2_000

export function createDaemonProviderBootstrap<WebSocket = DaemonProviderListenerWebSocket>(
  input: CreateDaemonProviderBootstrapInput<WebSocket>,
): DaemonProviderBootstrap<WebSocket> {
  // One tracker shared by the listener delegates and the cutover: the router
  // counts in-flight calls, the controller drains them before it moves
  // process-wide provider state.
  const traffic = createDaemonProviderListenerTraffic()
  const controller = createDaemonProviderSessionController({
    initial: input.initialSession,
    factory: input.sessionFactory,
    quiesceListener: () => traffic.quiesce(LISTENER_QUIESCE_MS),
    ...(input.onCurrentSelected === undefined
      ? {}
      : { onCurrentSelected: input.onCurrentSelected }),
  })
  const admission = createDaemonProviderMigrationAdmission({
    controller,
    ...(input.createMigrationAdmission === undefined
      ? {}
      : { createAdmission: input.createMigrationAdmission }),
  })
  const router = createDaemonProviderRuntimeRouter<WebSocket>(controller, traffic)

  return Object.freeze({
    fetch: router.fetch,
    tryUpgrade: router.tryUpgrade,
    websocketHandlers: router.websocketHandlers,
    databaseMigration: admission.migration,
    runBusinessRequest: admission.runBusinessRequest,
    live: admission.live,
    stop: admission.stop,
  })
}

/**
 * Admission owns its real open phase before the initial application is built.
 * Only the completed bootstrap is returned. The lifecycle port rejects calls
 * made by an initial composer: waiting for initialization there would wait on
 * the caller itself, and reading the controller would enter its temporal dead
 * zone. The phase contains no replaceable session or controller reference.
 */
export async function composeDaemonProviderBootstrap<
  Application,
  WebSocket = DaemonProviderListenerWebSocket,
>(
  input: ComposeDaemonProviderBootstrapInput<Application, WebSocket>,
): Promise<
  Readonly<{
    initial: ComposedDaemonProviderInitialSession<Application, WebSocket>
    bootstrap: DaemonProviderBootstrap<WebSocket>
  }>
> {
  let initialization: DaemonProviderBootstrapInitialization = { phase: 'composing' }
  try {
    const requireReady = (): void => {
      if (initialization.phase === 'composing') {
        throw new Error('daemon provider bootstrap is still composing')
      }
      if (initialization.phase === 'failed') throw initialization.error
    }
    const readyController = (): DaemonProviderSessionController<
      DaemonProviderListenerRuntimeSession<WebSocket>
    > => {
      requireReady()
      return controller
    }
    const admission = createDaemonProviderMigrationAdmission({
      initial: input.initial,
      controller: Object.freeze({
        async pauseBackgroundWriters(lifecycle: DaemonProviderSessionLifecycleInput) {
          await readyController().pauseBackgroundWriters(lifecycle)
        },
        async switchProviderComposition(lifecycle: DaemonProviderSessionLifecycleInput) {
          await readyController().switchProviderComposition(lifecycle)
        },
        async resumeBackgroundWriters(lifecycle: DaemonProviderSessionLifecycleInput) {
          await readyController().resumeBackgroundWriters(lifecycle)
        },
        async stop() {
          await readyController().stop()
        },
      }),
      ...(input.createMigrationAdmission === undefined
        ? {}
        : { createAdmission: input.createMigrationAdmission }),
    })
    // Check the bootstrap phase before entering the migration state machine:
    // an invalid construction-time request must not begin a freeze or rollback.
    const migrationAdmission: DaemonProviderMigrationAdmission['migration'] = Object.freeze({
      async freezeAndDrain(
        request: Parameters<DaemonProviderMigrationAdmission['migration']['freezeAndDrain']>[0],
      ) {
        requireReady()
        await admission.migration.freezeAndDrain(request)
      },
      async reopenSqlite(
        request: Parameters<DaemonProviderMigrationAdmission['migration']['reopenSqlite']>[0],
      ) {
        requireReady()
        await admission.migration.reopenSqlite(request)
      },
      async activatePostgresql(
        request: Parameters<DaemonProviderMigrationAdmission['migration']['activatePostgresql']>[0],
      ) {
        requireReady()
        await admission.migration.activatePostgresql(request)
      },
      async openPostgresqlAdmission(
        request: Parameters<
          DaemonProviderMigrationAdmission['migration']['openPostgresqlAdmission']
        >[0],
      ) {
        requireReady()
        await admission.migration.openPostgresqlAdmission(request)
      },
    })
    const bindings: DaemonProviderBootstrapBindings = Object.freeze({
      migrationAdmission,
      sourceWriteWindow: Object.freeze({ writable: () => admission.live().phase === 'open' }),
    })
    const initial = await input.composeInitial(bindings)
    if (
      initial.session.provider !== input.initial.provider ||
      initial.session.generationId !== input.initial.generationId
    ) {
      const mismatch = new DaemonProviderSessionError(
        'daemon-provider-session-mismatch',
        'initial provider session does not match the bootstrap generation',
      )
      try {
        await initial.session.close({ reason: 'daemon-shutdown' })
      } catch (closeError) {
        throw new AggregateError(
          [mismatch, closeError],
          'initial provider session mismatched and could not be closed',
        )
      }
      throw mismatch
    }
    const traffic = createDaemonProviderListenerTraffic()
    const controller = createDaemonProviderSessionController({
      initial: initial.session,
      factory: {
        create: (lifecycle) => input.sessionFactory.create(lifecycle, bindings),
      },
      quiesceListener: () => traffic.quiesce(LISTENER_QUIESCE_MS),
      ...(input.onCurrentSelected === undefined
        ? {}
        : { onCurrentSelected: input.onCurrentSelected }),
    })
    const router = createDaemonProviderRuntimeRouter<WebSocket>(controller, traffic)
    const bootstrap: DaemonProviderBootstrap<WebSocket> = Object.freeze({
      fetch: router.fetch,
      tryUpgrade: router.tryUpgrade,
      websocketHandlers: router.websocketHandlers,
      databaseMigration: migrationAdmission,
      runBusinessRequest: admission.runBusinessRequest,
      live: admission.live,
      stop: admission.stop,
    })
    initialization = { phase: 'ready' }
    return Object.freeze({ initial, bootstrap })
  } catch (error) {
    initialization = { phase: 'failed', error }
    throw error
  }
}

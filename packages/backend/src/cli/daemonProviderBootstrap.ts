// RFC-349 — closed production composition for the root-owned provider runtime.
//
// This is the only bootstrap surface that joins provider-session ownership,
// migration admission and stable listener routing. The returned aggregate does
// not expose its controller, sessions or provider clients.

import {
  createDaemonProviderMigrationAdmission,
  type DatabaseMigrationDaemonAdmissionFactory,
  type DaemonProviderMigrationAdmission,
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
  type DaemonProviderSessionFactory,
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

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
}

export function createDaemonProviderBootstrap<WebSocket = DaemonProviderListenerWebSocket>(
  input: CreateDaemonProviderBootstrapInput<WebSocket>,
): DaemonProviderBootstrap<WebSocket> {
  const controller = createDaemonProviderSessionController({
    initial: input.initialSession,
    factory: input.sessionFactory,
  })
  const admission = createDaemonProviderMigrationAdmission({
    controller,
    ...(input.createMigrationAdmission === undefined
      ? {}
      : { createAdmission: input.createMigrationAdmission }),
  })
  const router = createDaemonProviderRuntimeRouter<WebSocket>(controller)

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

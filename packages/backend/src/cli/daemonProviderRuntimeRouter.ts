// RFC-349 — stable listener delegates for the root-owned provider session.
//
// Bun owns these function identities for the listener lifetime. Every call
// resolves controller.current().runtime anew so neither the listener nor this
// router retains an old provider session or a provider client.

import type { DaemonProviderSessionController } from './daemonProviderSession'
import type {
  DaemonProviderRuntimePayload,
  DaemonProviderRuntimeSession,
} from './daemonProviderRuntimeSession'
import type { WebSocketAdapter } from '@/ws/server'

export type DaemonProviderUpgradeServer = Parameters<WebSocketAdapter['tryUpgrade']>[1]
export type DaemonProviderListenerWebSocket = Parameters<WebSocketAdapter['handlers']['open']>[0]
export type DaemonProviderWebSocketMessage = Parameters<WebSocketAdapter['handlers']['message']>[1]

/**
 * The production default is WebSocketAdapter's Bun socket. The socket remains
 * generic here so the listener delegate can preserve Bun's connection-data
 * parameter without widening it elsewhere.
 */
export interface DaemonProviderRuntimeWebSocketHandlers<
  WebSocket = DaemonProviderListenerWebSocket,
> {
  readonly open: (webSocket: WebSocket) => ReturnType<WebSocketAdapter['handlers']['open']>
  readonly message: (
    webSocket: WebSocket,
    message: DaemonProviderWebSocketMessage,
  ) => ReturnType<WebSocketAdapter['handlers']['message']>
  readonly close: (webSocket: WebSocket) => ReturnType<WebSocketAdapter['handlers']['close']>
}

export type DaemonProviderListenerRuntimeSession<WebSocket = DaemonProviderListenerWebSocket> =
  DaemonProviderRuntimeSession<
    DaemonProviderUpgradeServer,
    DaemonProviderRuntimeWebSocketHandlers<WebSocket>
  >

export type DaemonProviderRuntimeRouterController<WebSocket = DaemonProviderListenerWebSocket> =
  Pick<
    DaemonProviderSessionController<DaemonProviderListenerRuntimeSession<WebSocket>>,
    'current' | 'handover'
  >

export type DaemonProviderRuntimeRouter<WebSocket = DaemonProviderListenerWebSocket> =
  DaemonProviderRuntimePayload<
    DaemonProviderUpgradeServer,
    DaemonProviderRuntimeWebSocketHandlers<WebSocket>
  >

export function createDaemonProviderRuntimeRouter<WebSocket = DaemonProviderListenerWebSocket>(
  controller: DaemonProviderRuntimeRouterController<WebSocket>,
): DaemonProviderRuntimeRouter<WebSocket> {
  return Object.freeze({
    async fetch(request: Request) {
      // Composing a provider moves process-wide provider state, so the outgoing
      // composition cannot serve anything once a switch has started — its
      // client and the shared table projection no longer agree. Requests that
      // are exempt from the migration maintenance gate (health, the
      // `/api/database*` control plane the operator is watching the migration
      // with) would otherwise fail with an opaque driver error for the whole
      // composition build. Wait for the handover instead and answer from
      // whichever composition ends up owning the listener.
      const handover = controller.handover()
      if (handover !== null) await handover
      return await controller.current().runtime.fetch(request)
    },
    tryUpgrade(request: Request, server: DaemonProviderUpgradeServer) {
      return controller.current().runtime.tryUpgrade(request, server)
    },
    websocketHandlers: Object.freeze({
      open(webSocket: WebSocket) {
        return controller.current().runtime.websocketHandlers.open(webSocket)
      },
      message(webSocket: WebSocket, message: DaemonProviderWebSocketMessage) {
        return controller.current().runtime.websocketHandlers.message(webSocket, message)
      },
      close(webSocket: WebSocket) {
        return controller.current().runtime.websocketHandlers.close(webSocket)
      },
    }),
  })
}

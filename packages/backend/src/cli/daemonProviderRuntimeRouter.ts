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

/**
 * RFC-349 —— 在途请求的计数器，割接前用它把监听面排空。
 *
 * `handover()` 只挡住**新**请求；已经拿到旧 composition、正在执行的那一批不受影响，而
 * 组装目标 composition 的那一刻会把进程级的表投影翻过去，于是这些在途请求接下来编译出的
 * 是目标形状的 SQL、却打在源 client 上——2026-09-02 本机取证实测：割接瞬间两条
 * `SQLiteError: no such table: agent_workflow.user_sessions` 直接变成用户可见的 500。
 *
 * 因此割接的顺序是：先竖起 handover 栅栏（新请求排队），再等在途请求跑完（有上界），
 * 最后才组装目标。等待有上界是有意的：长连接的一次 WS 帧、慢查询都不该把割接卡死；
 * 超时就照旧推进，行为退回到加这道闸之前。
 */
export interface DaemonProviderListenerTraffic {
  /** Mark one listener call in flight; call the returned function when it ends. */
  enter(): () => void
  /** Resolve once nothing is in flight, or when `timeoutMs` elapses. */
  quiesce(timeoutMs: number): Promise<void>
}

export function createDaemonProviderListenerTraffic(): DaemonProviderListenerTraffic {
  let inFlight = 0
  let idleWaiters: Array<() => void> = []
  const settleIfIdle = (): void => {
    if (inFlight !== 0) return
    const waiters = idleWaiters
    idleWaiters = []
    for (const resolve of waiters) resolve()
  }
  return Object.freeze({
    enter() {
      inFlight += 1
      let left = false
      return () => {
        if (left) return
        left = true
        inFlight -= 1
        settleIfIdle()
      }
    },
    async quiesce(timeoutMs: number) {
      if (inFlight === 0) return
      let onIdle: () => void = () => {}
      const idle = new Promise<void>((resolve) => {
        onIdle = resolve
        idleWaiters.push(resolve)
      })
      // `Bun.sleep`, not `setTimeout`: this is a bounded wait inside one
      // cutover, not a background job (the RFC-294 census counts every
      // `setTimeout` as one).
      await Promise.race([idle, Bun.sleep(timeoutMs)])
      idleWaiters = idleWaiters.filter((waiter) => waiter !== onIdle)
    },
  })
}

export function createDaemonProviderRuntimeRouter<WebSocket = DaemonProviderListenerWebSocket>(
  controller: DaemonProviderRuntimeRouterController<WebSocket>,
  traffic: DaemonProviderListenerTraffic = createDaemonProviderListenerTraffic(),
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
      const leave = traffic.enter()
      try {
        return await controller.current().runtime.fetch(request)
      } finally {
        leave()
      }
    },
    async tryUpgrade(request: Request, server: DaemonProviderUpgradeServer) {
      // Same fence as `fetch`: a WebSocket upgrade authenticates, and doing that
      // against the outgoing composition mid-switch fails on provider-shaped SQL
      // (`upgrade-token-resolve-threw`), which the client only ever sees as a
      // transport error before hello.
      const handover = controller.handover()
      if (handover !== null) await handover
      const leave = traffic.enter()
      try {
        return await controller.current().runtime.tryUpgrade(request, server)
      } finally {
        leave()
      }
    },
    websocketHandlers: Object.freeze({
      async open(webSocket: WebSocket) {
        const leave = traffic.enter()
        try {
          return await controller.current().runtime.websocketHandlers.open(webSocket)
        } finally {
          leave()
        }
      },
      async message(webSocket: WebSocket, message: DaemonProviderWebSocketMessage) {
        const leave = traffic.enter()
        try {
          return await controller.current().runtime.websocketHandlers.message(webSocket, message)
        } finally {
          leave()
        }
      },
      close(webSocket: WebSocket) {
        return controller.current().runtime.websocketHandlers.close(webSocket)
      },
    }),
  })
}

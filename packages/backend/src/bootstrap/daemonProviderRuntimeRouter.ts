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
 *
 * RFC-395 I-b 起表随会话句柄绑定（`tablesOf(db)`），进程级投影已删除，上面那种「目标形状的
 * SQL 打在源 client 上」不会再发生；排空照旧保留，让在途请求在源 composition 上跑完再割接。
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

/**
 * Read-only migration observation the outgoing composition keeps answering while the target is
 * composed: the `/api/database*` control plane, health and maintenance status. RFC-349 requires
 * migration status to stay live through the cutover, and the epoch-2 PostgreSQL composition build
 * grows with the dataset (4.9 s on the weekly evidence corpus, postgresql-evidence run
 * 40893688180). Since RFC-395 I-b binds tables to the session handle, the outgoing composition
 * still agrees with its own client; it has served exactly these requests through every earlier
 * frozen phase. Writes still wait, so a mid-switch rollback or cancel cannot race the switch.
 */
export function servesDuringProviderHandover(request: Request): boolean {
  if (request.method !== 'GET' && request.method !== 'HEAD') return false
  const path = new URL(request.url).pathname
  return (
    path === '/api/database' ||
    path.startsWith('/api/database/') ||
    path === '/api/health' ||
    path === '/api/maintenance/status'
  )
}

export function createDaemonProviderRuntimeRouter<WebSocket = DaemonProviderListenerWebSocket>(
  controller: DaemonProviderRuntimeRouterController<WebSocket>,
  traffic: DaemonProviderListenerTraffic = createDaemonProviderListenerTraffic(),
): DaemonProviderRuntimeRouter<WebSocket> {
  return Object.freeze({
    async fetch(request: Request) {
      // A switch fences new requests until the target composition is built and
      // answers them from whichever composition ends up owning the listener.
      // Read-only migration observation is the exception: the outgoing
      // composition answers it at once (see `servesDuringProviderHandover`).
      const handover = controller.handover()
      if (handover !== null && !servesDuringProviderHandover(request)) await handover
      const leave = traffic.enter()
      try {
        return await controller.current().runtime.fetch(request)
      } finally {
        leave()
      }
    },
    async tryUpgrade(request: Request, server: DaemonProviderUpgradeServer) {
      // Same fence as `fetch`: a WebSocket upgrade authenticates against the
      // composition that will own the socket. The listener asks every request
      // here first, so read-only migration observation (never a `/ws/` path)
      // passes the fence too, or `fetch` would never see it before the handover.
      const handover = controller.handover()
      if (handover !== null && !servesDuringProviderHandover(request)) await handover
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

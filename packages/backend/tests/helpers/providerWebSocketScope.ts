// RFC-359 AC-6 —— WebSocket 用例的双引擎作用域。
//
// 为什么需要**一个作用域**而不是「再补一个 helper」：WS 用例的拦路石有两层。
//   · 第一层是实时运行时被钉在 SQLite 上（`composeTestProviderRealtimeRuntime` 已解，
//     见 `helpers/realtimeRuntime.ts` 的注释）；
//   · **第二层才是真的**——WS 用例自建 `Bun.serve`，把 `ws.tryUpgrade` 与 **`app.fetch` 的
//     HTTP 回落**接在一起，而那个 `app` 来自 `createApp`，也就是 **SQLite 根**。
//     解掉实时运行时之后，应用本身仍然是单引擎的。
//
// 所以这里把「provider 应用 + 实时运行时 + ws 适配器 + 活的 server」一次装配好交出去：
// 写一次，11 个 WS 文件顺次迁；不写它，每个文件都要把这套重新拼一遍——正是
// `describeEachProviderHttpApplication` 当初要消灭的那 18 份手抄 lifetime。
//
// 生命周期：应用由内层 HTTP 作用域负责（它的 `afterEach` 先跑，dispose 应用、还原
// `AGENT_WORKFLOW_HOME`、删临时目录）；server 与广播器由本作用域自己的 `afterEach` 收尾。

import type { Server } from 'bun'
import { afterEach } from 'bun:test'
import { resetBroadcastersForTests } from '../../src/ws/broadcaster'
import { buildWebSocketAdapter } from '../../src/ws/server'
import type { ActorSource } from '../../src/auth/actor'
import { composeTestProviderRealtimeRuntime } from './realtimeRuntime'
import {
  describeEachProviderHttpApplication,
  type OpenedProviderHttpApplication,
  type ProviderHttpApplicationOptions,
  type ProviderHttpApplicationScope,
} from './providerHttpApplicationScope'

type AnyServer = Server<unknown>

export interface OpenedProviderWebSocketApplication extends OpenedProviderHttpApplication {
  readonly server: AnyServer
  /** `ws://127.0.0.1:<port>`——直接拼频道路径用。 */
  readonly url: string
  /** 同一个监听器的 http 形态，打 REST 断言用（WS 用例常要先建数据再订阅）。 */
  readonly httpUrl: string
}

export interface ProviderWebSocketScope {
  readonly harness: ProviderHttpApplicationScope['harness']
  open(overrides?: {
    readonly config?: Readonly<Record<string, unknown>>
    /** 少数用例要伪造批次归属（`/ws/repo-imports` 的升级门）。 */
    readonly repoImportOwnerUserId?: (batchId: string) => string | null
    readonly redactTaskEventPayload?: (payload: unknown, source: ActorSource) => unknown
  }): Promise<OpenedProviderWebSocketApplication>
}

export function describeEachProviderWebSocketApplication(
  name: string,
  options: ProviderHttpApplicationOptions & { readonly daemonToken: string },
  register: (scope: ProviderWebSocketScope) => void,
): void {
  const { daemonToken, ...httpOptions } = options
  describeEachProviderHttpApplication(name, httpOptions, (httpScope) => {
    let server: AnyServer | undefined
    afterEach(() => {
      try {
        server?.stop(true)
      } finally {
        server = undefined
        // 广播器是**进程级单例**：不重置会让上一条用例的订阅者收到本条的帧。
        resetBroadcastersForTests()
      }
    })

    register({
      harness: httpScope.harness,
      async open(overrides) {
        server?.stop(true)
        server = undefined
        const opened = await httpScope.open(
          overrides?.config === undefined ? undefined : { config: overrides.config },
        )
        const realtime = composeTestProviderRealtimeRuntime({
          binding: httpScope.harness.applicationBinding,
          neutralDb: httpScope.harness.db,
          // 用**应用自己装配的那一份** identityAccess，不另建一个——两份实例会让
          // 升级门和路由看到不同的授权视图。
          identityAccess: opened.identityAccess,
          ...(overrides?.repoImportOwnerUserId === undefined
            ? {}
            : { repoImportOwnerUserId: overrides.repoImportOwnerUserId }),
          ...(overrides?.redactTaskEventPayload === undefined
            ? {}
            : { redactTaskEventPayload: overrides.redactTaskEventPayload }),
        })
        const ws = buildWebSocketAdapter({
          daemonToken,
          realtime,
          identityAccess: opened.identityAccess,
        })
        const listener = Bun.serve({
          port: 0,
          hostname: '127.0.0.1',
          async fetch(request: Request, self): Promise<Response> {
            const upgraded = await ws.tryUpgrade(request, self)
            if (upgraded === true) return undefined as unknown as Response
            if (upgraded === false) return await opened.app.fetch(request)
            return upgraded
          },
          websocket: ws.handlers,
        })
        server = listener
        const authority = `${listener.hostname}:${String(listener.port)}`
        return Object.freeze({
          ...opened,
          server: listener,
          url: `ws://${authority}`,
          httpUrl: `http://${authority}`,
        })
      },
    })
  })
}

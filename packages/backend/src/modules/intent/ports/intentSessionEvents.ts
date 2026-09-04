// RFC-355 T4b（RFC-294 W4-E4a）—— intent 对外播报会话动静的窄端口。
//
// intent 的编排与投递适配器此前直接 `import { intentSessionsBroadcaster } from '@/ws/broadcaster'`
// ——一个 bounded context 直接抓住传输层的具体实现。危害不是抽象洁癖：`@/ws/` 是全局单例，
// 于是「这一轮播了什么」没有任何**可注入、可断言**的面（本仓至今没有一条测试观测过 intent
// 的广播），而 intent 也因此永远绑死在「进程内 WS 单例」这一种投递上。
//
// 现在 intent 只声明它要播的六种事件，实现由 bootstrap 注入。bootstrap（`server.ts` /
// `cli/start.ts` / `cli/postgresqlDaemonApplication.ts`）本来就 import 着 `@/ws/broadcaster`，
// 所以这一刀是净减：intent 侧四条 `legacy-outbound` 例外消失，装配侧不新增边。

/** 六种事件共用的会话身份。`ownerUserId` 决定谁能收到（前端按归属过滤）。 */
interface IntentSessionEventBase {
  readonly sessionId: string
  readonly ownerUserId: string
}

export type IntentSessionEvent =
  | (IntentSessionEventBase & { readonly type: 'intent.session.updated' })
  | (IntentSessionEventBase & {
      readonly type: 'intent.turn.execution.updated'
      readonly turnId: string
      readonly eventSeq: number
    })
  | (IntentSessionEventBase & {
      readonly type: 'intent.turn.started' | 'intent.turn.finished'
      readonly turnId: string
    })
  | (IntentSessionEventBase & {
      readonly type: 'intent.apply.committed'
      readonly journalId: string
    })

export interface IntentSessionEventPublisher {
  publish(event: IntentSessionEvent): void
}

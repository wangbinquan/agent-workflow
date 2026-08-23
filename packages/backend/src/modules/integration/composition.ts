import type { DbClient } from '@/db/client'
import type { EventCenterCodeHostDeliveryDispatcher } from '@/services/webhook/dispatcherTypes'
import {
  createCodeHostEventDeliveryAdapter,
  createCodeHostEventRoutingAdapter,
} from './application/adapters/event-center-adapter'
import { createSqliteCodeHostEventResponseDirectory } from './infrastructure/sqliteCodeHostEventResponseDirectory'
import type { DigitalEmployeeWorkStartPort } from './public/participants'
import type { CodeHostEventContinuationPort } from './application/ports/codeHostEventResponse'

export interface DeferredDigitalEmployeeWorkStart {
  readonly participant: DigitalEmployeeWorkStartPort
  bind(participant: DigitalEmployeeWorkStartPort): void
}

/** Bootstrap-local late binding; no ambient singleton or business fallback exists. */
export function createDeferredDigitalEmployeeWorkStart(): DeferredDigitalEmployeeWorkStart {
  let bound: DigitalEmployeeWorkStartPort | null = null
  return {
    participant: {
      launch(input) {
        if (bound === null) {
          throw new Error('digital employee work-start participant is not bound')
        }
        return bound.launch(input)
      },
    },
    bind(participant) {
      // RFC-317 T54（findings TP-04）—— **已绑定即抛**。
      //
      // 改造前这里是一句 `bound = participant`，没有 once 守卫。而 `mountApiRoutes`
      // 每进程被调用**两次**：一次给 REST app（`createApp`），一次给 MCP dispatcher
      // 的私有 Hono app（`mcp/dispatch.ts`，在**第一次 MCP 请求**时懒建）。
      // 两次各自 compose 出一套独立的 digital-employee runtime，第二次的 bind 会静默
      // 覆盖第一次的。
      //
      // 后果是真实且难查的：`cli/start.ts` 把这个 deferred 的 `.participant` 交给了
      // webhook dispatcher。于是**一旦有人发过一次 MCP 请求**，此后所有 webhook /
      // 事件驱动的工作启动都改走 MCP dispatcher 那套私有 runtime，而不是 REST 那套。
      // 没有任何日志、没有任何报错——只是换了一个 runtime 实例。
      //
      // 抛出来把它变成一次立刻可见的失败。第二个路由面不该抢进程级参与者：
      // dispatcher 现在传 `digitalEmployeeWorkStart: undefined`（见 mcp/dispatch.ts）。
      if (bound !== null) {
        throw new Error('digital employee work-start participant is already bound')
      }
      bound = participant
    },
  }
}

export function createCodeHostWebhookRoutingDirectory(
  db: DbClient,
  continuation?: CodeHostEventContinuationPort,
) {
  return createCodeHostEventRoutingAdapter(
    createSqliteCodeHostEventResponseDirectory(db),
    continuation,
  )
}

export function createCodeHostWebhookDeliveryConsumer(
  db: DbClient,
  dispatcher: EventCenterCodeHostDeliveryDispatcher,
  continuation?: CodeHostEventContinuationPort,
) {
  return createCodeHostEventDeliveryAdapter(
    createSqliteCodeHostEventResponseDirectory(db),
    {
      dispatch: (input) => dispatcher.dispatchSubscription(input),
    },
    continuation,
  )
}

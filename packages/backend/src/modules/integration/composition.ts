import type { DbClient } from '@/db/client'
import type { EventCenterCodeHostDeliveryDispatcher } from '@/services/webhook/dispatcherTypes'
import {
  createCodeHostEventDeliveryAdapter,
  createCodeHostEventRoutingAdapter,
} from './application/adapters/event-center-adapter'
import { createSqliteCodeHostEventResponseDirectory } from './infrastructure/sqliteCodeHostEventResponseDirectory'
import type { DigitalEmployeeWorkStartPort } from './public/participants'
import type { CodeHostEventContinuationPort } from './application/ports/codeHostEventResponse'

export {
  createRepositoryEndpointDiscovery,
  type RepositoryEndpointConnection,
  type RepositoryEndpointFetch,
} from './application/repositoryEndpointDiscovery'

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
      // 改造前这里是一句 `bound = participant`，没有 once 守卫。RFC-344 之前
      // `mountApiRoutes` 每进程被 REST 与 MCP private Hono 各调用一次，两套 runtime
      // 的第二次 bind 会静默覆盖第一次的。
      //
      // 后果是真实且难查的：`cli/start.ts` 把这个 deferred 的 `.participant` 交给了
      // webhook dispatcher。于是**一旦有人发过一次 MCP 请求**，此后所有 webhook /
      // 事件驱动的工作启动都改走 MCP dispatcher 那套私有 runtime，而不是 REST 那套。
      // 没有任何日志、没有任何报错——只是换了一个 runtime 实例。
      //
      // 抛出来把它变成一次立刻可见的失败。RFC-344 已删除第二个路由面；此守卫
      // 继续防止任何未来的重复 bootstrap 入口。
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

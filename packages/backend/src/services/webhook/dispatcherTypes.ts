// RFC-257 — dispatcher 契约类型。放在 services 层（depcheck no-services-to-routes：
// webhookDispatch 是 services，不得 import routes；路由与装配层反向引用这里）。
import type { webhookEndpoints } from '@/db/schema'
import type { CodeHostEvent } from '@agent-workflow/shared'

export type WebhookEndpointRow = typeof webhookEndpoints.$inferSelect

/**
 * 异步分发器（webhookDispatch.ts 实装；路由三段式的异步段）。契约：接手
 * received 行后负责推进 processing → 终态（matched/ignored/failed）；调用方
 * 对 dispatch 的 Promise 只 catch 标 failed，绝不 await 在响应路径上。
 */
export interface WebhookDispatcher {
  dispatch(input: {
    deliveryId: string
    endpoint: WebhookEndpointRow
    event: CodeHostEvent
  }): Promise<void>
}

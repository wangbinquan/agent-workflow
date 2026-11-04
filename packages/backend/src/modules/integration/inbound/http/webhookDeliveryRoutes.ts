// RFC-257 T9 — 投递观测面（端点级审计：全仓事件流）。RFC-260 D2：列表与详情
// （含原始 body）随 `webhook-endpoints:read` 全员只读开放（用户拍板——事件源于
// 成员共同的代码平台，对内不构成秘密）；replay 仍 `webhook-endpoints:manage`。
// replay 三规则（multica）：rejected 不可放（绕过拒绝=绕过验签）；重放新建行
// 指回 replayed_from；event_uuid=NULL 绕过去重（replay 就是明确要求再跑一次）。
// GitLab 对失败投递不自动重试（设计门 F-6）——replay 是平台侧的主恢复路径。
// RFC-437：自 routes/webhookDeliveries.ts 归入 integration 的 inbound/http；重放规则收进
// application/replayWebhookDelivery，可用性由 composition 判定，本绑定不再接触事件中心与分发器。
import type { Hono } from 'hono'
import { z } from 'zod'

import { CodeHostEventTypeSchema, WEBHOOK_DELIVERY_STATUSES } from '@agent-workflow/shared'

import { actorOf } from '@/auth/actor'
import { registerRoute } from '@/routes/registry'
import { ConflictError, NotFoundError } from '@/util/errors'
import type { WebhookDeliveryRuntime } from '../../application/ports/webhookDeliveryRuntime'
import type { WebhookDeliveryReplay } from '../../application/replayWebhookDelivery'

export function mountWebhookDeliveryRoutes(
  app: Hono,
  deps: {
    readonly webhookDeliveryRuntime: WebhookDeliveryRuntime
    /** Absent when event publishing is not wired (composition decides). */
    readonly replay?: WebhookDeliveryReplay
  },
): void {
  const runtime = deps.webhookDeliveryRuntime
  registerRoute(
    app,
    {
      method: 'GET',
      path: '/api/webhook-deliveries',
      // RFC-260 D2/D4：投递是端点级审计，列表随端点读点全员开放（replay 仍 manage）。
      permissions: ['webhook-endpoints:read'],
      tokenAccess: 'allow',
      summary: 'List webhook deliveries (endpoint-level audit)',
    },
    async (c) => {
      // RFC-261：页码分页（用户拍板，非 load-more）。响应从裸数组改封套
      // {items,total,page,pageCount}；receivedAt
      // 游标参数 `before` 删除（仓内零消费）。
      // 钳制必须 isFinite+trunc 守门（评审门 P1-①）：RFC-257 原式 `Math.min(200,
      // Number(...)||50)` 会把 `-1` 交给 drizzle（负 LIMIT 被吞 → 全表 dump），
      // 小数/±Infinity 则 SQLite datatype mismatch 500。
      const limitRaw = Math.trunc(Number(c.req.query('limit') ?? 50))
      const limit = !Number.isFinite(limitRaw) || limitRaw <= 0 ? 50 : Math.min(200, limitRaw)
      const pageRaw = Math.trunc(Number(c.req.query('page') ?? 1))
      const page = !Number.isFinite(pageRaw) || pageRaw <= 0 ? 1 : pageRaw
      const status = z
        .enum(WEBHOOK_DELIVERY_STATUSES)
        .optional()
        .catch(undefined)
        .parse(c.req.query('status'))
      const eventType = CodeHostEventTypeSchema.optional()
        .catch(undefined)
        .parse(c.req.query('eventType'))
      const repoPath = c.req.query('repoPath')
      const endpointId = c.req.query('endpointId')
      return c.json(
        await runtime.queries.page({
          page,
          limit,
          ...(endpointId === undefined || endpointId === '' ? {} : { endpointId }),
          ...(status === undefined ? {} : { status }),
          ...(eventType === undefined ? {} : { eventType }),
          ...(repoPath === undefined || repoPath === '' ? {} : { repoPath }),
        }),
      )
    },
  )

  // RFC-261：仓库过滤下拉的选项源（保留窗内出现过的仓库）。必须挂在 `/:id`
  // 之前，防止字面量 `repos` 被吃进 `:id`。
  registerRoute(
    app,
    {
      method: 'GET',
      path: '/api/webhook-deliveries/repos',
      permissions: ['webhook-endpoints:read'],
      tokenAccess: 'allow',
      summary: 'Distinct repo paths seen in deliveries (filter options)',
    },
    async (c) => {
      return c.json(await runtime.queries.listRepoPaths())
    },
  )

  registerRoute(
    app,
    {
      method: 'GET',
      path: '/api/webhook-deliveries/:id',
      permissions: ['webhook-endpoints:read'],
      tokenAccess: 'allow',
      summary: 'Get one delivery including its raw body',
    },
    async (c) => {
      const row = await runtime.queries.get(c.req.param('id'))
      if (!row) throw new NotFoundError('webhook-delivery-not-found', 'delivery not found')
      const effectDeliveryId = row.replayedFromDeliveryId ?? row.id
      const terminalControl = await runtime.queries.terminalControl(effectDeliveryId, actorOf(c))
      return c.json({
        ...row,
        terminalControl,
      })
    },
  )

  registerRoute(
    app,
    {
      method: 'POST',
      path: '/api/webhook-deliveries/:id/replay',
      permissions: ['webhook-endpoints:manage'],
      tokenAccess: 'never',
      summary: 'Replay a delivery (new row, dedupe bypassed; rejected not replayable)',
    },
    async (c) => {
      const replay = deps.replay
      if (replay === undefined) {
        throw new ConflictError('webhook-ingress-unavailable', 'event publishing is not wired')
      }
      return c.json(await replay.replay(c.req.param('id')))
    },
  )
}

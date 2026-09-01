// RFC-257 T9 — 投递观测面（端点级审计：全仓事件流）。RFC-260 D2：列表与详情
// （含原始 body）随 `webhook-endpoints:read` 全员只读开放（用户拍板——事件源于
// 成员共同的代码平台，对内不构成秘密）；replay 仍 `webhook-endpoints:manage`。
// replay 三规则（multica）：rejected 不可放（绕过拒绝=绕过验签）；重放新建行
// 指回 replayed_from；event_uuid=NULL 绕过去重（replay 就是明确要求再跑一次）。
// GitLab 对失败投递不自动重试（设计门 F-6）——replay 是平台侧的主恢复路径。
import type { Hono } from 'hono'
import { z } from 'zod'

import { CodeHostEventTypeSchema, WEBHOOK_DELIVERY_STATUSES } from '@agent-workflow/shared'

import { actorOf } from '@/auth/actor'
import type { EventCenterModule } from '@/modules/event-center/composition'
import type { WebhookDeliveryRuntime } from '@/modules/integration/composition/webhookIngress'
import type { MrTerminalControl } from '@/modules/integration/public/mrTerminalControl'
import { codeHostEventObservations } from '@/modules/integration/public/events'
import { registerRoute } from '@/routes/registry'
import { CODE_HOST_ADAPTERS, replayHeaders } from '@/services/webhook/codeHostAdapter'
import {
  supportsEventCenterCodeHostDelivery,
  type WebhookDispatcher,
} from '@/services/webhook/dispatcherTypes'
import { ConflictError, NotFoundError, ValidationError } from '@/util/errors'

export function mountWebhookDeliveryRoutes(
  app: Hono,
  deps: {
    readonly webhookDeliveryRuntime: WebhookDeliveryRuntime
    readonly digitalEmployeeEventCenter?: EventCenterModule
    readonly webhookDispatcher?: WebhookDispatcher
    readonly webhookTerminalControl?: MrTerminalControl
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
      const eventCenter = deps.digitalEmployeeEventCenter
      if (
        eventCenter === undefined ||
        deps.webhookDispatcher === undefined ||
        !supportsEventCenterCodeHostDelivery(deps.webhookDispatcher)
      ) {
        throw new ConflictError('webhook-ingress-unavailable', 'event publishing is not wired')
      }
      const row = await runtime.queries.get(c.req.param('id'))
      if (!row) throw new NotFoundError('webhook-delivery-not-found', 'delivery not found')
      if (row.status === 'rejected') {
        // 重放验签失败的投递 = 绕过拒绝（multica 规则 1）。
        throw new ConflictError('webhook-delivery-rejected-not-replayable', 'fix the secret first')
      }
      if (row.status === 'received' || row.status === 'processing') {
        throw new ConflictError('webhook-delivery-in-flight', 'delivery is still being processed')
      }
      if (row.bodyJson === null || row.bodyJson === '') {
        // 保留策略把 body 置空后（F-12），重放无料可用。
        throw new ConflictError('webhook-delivery-body-gone', 'body pruned by retention policy')
      }
      const endpoint = await runtime.endpoints.get(row.endpointId)
      if (!endpoint) {
        throw new ConflictError('webhook-endpoint-not-found', 'owning endpoint was deleted')
      }
      const adapter = CODE_HOST_ADAPTERS[endpoint.provider]
      if (!adapter) throw new ConflictError('webhook-provider-unknown', endpoint.provider)
      let parsed: unknown
      try {
        parsed = JSON.parse(row.bodyJson)
      } catch {
        throw new ValidationError('webhook-delivery-body-invalid', 'stored body is not JSON')
      }
      // RFC-259：事件头从审计列重建——GitHub 的事件种类判别在 X-GitHub-Event
      // 头里不在 body 里，空 HeaderBag 会把每条 GitHub 投递的 replay 判成
      // parse-failed（GitLab 判别在 body.object_kind，重建对它是 no-op）。
      const normalized = adapter.normalize(replayHeaders(adapter, row.gitlabEventHeader), parsed)
      if (!normalized.ok) {
        throw new ValidationError('webhook-delivery-unsupported', normalized.detail)
      }
      const event = { ...normalized.event, eventUuid: null }
      const rootDeliveryId = row.replayedFromDeliveryId ?? row.id
      const root = rootDeliveryId === row.id ? row : await runtime.queries.get(rootDeliveryId)
      if (root === null) {
        throw new ConflictError(
          'webhook-delivery-replay-lineage-broken',
          'original delivery is no longer available',
        )
      }
      const isTerminal = event.eventType === 'mr_closed' || event.eventType === 'mr_merged'
      if (isTerminal) {
        if (root.mrStreamRevision === null) {
          throw new ConflictError(
            'webhook-terminal-replay-root-unprotected',
            'the original terminal delivery predates the durable MR/PR control fact',
          )
        }
        if (!(await runtime.queries.hasTerminalControlEffect(rootDeliveryId))) {
          throw new ConflictError(
            'webhook-terminal-replay-effect-missing',
            'the original terminal control effect is unavailable',
          )
        }
      }
      const insert = await runtime.acceptVerifiedDelivery({
        endpointId: endpoint.id,
        event,
        rawBodyBytes: Buffer.from(row.bodyJson, 'utf8'),
        rawBodyText: row.bodyJson,
        eventHeader: row.gitlabEventHeader,
        objectKind: row.objectKind,
        replay: {
          rootDeliveryId,
          terminalRootRevision: isTerminal ? root.mrStreamRevision : null,
        },
      })
      if (insert.kind !== 'inserted') {
        throw new ConflictError('webhook-delivery-replay-conflict', 'replay was deduplicated')
      }
      const deliveryId = insert.deliveryId
      deps.webhookTerminalControl?.wake(insert.effectId)
      const occurredAt = Date.now()
      const receipts = await Promise.all(
        codeHostEventObservations({
          endpointId: endpoint.id,
          deliveryId,
          event,
          occurredAt,
        }).map((observation) => eventCenter.commands.observe(observation)),
      )
      const published = {
        deliveryCount: receipts.reduce((total, receipt) => total + receipt.deliveryCount, 0),
        deliveryIds: receipts.flatMap((receipt) => receipt.deliveryIds),
      }
      if (published.deliveryCount > 0) {
        await runtime.deliveries.mark({ deliveryId, status: 'matched' })
      } else if (insert.effectId !== null) {
        await runtime.deliveries.mark({
          deliveryId,
          status: 'matched',
          reason: 'terminal-control-accepted',
        })
      } else {
        await runtime.deliveries.mark({
          deliveryId,
          status: 'ignored',
          reason: 'no-trigger-matched',
        })
      }
      for (const eventDeliveryId of published.deliveryIds) {
        void eventCenter.worker.runOneNotification(eventDeliveryId).catch(() => {})
      }
      return c.json({ deliveryId, replayedFrom: row.id, status: 'received' })
    },
  )
}

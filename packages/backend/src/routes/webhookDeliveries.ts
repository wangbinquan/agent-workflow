// RFC-257 T9 — 投递观测面（端点级审计：全仓事件流）。RFC-260 D2：列表与详情
// （含原始 body）随 `webhook-endpoints:read` 全员只读开放（用户拍板——事件源于
// 成员共同的代码平台，对内不构成秘密）；replay 仍 `webhook-endpoints:manage`。
// replay 三规则（multica）：rejected 不可放（绕过拒绝=绕过验签）；重放新建行
// 指回 replayed_from；event_uuid=NULL 绕过去重（replay 就是明确要求再跑一次）。
// GitLab 对失败投递不自动重试（设计门 F-6）——replay 是平台侧的主恢复路径。
import type { Hono } from 'hono'
import { and, desc, eq, lt } from 'drizzle-orm'
import { z } from 'zod'

import { WEBHOOK_DELIVERY_STATUSES } from '@agent-workflow/shared'

import type { AppDeps } from '@/server'
import { registerRoute } from '@/routes/registry'
import { webhookDeliveries, webhookEndpoints } from '@/db/schema'
import { CODE_HOST_ADAPTERS, replayHeaders } from '@/services/webhook/codeHostAdapter'
import { insertDelivery } from '@/services/webhook/deliveryStore'
import { streamKeyOf } from '@/services/webhook/matching'
import { ConflictError, NotFoundError, ValidationError } from '@/util/errors'

export function mountWebhookDeliveryRoutes(app: Hono, deps: AppDeps): void {
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
      const limit = Math.min(200, Number(c.req.query('limit') ?? 50) || 50)
      const before = Number(c.req.query('before') ?? 0) || undefined
      const status = z
        .enum(WEBHOOK_DELIVERY_STATUSES)
        .optional()
        .catch(undefined)
        .parse(c.req.query('status'))
      const endpointId = c.req.query('endpointId')
      const conds = [
        ...(endpointId !== undefined && endpointId !== ''
          ? [eq(webhookDeliveries.endpointId, endpointId)]
          : []),
        ...(status !== undefined ? [eq(webhookDeliveries.status, status)] : []),
        ...(before !== undefined ? [lt(webhookDeliveries.receivedAt, before)] : []),
      ]
      const rows = await deps.db
        .select({
          id: webhookDeliveries.id,
          endpointId: webhookDeliveries.endpointId,
          eventUuid: webhookDeliveries.eventUuid,
          attemptCount: webhookDeliveries.attemptCount,
          gitlabEventHeader: webhookDeliveries.gitlabEventHeader,
          objectKind: webhookDeliveries.objectKind,
          eventType: webhookDeliveries.eventType,
          repoPath: webhookDeliveries.repoPath,
          streamHint: webhookDeliveries.streamHint,
          status: webhookDeliveries.status,
          statusReason: webhookDeliveries.statusReason,
          replayedFromDeliveryId: webhookDeliveries.replayedFromDeliveryId,
          receivedAt: webhookDeliveries.receivedAt,
          // 列表页刻意不带 body_json（≤256KiB/行；详情页单独取）
        })
        .from(webhookDeliveries)
        .where(conds.length > 0 ? and(...conds) : undefined)
        .orderBy(desc(webhookDeliveries.receivedAt))
        .limit(limit)
      return c.json(rows)
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
      const row = (
        await deps.db
          .select()
          .from(webhookDeliveries)
          .where(eq(webhookDeliveries.id, c.req.param('id')))
          .limit(1)
      )[0]
      if (!row) throw new NotFoundError('webhook-delivery-not-found', 'delivery not found')
      return c.json(row)
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
      const dispatcher = deps.webhookDispatcher
      const secretBox = deps.secretBox
      if (!dispatcher || !secretBox) {
        throw new ConflictError('webhook-ingress-unavailable', 'webhook dispatch is not wired')
      }
      const row = (
        await deps.db
          .select()
          .from(webhookDeliveries)
          .where(eq(webhookDeliveries.id, c.req.param('id')))
          .limit(1)
      )[0]
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
      const endpoint = (
        await deps.db
          .select()
          .from(webhookEndpoints)
          .where(eq(webhookEndpoints.id, row.endpointId))
          .limit(1)
      )[0]
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
      const event = { ...normalized.event, eventUuid: null } // 绕过去重（规则 3）
      const insert = await insertDelivery(deps.db, {
        endpointId: endpoint.id,
        eventUuid: null,
        gitlabEventHeader: row.gitlabEventHeader,
        objectKind: row.objectKind,
        eventType: event.eventType,
        repoPath: event.repoPath,
        streamHint: streamKeyOf(event),
        status: 'received',
        bodyJson: row.bodyJson,
        replayedFromDeliveryId: row.id, // 规则 2：新行指回原行
      })
      const deliveryId = insert.deliveryId
      void dispatcher.dispatch({ deliveryId, endpoint, event }).catch(() => {})
      return c.json({ deliveryId, replayedFrom: row.id, status: 'received' })
    },
  )
}

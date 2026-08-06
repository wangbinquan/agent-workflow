// RFC-257 T9 — 投递观测面（端点级审计：全仓事件流）。RFC-260 D2：列表与详情
// （含原始 body）随 `webhook-endpoints:read` 全员只读开放（用户拍板——事件源于
// 成员共同的代码平台，对内不构成秘密）；replay 仍 `webhook-endpoints:manage`。
// replay 三规则（multica）：rejected 不可放（绕过拒绝=绕过验签）；重放新建行
// 指回 replayed_from；event_uuid=NULL 绕过去重（replay 就是明确要求再跑一次）。
// GitLab 对失败投递不自动重试（设计门 F-6）——replay 是平台侧的主恢复路径。
import type { Hono } from 'hono'
import { and, desc, eq, sql } from 'drizzle-orm'
import { z } from 'zod'

import { CodeHostEventTypeSchema, WEBHOOK_DELIVERY_STATUSES } from '@agent-workflow/shared'

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
      // RFC-261：页码分页（用户拍板，非 load-more）。响应从裸数组改封套
      // {items,total,page,pageCount}（tasks /api/tasks/page 先例）；receivedAt
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
      const conds = [
        ...(endpointId !== undefined && endpointId !== ''
          ? [eq(webhookDeliveries.endpointId, endpointId)]
          : []),
        ...(status !== undefined ? [eq(webhookDeliveries.status, status)] : []),
        ...(eventType !== undefined ? [eq(webhookDeliveries.eventType, eventType)] : []),
        ...(repoPath !== undefined && repoPath !== ''
          ? [eq(webhookDeliveries.repoPath, repoPath)]
          : []),
      ]
      const where = conds.length > 0 ? and(...conds) : undefined
      // 先 count 后取页；两查询间的并发插入造成 ±1 瞬时偏差，10s 轮询自愈（design §1.2）。
      const total = (
        await deps.db
          .select({ n: sql<number>`count(*)` })
          .from(webhookDeliveries)
          .where(where)
      )[0]!.n
      const offset = (page - 1) * limit
      // offset ≥ total 短路（评审门 P2-①）：空页探测零成本；total 以内的深
      // offset 是鉴权读面上的已接受成本（design §1.2）。
      const rows =
        offset >= total
          ? []
          : await deps.db
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
              .where(where)
              // id（ULID）tie-break：同毫秒行在裸 receivedAt 排序下顺序未定义，
              // OFFSET 翻页会跨页重/漏（AC-2）。
              .orderBy(desc(webhookDeliveries.receivedAt), desc(webhookDeliveries.id))
              .limit(limit)
              .offset(offset)
      return c.json({
        items: rows,
        total,
        page,
        pageCount: Math.max(1, Math.ceil(total / limit)),
      })
    },
  )

  // RFC-261：仓库过滤下拉的选项源（保留窗内出现过的仓库）。必须挂在 `/:id`
  // 之前，防止字面量 `repos` 被吃进 `:id`（routes/tasks.ts `/api/tasks/page` 同款）。
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
      // Loose index scan（递归 CTE + idx_webhook_deliveries_repo_time 前缀）：
      // K 个 distinct 仓库 = K×logN 次索引寻位。朴素 SELECT DISTINCT 在 10 万
      // 投递/天 × 90 天 ≈ 900 万行上是每 30s 轮询一次的全索引扫描。
      const rows = await deps.db.all<{ p: string }>(sql`
        WITH RECURSIVE repo_walk(p) AS (
          SELECT (SELECT min(repo_path) FROM webhook_deliveries WHERE repo_path IS NOT NULL)
          UNION ALL
          SELECT (SELECT min(repo_path) FROM webhook_deliveries WHERE repo_path > repo_walk.p)
            FROM repo_walk WHERE repo_walk.p IS NOT NULL
        )
        SELECT p FROM repo_walk WHERE p IS NOT NULL
      `)
      return c.json(rows.map((r) => r.p))
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

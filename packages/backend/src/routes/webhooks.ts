// RFC-257 T5 — webhook 入站接收端点（同步段）。
// POST /webhooks/:provider/:urlToken —— 顶级路径，天然不经 multiAuth（server.ts
// 只在 /api/* 上挂鉴权），公开性经 registerRoute publicReason 显式声明并被
// assertRouteMetaCoverage 启动自检锁定。
//
// 三段式（D23）：同步段做 限流→端点查找→body 上限→验签→解析→去重→插
// received 行→**立即 200**；分发（supersede 的 cancel 轮询最多 5s、auto-register
// clone 分钟级）交给注入的 dispatcher 异步跑——GitLab webhook ~10s 超时且失败
// **不自动重试**（设计门 F-4/F-6），同步分发必然超时且重投无门。
//
// 状态码语义（design §3.3，proposal D20）：凡「平台侧决定不处理」一律 200——
// 对 GitLab 回 4xx/5xx 会累积 auto-disable，把几百仓共用的唯一 group hook 整个
// 禁掉（proposal §6.5）。401 只给验签失败（运维必须在 GitLab Recent Deliveries
// 看见红色才会去修 secret），500 只给真内部错误。
import type { Hono } from 'hono'
import { eq } from 'drizzle-orm'

import type { AppDeps } from '@/server'
import { registerRoute } from '@/routes/registry'
import { webhookEndpoints } from '@/db/schema'
import { CODE_HOST_ADAPTERS, type HeaderBag } from '@/services/webhook/gitlabAdapter'
import {
  insertDelivery,
  markDelivery,
  touchEndpointLastDelivery,
  type InsertDeliveryInput,
} from '@/services/webhook/deliveryStore'
import { streamKeyOf } from '@/services/webhook/matching'
import { createWebhookRateLimiters, type WebhookRateLimiters } from '@/services/webhook/rateLimiter'
import type { CodeHostEvent } from '@agent-workflow/shared'
import { createLogger } from '@/util/log'

const log = createLogger('webhook-ingress')

/** HTTP 层 body 上限（流式截断；入库另有 256KiB 截断）。 */
export const WEBHOOK_BODY_MAX_BYTES = 1024 * 1024

export type WebhookEndpointRow = typeof webhookEndpoints.$inferSelect

/**
 * 异步分发器（T6 webhookDispatch 实装）。契约：接手 received 行后负责推进
 * processing → 终态（matched/ignored/failed）；本路由对 dispatch 的 Promise
 * 只 catch 标 failed，绝不 await 在响应路径上。
 */
export interface WebhookDispatcher {
  dispatch(input: {
    deliveryId: string
    endpoint: WebhookEndpointRow
    event: CodeHostEvent
  }): Promise<void>
}

/** 流式读 body，超限返回 null（→ 413）。 */
async function readBodyLimited(req: Request, limitBytes: number): Promise<string | null> {
  const body = req.body
  if (body === null) return ''
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > limitBytes) {
      await reader.cancel()
      return null
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

const NOT_FOUND = { error: 'not-found' } as const

/** 摘要列用的 object_kind 提取（类型窄化，零 cast——routes-no-cast 锁）。 */
function objectKindOf(parsed: unknown): string {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return ''
  const value = Object.entries(parsed).find(([k]) => k === 'object_kind')?.[1]
  return typeof value === 'string' ? value : ''
}

export function mountWebhookIngressRoutes(
  app: Hono,
  deps: AppDeps,
  opts?: { limiters?: WebhookRateLimiters },
): void {
  const secretBox = deps.secretBox
  if (!secretBox || !deps.webhookDispatcher) {
    // 对齐 OIDC 的自我跳过惯例（server.ts:330）：装配缺件时不挂载入站面，
    // 管理面（批次二）会以显式错误提示，而不是留一个必 500 的公开路由。
    return
  }
  const dispatcher = deps.webhookDispatcher
  const limiters = opts?.limiters ?? createWebhookRateLimiters()

  registerRoute(
    app,
    {
      method: 'POST',
      path: '/webhooks/:provider/:urlToken',
      permissions: [],
      publicReason:
        'code-host webhook ingress; the caller is GitLab, not a platform user — authenticated by the per-endpoint secret token (constant-time compare) plus the high-entropy URL token, never by session/PAT',
      tokenAccess: 'allow',
      summary: 'Receive a code-host webhook delivery (RFC-257)',
    },
    async (c) => {
      const providerParam = c.req.param('provider')
      const urlToken = c.req.param('urlToken')
      const adapter = CODE_HOST_ADAPTERS[providerParam]
      if (!adapter) {
        // provider 段不存在与 token 不存在同形（AC-2）
        limiters.unmatched.allow('global')
        return c.json(NOT_FOUND, 404)
      }

      // 端点查找。DB error 必须走 500 而不是塌缩 404（multica 教训：GitLab 对
      // 404 不重投，DB 抖动会静默丢真投递）——drizzle 抛异常由外层 onError 变
      // 500，此处只处理「查到了没有」。
      const endpoint = (
        await deps.db
          .select()
          .from(webhookEndpoints)
          .where(eq(webhookEndpoints.urlToken, urlToken))
          .limit(1)
      )[0]
      if (!endpoint || endpoint.provider !== providerParam) {
        if (!limiters.unmatched.allow('global')) return c.json({ error: 'rate-limited' }, 429)
        return c.json(NOT_FOUND, 404)
      }

      if (!limiters.perEndpoint.allow(endpoint.id)) {
        return c.json({ error: 'rate-limited' }, 429)
      }

      const rawBody = await readBodyLimited(c.req.raw, WEBHOOK_BODY_MAX_BYTES)
      if (rawBody === null) return c.json({ error: 'payload-too-large' }, 413)

      const headers: HeaderBag = {
        'x-gitlab-token': c.req.header('x-gitlab-token'),
        'x-gitlab-event-uuid': c.req.header('x-gitlab-event-uuid'),
      }
      const eventUuid = headers['x-gitlab-event-uuid'] ?? null
      const gitlabEventHeader = c.req.header('x-gitlab-event') ?? null

      const baseRow: Omit<InsertDeliveryInput, 'status' | 'statusReason'> = {
        endpointId: endpoint.id,
        eventUuid,
        gitlabEventHeader,
        bodyJson: rawBody,
      }

      let secret: string
      try {
        secret = secretBox.unseal(endpoint.secretEnc)
      } catch {
        // secret.key 轮换/丢失：端点级配置故障，真 500（让管理员在两侧都看见）。
        log.error('webhook endpoint secret unseal failed', { endpointId: endpoint.id })
        return c.json({ error: 'internal-error' }, 500)
      }

      const verdict = adapter.verify(headers, secret)
      if (verdict !== 'valid') {
        // rejected 行不占去重索引位（迁移 0138 partial index）：修正 secret 后
        // 同 UUID 的手工 Resend 能真正落地（AC-3）。
        await insertDelivery(deps.db, {
          ...baseRow,
          status: 'rejected',
          statusReason: verdict === 'missing' ? 'missing-token' : 'invalid-token',
        })
        return c.json({ error: 'signature-rejected' }, 401)
      }

      let parsed: unknown
      try {
        parsed = JSON.parse(rawBody === '' ? 'null' : rawBody)
      } catch {
        parsed = undefined
      }
      if (parsed === undefined || parsed === null) {
        // 非 JSON body：真实 GitLab 不会发——400 不喂 auto-disable 计数的前提
        // 是它只来自扫描器/误配置调用方。
        await insertDelivery(deps.db, {
          ...baseRow,
          status: 'ignored',
          statusReason: 'parse-failed',
        })
        return c.json({ error: 'invalid-json' }, 400)
      }

      const normalized = adapter.normalize(headers, parsed)
      const objectKind = objectKindOf(parsed)
      if (!normalized.ok) {
        // 合法 GitLab 投递但平台不处理（未支持的事件/中间态/缺字段）→ 一律
        // 200 + ignored：4xx 会累积 GitLab auto-disable（proposal §6.5）。
        const insert = await insertDelivery(deps.db, {
          ...baseRow,
          objectKind: objectKind || null,
          status: 'ignored',
          statusReason:
            normalized.reason === 'unsupported-event' ? 'unsupported-event' : 'parse-failed',
        })
        return c.json({ deliveryId: insert.deliveryId, status: 'ignored' })
      }
      const event = normalized.event

      if (!endpoint.enabled) {
        const insert = await insertDelivery(deps.db, {
          ...baseRow,
          objectKind: objectKind || null,
          eventType: event.eventType,
          repoPath: event.repoPath,
          streamHint: streamKeyOf(event),
          status: 'ignored',
          statusReason: 'endpoint-disabled',
        })
        return c.json({ deliveryId: insert.deliveryId, status: 'ignored' })
      }

      const insert = await insertDelivery(deps.db, {
        ...baseRow,
        objectKind: objectKind || null,
        eventType: event.eventType,
        repoPath: event.repoPath,
        streamHint: streamKeyOf(event),
        status: 'received',
      })
      if (insert.kind === 'duplicate') {
        // 同 UUID 重投（GitLab Resend / 网络重放）：不重复分发，回原行。
        return c.json({
          deliveryId: insert.deliveryId,
          status: 'duplicate',
          attemptCount: insert.attemptCount,
        })
      }

      const deliveryId = insert.deliveryId
      void touchEndpointLastDelivery(deps.db, endpoint.id, Date.now()).catch(() => {})
      // 异步分发：响应先行（AC-5）。dispatch 内部负责 processing→终态；这里只
      // 兜「dispatch 自身同步抛/整体 reject」的最后一层，标 failed 供 replay。
      void dispatcher.dispatch({ deliveryId, endpoint, event }).catch(async (err: unknown) => {
        log.error('webhook dispatch crashed', { deliveryId, error: String(err) })
        await markDelivery(deps.db, deliveryId, 'failed', 'internal-error').catch(() => {})
      })
      return c.json({ deliveryId, status: 'received' })
    },
  )
}

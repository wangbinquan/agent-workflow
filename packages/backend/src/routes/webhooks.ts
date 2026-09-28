// RFC-257 T5 — webhook 入站接收端点（同步段）。
// POST /webhooks/:provider/:urlToken —— 顶级路径，天然不经 multiAuth（server.ts
// 只在 /api/* 上挂鉴权），公开性经 registerRoute publicReason 显式声明并被
// assertRouteMetaCoverage 启动自检锁定。
//
// 三段式（D23）：同步段做 限流→端点查找→body 上限→验签→解析→去重→原始
// audit 与 immutable Event/Delivery 落库；随后即返回 200。subscriber 消费
// （supersede 的 cancel 轮询最多 5s、auto-register clone 分钟级）由 Event Center
// 异步跑——GitLab 与 GitHub 均 ~10s 超时且失败不自动重试（设计门 F-4/F-6）。
// Event publish 失败会把原始行置 failed，释放 provider UUID 供人工 Resend 修复；
// publish 已成功但响应丢失时，稳定 UUID 只会命中同一 Event。
//
// 状态码语义（design §3.3，proposal D20）：凡「平台侧决定不处理」一律 200——
// 对 GitLab 回 4xx/5xx 会累积 auto-disable，把几百仓共用的唯一 group hook 整个
// 禁掉（proposal §6.5）。401 只给验签失败（运维必须在 GitLab Recent Deliveries
// 看见红色才会去修 secret），500 只给真内部错误。
import type { Hono } from 'hono'

import type { SecretBox } from '@/auth/secretBox'
import { registerRoute } from '@/routes/registry'
import { CODE_HOST_ADAPTERS, type HeaderBag } from '@/services/webhook/codeHostAdapter'
import { insertDelivery, type InsertDeliveryInput } from '@/services/webhook/deliveryStore'
import { streamKeyOf } from '@/services/webhook/matching'
import { createWebhookRateLimiters, type WebhookRateLimiters } from '@/services/webhook/rateLimiter'
import { createLogger } from '@/util/log'
import type { VerifiedWebhookIngressCommands } from '@/modules/integration/public/commands'
import type { WebhookIngressPersistence } from '@/modules/integration/composition/webhookIngress'

const log = createLogger('webhook-ingress')

/** HTTP 层 body 上限（流式截断；入库另有 256KiB 截断）。 */
export const WEBHOOK_BODY_MAX_BYTES = 1024 * 1024

type LimitedBody = { bytes: Uint8Array; text: string }

/**
 * 流式读 body，超限返回 null（→ 413）。字节与文本双持有（RFC-259 D2）：
 * GitHub HMAC 对**原始字节**验签，JSON 解析与入库用 utf8 文本。
 */
async function readBodyLimited(req: Request, limitBytes: number): Promise<LimitedBody | null> {
  const body = req.body
  if (body === null) return { bytes: new Uint8Array(0), text: '' }
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
  const merged = Buffer.concat(chunks)
  return { bytes: merged, text: merged.toString('utf8') }
}

const NOT_FOUND = { error: 'not-found' } as const

export function mountWebhookIngressRoutes(
  app: Hono,
  deps: {
    readonly webhookIngressPersistence: WebhookIngressPersistence
    readonly secretBox?: SecretBox
    readonly verifiedIngress?: VerifiedWebhookIngressCommands
  },
  opts?: { limiters?: WebhookRateLimiters },
): void {
  const secretBox = deps.secretBox
  const ingress = deps.verifiedIngress
  if (!secretBox || ingress === undefined) {
    // 对齐 OIDC 的自我跳过惯例（server.ts:330）：装配缺件时不挂载入站面，
    // 管理面（批次二）会以显式错误提示，而不是留一个必 500 的公开路由。
    return
  }
  const persistence = deps.webhookIngressPersistence
  const limiters = opts?.limiters ?? createWebhookRateLimiters()

  registerRoute(
    app,
    {
      method: 'POST',
      path: '/webhooks/:provider/:urlToken',
      permissions: [],
      publicReason:
        'code-host webhook ingress; the caller is the code host (GitLab/GitHub), not a platform user — authenticated by the per-endpoint secret (constant-time token compare or HMAC signature) plus the high-entropy URL token, never by session/PAT',
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
      const endpoint = await persistence.endpoints.getByUrlToken(urlToken)
      if (!endpoint || endpoint.provider !== providerParam) {
        if (!limiters.unmatched.allow('global')) return c.json({ error: 'rate-limited' }, 429)
        return c.json(NOT_FOUND, 404)
      }

      if (!limiters.perEndpoint.allow(endpoint.id)) {
        return c.json({ error: 'rate-limited' }, 429)
      }

      const rawBody = await readBodyLimited(c.req.raw, WEBHOOK_BODY_MAX_BYTES)
      if (rawBody === null) return c.json({ error: 'payload-too-large' }, 413)

      // provider 头知识全在 adapter（RFC-259 D9）：按 allowlist 构造 HeaderBag，
      // 去重 id / 原始事件头 / 摘要判别符走 adapter 方法，此处零 provider 分支。
      const headers: HeaderBag = Object.fromEntries(
        adapter.headerAllowlist.map((h) => [h, c.req.header(h)]),
      )
      const eventUuid = headers[adapter.deliveryIdHeader] ?? null

      const baseRow: Omit<InsertDeliveryInput, 'status' | 'statusReason'> = {
        endpointId: endpoint.id,
        eventUuid,
        gitlabEventHeader: headers[adapter.eventHeader] ?? null,
        bodyJson: rawBody.text,
      }

      let secret: string
      try {
        secret = secretBox.unseal(endpoint.secretEnc)
      } catch {
        // secret.key 轮换/丢失：端点级配置故障，真 500（让管理员在两侧都看见）。
        log.error('webhook endpoint secret unseal failed', { endpointId: endpoint.id })
        return c.json({ error: 'internal-error' }, 500)
      }

      const verdict = adapter.verify(headers, rawBody.bytes, secret)
      if (verdict !== 'valid') {
        // rejected 行不占去重索引位（迁移 0138 partial index）：修正 secret 后
        // 同 UUID 的手工 Resend 能真正落地（AC-3）。
        await insertDelivery(persistence.deliveries, {
          ...baseRow,
          status: 'rejected',
          statusReason: verdict === 'missing' ? 'missing-token' : 'invalid-token',
        })
        return c.json({ error: 'signature-rejected' }, 401)
      }

      let parsed: unknown
      try {
        parsed = JSON.parse(rawBody.text === '' ? 'null' : rawBody.text)
      } catch {
        parsed = undefined
      }
      if (parsed === undefined || parsed === null) {
        // 非 JSON body：真实 code host 不这么发——常见来源是扫描器/误配置调用方
        // （GitHub 侧典型 = content type 忘改 application/json，body 是
        // `payload=<urlencoded>`；验签会过、解析在此终结，排障表写明）。
        await insertDelivery(persistence.deliveries, {
          ...baseRow,
          status: 'ignored',
          statusReason: 'parse-failed',
        })
        return c.json({ error: 'invalid-json' }, 400)
      }

      const normalized = adapter.normalize(headers, parsed)
      const objectKind = adapter.summaryKindOf(headers, parsed)
      if (!normalized.ok) {
        // 合法 GitLab 投递但平台不处理（未支持的事件/中间态/缺字段）→ 一律
        // 200 + ignored：4xx 会累积 GitLab auto-disable（proposal §6.5）。
        const insert = await insertDelivery(persistence.deliveries, {
          ...baseRow,
          objectKind,
          status: 'ignored',
          statusReason:
            normalized.reason === 'unsupported-event' ? 'unsupported-event' : 'parse-failed',
        })
        return c.json({ deliveryId: insert.deliveryId, status: 'ignored' })
      }
      const event = normalized.event

      if (!endpoint.enabled) {
        const insert = await insertDelivery(persistence.deliveries, {
          ...baseRow,
          objectKind,
          eventType: event.eventType,
          repoPath: event.repoPath,
          streamHint: streamKeyOf(event),
          status: 'ignored',
          statusReason: 'endpoint-disabled',
        })
        return c.json({ deliveryId: insert.deliveryId, status: 'ignored' })
      }

      const receipt = await ingress.receive({
        endpointId: endpoint.id,
        event,
        rawBodyBytes: rawBody.bytes,
        rawBodyText: rawBody.text,
        eventHeader: baseRow.gitlabEventHeader ?? null,
        objectKind: objectKind || null,
      })
      return c.json(receipt)
    },
  )
}

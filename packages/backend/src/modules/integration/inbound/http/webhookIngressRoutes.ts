// RFC-257 T5 — webhook 入站接收端点（同步段）。
// POST /webhooks/:provider/:urlToken —— 顶级路径，天然不经 multiAuth（server.ts
// 只在 /api/* 上挂鉴权），公开性经 registerRoute publicReason 显式声明并被
// assertRouteMetaCoverage 启动自检锁定。
//
// RFC-437：自 routes/webhooks.ts 归入 integration 的 inbound/http。同步段的判定顺序与分支收进
// application/receiveCodeHostWebhook；本绑定只做流式截断读正文、按名取头、调用用例与结果映射。
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

import { registerRoute } from '@/routes/registry'
import type {
  CodeHostWebhookBody,
  CodeHostWebhookReceiver,
} from '../../application/receiveCodeHostWebhook'

/**
 * 流式读 body，超限返回 null（→ 413）。字节与文本双持有（RFC-259 D2）：
 * GitHub HMAC 对**原始字节**验签，JSON 解析与入库用 utf8 文本。
 */
async function readBodyLimited(
  req: Request,
  limitBytes: number,
): Promise<CodeHostWebhookBody | null> {
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
  deps: { readonly receiver?: CodeHostWebhookReceiver },
): void {
  const receiver = deps.receiver
  if (receiver === undefined) {
    // 对齐 OIDC 的自我跳过惯例（server.ts:330）：装配缺件时不挂载入站面，
    // 管理面（批次二）会以显式错误提示，而不是留一个必 500 的公开路由。
    return
  }

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
      const outcome = await receiver.receive({
        provider: c.req.param('provider'),
        urlToken: c.req.param('urlToken'),
        header: (name) => c.req.header(name),
        readBody: (limitBytes) => readBodyLimited(c.req.raw, limitBytes),
      })
      switch (outcome.kind) {
        case 'not-found':
          return c.json(NOT_FOUND, 404)
        case 'rate-limited':
          return c.json({ error: 'rate-limited' }, 429)
        case 'payload-too-large':
          return c.json({ error: 'payload-too-large' }, 413)
        case 'internal-error':
          return c.json({ error: 'internal-error' }, 500)
        case 'signature-rejected':
          return c.json({ error: 'signature-rejected' }, 401)
        case 'invalid-json':
          return c.json({ error: 'invalid-json' }, 400)
        case 'ignored':
          return c.json({ deliveryId: outcome.deliveryId, status: 'ignored' })
        case 'accepted':
          return c.json(outcome.receipt)
      }
    },
  )
}

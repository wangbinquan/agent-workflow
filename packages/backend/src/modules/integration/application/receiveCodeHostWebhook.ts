// RFC-437 — 代码平台 Webhook 入站接收的同步段（自 routes/webhooks.ts 抽出，顺序与分支逐条不变）。
//
// 三段式（RFC-257 D23）：同步段做 限流→端点查找→body 上限→验签→解析→去重→原始
// audit 与 immutable Event/Delivery 落库；随后即返回。subscriber 消费由 Event Center 异步跑。
//
// 结果语义（RFC-257 design §3.3，proposal D20）：凡「平台侧决定不处理」一律成功应答
// （`ignored`）——对 GitLab 回 4xx/5xx 会累积 auto-disable，把几百仓共用的唯一 group hook
// 整个禁掉（proposal §6.5）。`signature-rejected` 只给验签失败，`internal-error` 只给真内部错误。
// 绑定负责把结果映射为 HTTP 状态与响应体。
import type { HeaderBag } from '../domain/codeHostNormalization'
import { CODE_HOST_ADAPTERS } from '../domain/codeHostAdapters'
import { streamKeyOf } from '../domain/webhookTriggerMatching'
import type {
  VerifiedWebhookIngressCommands,
  VerifiedWebhookIngressReceipt,
} from './ports/verifiedWebhookIngress'
import type { WebhookIngressPersistence } from './ports/webhookIngressPersistence'
import { insertDelivery, type InsertDeliveryInput } from './webhookDeliveryStore'
import type { WebhookRateLimiters } from './webhookRateLimiter'
import { createLogger } from '@/util/log'

const log = createLogger('webhook-ingress')

/** 正文上限（流式截断；入库另有 256KiB 截断）。 */
export const WEBHOOK_BODY_MAX_BYTES = 1024 * 1024

/** 字节与文本双持有（RFC-259 D2）：GitHub HMAC 对原始字节验签，JSON 解析与入库用 utf8 文本。 */
export interface CodeHostWebhookBody {
  readonly bytes: Uint8Array
  readonly text: string
}

export interface CodeHostWebhookRequest {
  readonly provider: string
  readonly urlToken: string
  /** One request header by lower-case name; only the adapter's allowlist is read. */
  header(name: string): string | undefined
  /** Reads the body up to `limitBytes`; null when it is larger. Called only after admission. */
  readBody(limitBytes: number): Promise<CodeHostWebhookBody | null>
}

export type CodeHostWebhookOutcome =
  | Readonly<{ kind: 'not-found' }>
  | Readonly<{ kind: 'rate-limited' }>
  | Readonly<{ kind: 'payload-too-large' }>
  | Readonly<{ kind: 'internal-error' }>
  | Readonly<{ kind: 'signature-rejected' }>
  | Readonly<{ kind: 'invalid-json' }>
  | Readonly<{ kind: 'ignored'; deliveryId: string }>
  | Readonly<{ kind: 'accepted'; receipt: VerifiedWebhookIngressReceipt }>

export interface CodeHostWebhookReceiver {
  receive(request: CodeHostWebhookRequest): Promise<CodeHostWebhookOutcome>
}

export interface CodeHostWebhookReceiverDependencies {
  readonly persistence: WebhookIngressPersistence
  readonly unseal: (secretEnc: string) => string
  readonly verifiedIngress: VerifiedWebhookIngressCommands
  readonly limiters: WebhookRateLimiters
}

const NOT_FOUND = Object.freeze({ kind: 'not-found' as const })
const RATE_LIMITED = Object.freeze({ kind: 'rate-limited' as const })

export function createCodeHostWebhookReceiver(
  deps: CodeHostWebhookReceiverDependencies,
): CodeHostWebhookReceiver {
  const persistence = deps.persistence
  const limiters = deps.limiters
  return Object.freeze({
    async receive(request: CodeHostWebhookRequest): Promise<CodeHostWebhookOutcome> {
      const adapter = CODE_HOST_ADAPTERS[request.provider]
      if (!adapter) {
        // provider 段不存在与 token 不存在同形（AC-2）
        limiters.unmatched.allow('global')
        return NOT_FOUND
      }

      // 端点查找。DB error 必须走 500 而不是塌缩 404（multica 教训：GitLab 对
      // 404 不重投，DB 抖动会静默丢真投递）——异常由外层 onError 变 500，
      // 此处只处理「查到了没有」。
      const endpoint = await persistence.endpoints.getByUrlToken(request.urlToken)
      if (!endpoint || endpoint.provider !== request.provider) {
        if (!limiters.unmatched.allow('global')) return RATE_LIMITED
        return NOT_FOUND
      }

      if (!limiters.perEndpoint.allow(endpoint.id)) return RATE_LIMITED

      const rawBody = await request.readBody(WEBHOOK_BODY_MAX_BYTES)
      if (rawBody === null) return { kind: 'payload-too-large' }

      // provider 头知识全在 adapter（RFC-259 D9）：按 allowlist 构造 HeaderBag，
      // 去重 id / 原始事件头 / 摘要判别符走 adapter 方法，此处零 provider 分支。
      const headers: HeaderBag = Object.fromEntries(
        adapter.headerAllowlist.map((h) => [h, request.header(h)]),
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
        secret = deps.unseal(endpoint.secretEnc)
      } catch {
        // secret.key 轮换/丢失：端点级配置故障，真内部错误（让管理员在两侧都看见）。
        log.error('webhook endpoint secret unseal failed', { endpointId: endpoint.id })
        return { kind: 'internal-error' }
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
        return { kind: 'signature-rejected' }
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
        return { kind: 'invalid-json' }
      }

      const normalized = adapter.normalize(headers, parsed)
      const objectKind = adapter.summaryKindOf(headers, parsed)
      if (!normalized.ok) {
        // 合法 GitLab 投递但平台不处理（未支持的事件/中间态/缺字段）→ 一律
        // ignored：4xx 会累积 GitLab auto-disable（proposal §6.5）。
        const insert = await insertDelivery(persistence.deliveries, {
          ...baseRow,
          objectKind,
          status: 'ignored',
          statusReason:
            normalized.reason === 'unsupported-event' ? 'unsupported-event' : 'parse-failed',
        })
        return { kind: 'ignored', deliveryId: insert.deliveryId }
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
        return { kind: 'ignored', deliveryId: insert.deliveryId }
      }

      const receipt = await deps.verifiedIngress.receive({
        endpointId: endpoint.id,
        event,
        rawBodyBytes: rawBody.bytes,
        rawBodyText: rawBody.text,
        eventHeader: baseRow.gitlabEventHeader ?? null,
        objectKind: objectKind || null,
      })
      return { kind: 'accepted', receipt }
    },
  })
}

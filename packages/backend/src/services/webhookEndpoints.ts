// RFC-284 T28（审计 N10 主证）—— webhook 端点 CRUD 自 routes/webhookEndpoints.ts
// 薄壳化下沉：路由层只剩 registerRoute 元数据 + actor/param 抽取，全部
// db/schema/secret/config 访问与业务判定在本文件。行为承诺：RFC-283/292 落地后的
// 字节级保留——保真判据是 rfc257-webhook-management 等既有套件全绿（非人工比对）。
//
// 领域注释（自 routes 原文迁入）：
// 端点 = 平台基础设施（验签 secret + 公开 URL token）。写面（CRUD/轮换）走
// `webhook-endpoints:manage`（system 域：零令牌面——RFC-253 scripts:author 先例），
// tokenAccess:'never' 双保险；读面（RFC-260）走矩阵点 `webhook-endpoints:read`
// （全员基线），但 **URL 明文按 viewer 分层**：只有持有
// `webhook-endpoints:manage` 的 session 请求拿明文；无权限者与一切 PAT 拿 null + 尾 4 位
// urlTokenHint——RFC-257 D19「ingress 面不上令牌」在读点开放后由响应分层继续兑现。
// secret 三形态（RFC-255 姿势）：创建/轮换响应一次性明文、存储 secretBox 密封、
// 读取面只有 hasSecret + 尾 4 位 hint。
import { randomBytes } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'

import {
  CreateWebhookEndpointSchema,
  UpdateWebhookEndpointSchema,
  type WebhookEndpoint,
} from '@agent-workflow/shared'
import type { Actor } from '@/auth/actor'
import type { SecretBox } from '@/auth/secretBox'
import type { DbClient } from '@/db/client'
import { webhookEndpoints, webhookTriggers } from '@/db/schema'
import { loadConfig } from '@/config'
import { ConflictError, NotFoundError, ValidationError } from '@/util/errors'

export interface WebhookEndpointServiceDeps {
  db: DbClient
  configPath: string
  secretBox: SecretBox
}

type Row = typeof webhookEndpoints.$inferSelect

/** 端点 wire + viewer 分层后的 ingressUrl（列表/详情/写响应共用形状）。 */
export type WebhookEndpointWire = WebhookEndpoint & { ingressUrl: string | null }

function mintUrlToken(): string {
  return `aw_whk_${randomBytes(32).toString('base64url')}`
}

function mintSecret(): string {
  return randomBytes(32).toString('base64url')
}

/**
 * RFC-260/RFC-305 — URL 明文要求端点管理权限与交互 session。其余（无权限、
 * PAT、daemon 内部调用）一律掩码——fail-closed，新增 ActorSource 值默认拿不到
 * 明文。
 */
function revealsUrl(actor: Actor): boolean {
  return actor.permissions.has('webhook-endpoints:manage') && actor.source === 'session'
}

function unsealHintOf(secretBox: SecretBox, enc: string): string | null {
  try {
    const plain = secretBox.unseal(enc)
    return plain.length >= 4 ? plain.slice(-4) : null
  } catch {
    return null
  }
}

function toWire(deps: WebhookEndpointServiceDeps, row: Row, viewer: Actor): WebhookEndpoint {
  const hint = unsealHintOf(deps.secretBox, row.secretEnc)
  const reveal = revealsUrl(viewer)
  return {
    id: row.id,
    name: row.name,
    provider: row.provider,
    urlToken: reveal ? row.urlToken : null,
    urlTokenHint: row.urlToken.length >= 4 ? row.urlToken.slice(-4) : null,
    enabled: row.enabled,
    preferredCloneProtocol: row.preferredCloneProtocol,
    hasSecret: row.secretEnc.length > 0,
    secretHint: hint,
    lastDeliveryAt: row.lastDeliveryAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

/** 给代码平台填的完整 URL：只能由 publicBaseUrl 拼装（禁 c.req.url，audit-backlog:81）。 */
function ingressUrlOf(configPath: string, row: Pick<Row, 'provider' | 'urlToken'>): string | null {
  let base: string | undefined
  try {
    base = loadConfig(configPath).publicBaseUrl
  } catch {
    base = undefined // config 不可读（测试装配/首启竞态）→ UI 显示相对路径提示
  }
  if (base === undefined) return null
  return `${base.replace(/\/+$/, '')}/webhooks/${row.provider}/${row.urlToken}`
}

/** ingressUrl 的同一分层：明文 URL 含 urlToken，非明文 viewer 一律 null。 */
function ingressUrlFor(configPath: string, row: Row, viewer: Actor): string | null {
  return revealsUrl(viewer) ? ingressUrlOf(configPath, row) : null
}

function wireWithIngress(
  deps: WebhookEndpointServiceDeps,
  row: Row,
  viewer: Actor,
): WebhookEndpointWire {
  return { ...toWire(deps, row, viewer), ingressUrl: ingressUrlFor(deps.configPath, row, viewer) }
}

export async function listWebhookEndpoints(
  deps: WebhookEndpointServiceDeps,
  viewer: Actor,
): Promise<WebhookEndpointWire[]> {
  const rows = await deps.db.select().from(webhookEndpoints)
  return rows.map((r) => wireWithIngress(deps, r, viewer))
}

export async function getWebhookEndpoint(
  deps: WebhookEndpointServiceDeps,
  viewer: Actor,
  id: string,
): Promise<WebhookEndpointWire> {
  const row = (
    await deps.db.select().from(webhookEndpoints).where(eq(webhookEndpoints.id, id)).limit(1)
  )[0]
  if (!row) throw new NotFoundError('webhook-endpoint-not-found', 'endpoint not found')
  return wireWithIngress(deps, row, viewer)
}

export async function createWebhookEndpoint(
  deps: WebhookEndpointServiceDeps,
  viewer: Actor,
  rawBody: unknown,
): Promise<WebhookEndpointWire & { secret: string }> {
  const parsed = CreateWebhookEndpointSchema.safeParse(rawBody)
  if (!parsed.success) {
    throw new ValidationError('webhook-endpoint-invalid', 'invalid endpoint body', {
      issues: parsed.error.issues,
    })
  }
  const secret = mintSecret()
  const id = ulid()
  // 铸造与 INSERT 同语句 + 冲突重试（multica createWebhookTriggerWithMintedToken
  // 模式）：绝不出现「行存在但 token 待补」的半写状态。
  let row: Row | undefined
  for (let attempt = 0; attempt < 3 && row === undefined; attempt++) {
    try {
      row = (
        await deps.db
          .insert(webhookEndpoints)
          .values({
            id,
            name: parsed.data.name,
            provider: parsed.data.provider,
            urlToken: mintUrlToken(),
            secretEnc: deps.secretBox.seal(secret),
            preferredCloneProtocol: parsed.data.preferredCloneProtocol,
          })
          .returning()
      )[0]
    } catch (err) {
      if (!(err instanceof Error && /UNIQUE constraint failed/i.test(err.message))) throw err
    }
  }
  if (row === undefined) {
    throw new ConflictError('webhook-endpoint-token-mint-failed', 'url token minting collided')
  }
  // 一次性明文：仅此响应携带；之后只有掩码 hint。
  return { ...wireWithIngress(deps, row, viewer), secret }
}

export async function updateWebhookEndpoint(
  deps: WebhookEndpointServiceDeps,
  viewer: Actor,
  id: string,
  rawBody: unknown,
): Promise<WebhookEndpointWire> {
  const parsed = UpdateWebhookEndpointSchema.safeParse(rawBody)
  if (!parsed.success) {
    throw new ValidationError('webhook-endpoint-invalid', 'invalid endpoint patch', {
      issues: parsed.error.issues,
    })
  }
  const rows = await deps.db
    .update(webhookEndpoints)
    .set({ ...parsed.data, updatedAt: Date.now() })
    .where(eq(webhookEndpoints.id, id))
    .returning()
  const row = rows[0]
  if (!row) throw new NotFoundError('webhook-endpoint-not-found', 'endpoint not found')
  return wireWithIngress(deps, row, viewer)
}

export async function deleteWebhookEndpoint(
  deps: Pick<WebhookEndpointServiceDeps, 'db'>,
  id: string,
): Promise<void> {
  const refs = await deps.db
    .select({ id: webhookTriggers.id })
    .from(webhookTriggers)
    .where(eq(webhookTriggers.endpointId, id))
    .limit(1)
  if (refs.length > 0) {
    // 服务层 restrict 的友好错误；FK（迁移 0138）是兜底。
    throw new ConflictError('webhook-endpoint-has-triggers', 'delete or re-home its triggers first')
  }
  const rows = await deps.db
    .delete(webhookEndpoints)
    .where(eq(webhookEndpoints.id, id))
    .returning({ id: webhookEndpoints.id })
  if (rows.length === 0) {
    throw new NotFoundError('webhook-endpoint-not-found', 'endpoint not found')
  }
}

export async function rotateWebhookEndpointSecret(
  deps: WebhookEndpointServiceDeps,
  viewer: Actor,
  id: string,
): Promise<WebhookEndpointWire & { secret: string }> {
  const secret = mintSecret()
  const rows = await deps.db
    .update(webhookEndpoints)
    .set({ secretEnc: deps.secretBox.seal(secret), updatedAt: Date.now() })
    .where(eq(webhookEndpoints.id, id))
    .returning()
  const row = rows[0]
  if (!row) throw new NotFoundError('webhook-endpoint-not-found', 'endpoint not found')
  return { ...wireWithIngress(deps, row, viewer), secret }
}

export async function rotateWebhookEndpointUrlToken(
  deps: WebhookEndpointServiceDeps,
  viewer: Actor,
  id: string,
): Promise<WebhookEndpointWire> {
  const rows = await deps.db
    .update(webhookEndpoints)
    .set({ urlToken: mintUrlToken(), updatedAt: Date.now() })
    .where(eq(webhookEndpoints.id, id))
    .returning()
  const row = rows[0]
  if (!row) throw new NotFoundError('webhook-endpoint-not-found', 'endpoint not found')
  return wireWithIngress(deps, row, viewer)
}

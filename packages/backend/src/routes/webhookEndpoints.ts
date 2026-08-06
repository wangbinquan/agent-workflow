// RFC-257 T7 — webhook 端点管理面（RFC-260 读/写分层）。
// 端点 = 平台基础设施（验签 secret + 公开 URL token）。写面（CRUD/轮换）走
// `webhook-endpoints:manage`（system 域：零令牌面——RFC-253 scripts:author
// 先例），tokenAccess:'never' 双保险；读面（RFC-260）走矩阵点
// `webhook-endpoints:read`（全员基线），但 **URL 明文按 viewer 分层**：只有
// admin 的 session 请求拿明文 urlToken/ingressUrl，非 admin 与一切 PAT（含
// admin 的 PAT）拿 null + 尾 4 位 urlTokenHint——RFC-257 D19「ingress 面不上
// 令牌」在读点开放后由响应分层继续兑现。
// secret 三形态（RFC-255 姿势）：创建/轮换响应一次性明文、存储 secretBox
// 密封、读取面只有 hasSecret + 尾 4 位 hint。
import type { Hono } from 'hono'
import { randomBytes } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'

import {
  CreateWebhookEndpointSchema,
  UpdateWebhookEndpointSchema,
  type WebhookEndpoint,
} from '@agent-workflow/shared'
import type { AppDeps } from '@/server'
import { actorOf, type Actor } from '@/auth/actor'
import { registerRoute } from '@/routes/registry'
import { webhookEndpoints, webhookTriggers } from '@/db/schema'
import { loadConfig } from '@/config'
import { ConflictError, NotFoundError, ValidationError } from '@/util/errors'

function mintUrlToken(): string {
  return `aw_whk_${randomBytes(32).toString('base64url')}`
}

function mintSecret(): string {
  return randomBytes(32).toString('base64url')
}

async function safeJson(req: Request): Promise<unknown> {
  try {
    return await req.json()
  } catch {
    throw new ValidationError('invalid-json', 'request body is not valid JSON')
  }
}

type Row = typeof webhookEndpoints.$inferSelect

/**
 * RFC-260 D3 — URL 明文的 viewer 白名单：admin 的交互 session。其余（非 admin、
 * PAT、daemon 内部调用）一律掩码——fail-closed，新增 ActorSource 值默认拿不到
 * 明文。
 */
function revealsUrl(actor: Actor): boolean {
  return actor.user.role === 'admin' && actor.source === 'session'
}

function toWire(
  row: Row,
  unsealHint: (enc: string) => string | null,
  viewer: Actor,
): WebhookEndpoint {
  const hint = unsealHint(row.secretEnc)
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

export function mountWebhookEndpointRoutes(app: Hono, deps: AppDeps): void {
  const secretBox = deps.secretBox
  if (!secretBox) return // 对齐 OIDC 自我跳过（server.ts）：无密封器则不开管理面
  const unsealHint = (enc: string): string | null => {
    try {
      const plain = secretBox.unseal(enc)
      return plain.length >= 4 ? plain.slice(-4) : null
    } catch {
      return null
    }
  }

  registerRoute(
    app,
    {
      method: 'GET',
      path: '/api/webhook-endpoints',
      // RFC-260：读面全员（矩阵点）；URL 明文由 toWire 按 viewer 分层——PAT
      // 可读掩码后的元数据（tokenAccess allow），明文只走 admin session。
      permissions: ['webhook-endpoints:read'],
      tokenAccess: 'allow',
      summary: 'List webhook ingress endpoints (RFC-257/260)',
    },
    async (c) => {
      const viewer = actorOf(c)
      const rows = await deps.db.select().from(webhookEndpoints)
      return c.json(
        rows.map((r) => ({
          ...toWire(r, unsealHint, viewer),
          ingressUrl: ingressUrlFor(deps.configPath, r, viewer),
        })),
      )
    },
  )

  registerRoute(
    app,
    {
      method: 'POST',
      path: '/api/webhook-endpoints',
      permissions: ['webhook-endpoints:manage'],
      tokenAccess: 'never',
      summary: 'Create a webhook ingress endpoint (returns the secret ONCE)',
    },
    async (c) => {
      const parsed = CreateWebhookEndpointSchema.safeParse(await safeJson(c.req.raw))
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
                secretEnc: secretBox.seal(secret),
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
      return c.json(
        {
          ...toWire(row, unsealHint, actorOf(c)),
          ingressUrl: ingressUrlFor(deps.configPath, row, actorOf(c)),
          // 一次性明文：仅此响应携带；之后只有掩码 hint。
          secret,
        },
        201,
      )
    },
  )

  registerRoute(
    app,
    {
      method: 'GET',
      path: '/api/webhook-endpoints/:id',
      permissions: ['webhook-endpoints:read'],
      tokenAccess: 'allow',
      summary: 'Get one webhook ingress endpoint',
    },
    async (c) => {
      const viewer = actorOf(c)
      const row = (
        await deps.db
          .select()
          .from(webhookEndpoints)
          .where(eq(webhookEndpoints.id, c.req.param('id')))
          .limit(1)
      )[0]
      if (!row) throw new NotFoundError('webhook-endpoint-not-found', 'endpoint not found')
      return c.json({
        ...toWire(row, unsealHint, viewer),
        ingressUrl: ingressUrlFor(deps.configPath, row, viewer),
      })
    },
  )

  registerRoute(
    app,
    {
      method: 'PUT',
      path: '/api/webhook-endpoints/:id',
      permissions: ['webhook-endpoints:manage'],
      tokenAccess: 'never',
      summary: 'Update endpoint name/enabled/clone protocol (provider immutable)',
    },
    async (c) => {
      const parsed = UpdateWebhookEndpointSchema.safeParse(await safeJson(c.req.raw))
      if (!parsed.success) {
        throw new ValidationError('webhook-endpoint-invalid', 'invalid endpoint patch', {
          issues: parsed.error.issues,
        })
      }
      const rows = await deps.db
        .update(webhookEndpoints)
        .set({ ...parsed.data, updatedAt: Date.now() })
        .where(eq(webhookEndpoints.id, c.req.param('id')))
        .returning()
      const row = rows[0]
      if (!row) throw new NotFoundError('webhook-endpoint-not-found', 'endpoint not found')
      return c.json({
        ...toWire(row, unsealHint, actorOf(c)),
        ingressUrl: ingressUrlFor(deps.configPath, row, actorOf(c)),
      })
    },
  )

  registerRoute(
    app,
    {
      method: 'DELETE',
      path: '/api/webhook-endpoints/:id',
      permissions: ['webhook-endpoints:manage'],
      tokenAccess: 'never',
      summary: 'Delete an endpoint (restricted while triggers reference it)',
    },
    async (c) => {
      const id = c.req.param('id')
      const refs = await deps.db
        .select({ id: webhookTriggers.id })
        .from(webhookTriggers)
        .where(eq(webhookTriggers.endpointId, id))
        .limit(1)
      if (refs.length > 0) {
        // 服务层 restrict 的友好错误；FK（迁移 0138）是兜底。
        throw new ConflictError(
          'webhook-endpoint-has-triggers',
          'delete or re-home its triggers first',
        )
      }
      const rows = await deps.db
        .delete(webhookEndpoints)
        .where(eq(webhookEndpoints.id, id))
        .returning({ id: webhookEndpoints.id })
      if (rows.length === 0) {
        throw new NotFoundError('webhook-endpoint-not-found', 'endpoint not found')
      }
      return c.json({ ok: true })
    },
  )

  registerRoute(
    app,
    {
      method: 'POST',
      path: '/api/webhook-endpoints/:id/rotate-secret',
      permissions: ['webhook-endpoints:manage'],
      tokenAccess: 'never',
      summary: 'Rotate the verification secret (returns the new secret ONCE)',
    },
    async (c) => {
      const secret = mintSecret()
      const rows = await deps.db
        .update(webhookEndpoints)
        .set({ secretEnc: secretBox.seal(secret), updatedAt: Date.now() })
        .where(eq(webhookEndpoints.id, c.req.param('id')))
        .returning()
      const row = rows[0]
      if (!row) throw new NotFoundError('webhook-endpoint-not-found', 'endpoint not found')
      return c.json({
        ...toWire(row, unsealHint, actorOf(c)),
        ingressUrl: ingressUrlFor(deps.configPath, row, actorOf(c)),
        secret,
      })
    },
  )

  registerRoute(
    app,
    {
      method: 'POST',
      path: '/api/webhook-endpoints/:id/rotate-url-token',
      permissions: ['webhook-endpoints:manage'],
      tokenAccess: 'never',
      summary: 'Rotate the URL token (GitLab must be re-pointed at the new URL)',
    },
    async (c) => {
      const rows = await deps.db
        .update(webhookEndpoints)
        .set({ urlToken: mintUrlToken(), updatedAt: Date.now() })
        .where(eq(webhookEndpoints.id, c.req.param('id')))
        .returning()
      const row = rows[0]
      if (!row) throw new NotFoundError('webhook-endpoint-not-found', 'endpoint not found')
      return c.json({
        ...toWire(row, unsealHint, actorOf(c)),
        ingressUrl: ingressUrlFor(deps.configPath, row, actorOf(c)),
      })
    },
  )
}

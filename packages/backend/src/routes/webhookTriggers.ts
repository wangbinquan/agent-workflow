// RFC-257 T8/T9 — 触发器管理面（owner 制写面，D19：非 RFC-099 ACL —— fire 以
// owner 身份执行，grants 写权 = 改绑目标后借 owner 身份的提权通道）。
// RFC-260 D1/D5：**读面全量开放**（列表/详情/fires 对任何过了 read 方法门的
// viewer 可见，原「不可见 = 404」读语义退役）；RFC-283 写面行级门为
// owner ∨ admin（manager 可写自己的规则，不可写别人的；404 同形）。
// 保存期校验三层（services/webhook/triggerValidation.ts 注释）；创建/更新时
// 以**保存者身份**跑「彩排渲染 + assertScheduledTargetUsable」——launch 目标
// 对保存者不可见即拒绝（对齐 services/resourceRefs.ts 的新增引用校验惯例）。
import type { Hono } from 'hono'
import { and, desc, eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import { z } from 'zod'

import {
  CODE_HOST_EVENT_TYPES,
  CreateWebhookTriggerSchema,
  UpdateWebhookTriggerSchema,
  type WebhookTrigger,
} from '@agent-workflow/shared'
import { actorOf, type Actor } from '@/auth/actor'
import type { AppDeps } from '@/server'
import { registerRoute } from '@/routes/registry'
import {
  webhookEndpoints,
  webhookTriggerFires,
  webhookTriggers,
  webhookTriggerStreams,
} from '@/db/schema'
import { parseTriggerRow } from '@/services/webhook/webhookDispatch'
import { assertTriggerSaveable } from '@/services/webhook/triggerValidation'
import { loadConfig } from '@/config'
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '@/util/errors'

type Row = typeof webhookTriggers.$inferSelect

/**
 * RFC-260 D1/D5：读路径不再做行级过滤（触发器全量只读，用户拍板——规则本身
 * 不敏感，全量可见最利排障）；RFC-283 写路径的行级门为 owner ∨ admin。
 * manager 通过方法权限进入路由，但不继承这个资源的全局绕过权。原「非 owner 404
 * 同形」读语义随 D1 显式退役。
 */
function requireWrite(actor: Actor, row: Row): void {
  if (!(row.ownerUserId === actor.user.id || actor.user.role === 'admin')) {
    throw new NotFoundError('webhook-trigger-not-found', `trigger '${row.id}' not found`)
  }
}

function requireLaunchPermission(actor: Actor): void {
  if (!actor.permissions.has('tasks:execute')) {
    throw new ForbiddenError('forbidden', 'missing permission: tasks:execute', {
      requiredPermission: 'tasks:execute',
    })
  }
}

async function safeJson(req: Request): Promise<unknown> {
  try {
    return await req.json()
  } catch {
    throw new ValidationError('invalid-json', 'request body is not valid JSON')
  }
}

/** 行 → wire（JSON 列逐字段容错，RFC-165 F18 姿势：坏行给 null 不炸整表）。 */
function toWire(row: Row): WebhookTrigger {
  const parsed = parseTriggerRow(row)
  if (parsed.ok) {
    return {
      id: row.id,
      name: row.name,
      endpointId: row.endpointId,
      ownerUserId: row.ownerUserId,
      enabled: row.enabled,
      repoScope: parsed.trigger.rule.repoScope,
      eventTypes: [...parsed.trigger.rule.eventTypes],
      branchFilter: row.branchFilter,
      commandPrefix: row.commandPrefix,
      ignoreUsernames: [...parsed.trigger.rule.ignoreUsernames],
      launchKind: row.launchKind,
      launchRefId: row.launchRefId,
      launchPayload: parsed.trigger.payloadTemplate,
      migrationError: null,
      maxConsecutiveFires: row.maxConsecutiveFires,
      autoRegisterRepos: row.autoRegisterRepos,
      lastFiredAt: row.lastFiredAt,
      lastStatus: row.lastStatus,
      lastError: row.lastError,
      lastTaskId: row.lastTaskId,
      consecutiveFailures: row.consecutiveFailures,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }
  }
  return {
    id: row.id,
    name: row.name,
    endpointId: row.endpointId,
    ownerUserId: row.ownerUserId,
    enabled: row.enabled,
    repoScope: null,
    eventTypes: null,
    branchFilter: row.branchFilter,
    commandPrefix: row.commandPrefix,
    ignoreUsernames: null,
    launchKind: row.launchKind,
    launchRefId: row.launchRefId,
    launchPayload: null,
    migrationError: {
      repoScope: parsed.reason === 'repo-scope-invalid' ? parsed.reason : null,
      eventTypes: parsed.reason === 'event-types-invalid' ? parsed.reason : null,
      ignoreUsernames: parsed.reason === 'ignore-usernames-invalid' ? parsed.reason : null,
      launchPayload: parsed.reason === 'launch-payload-invalid' ? parsed.reason : null,
    },
    maxConsecutiveFires: row.maxConsecutiveFires,
    autoRegisterRepos: row.autoRegisterRepos,
    lastFiredAt: row.lastFiredAt,
    lastStatus: row.lastStatus,
    lastError: row.lastError,
    lastTaskId: row.lastTaskId,
    consecutiveFailures: row.consecutiveFailures,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

/** 保存期校验（服务层 assertTriggerSaveable 的路由装配：解析 defaultRuntime）。 */
async function assertSaveable(
  deps: AppDeps,
  actor: Actor,
  candidate: Parameters<typeof assertTriggerSaveable>[2],
): Promise<void> {
  let defaultRuntime: string | null | undefined
  try {
    defaultRuntime = loadConfig(deps.configPath).defaultRuntime
  } catch {
    defaultRuntime = undefined
  }
  await assertTriggerSaveable(deps.db, actor, candidate, defaultRuntime)
}

export function mountWebhookTriggerRoutes(app: Hono, deps: AppDeps): void {
  registerRoute(
    app,
    {
      method: 'GET',
      path: '/api/webhook-triggers',
      permissions: ['webhook-triggers:read'],
      tokenAccess: 'allow',
      summary: 'List webhook triggers visible to the caller',
    },
    async (c) => {
      const rows = await deps.db
        .select()
        .from(webhookTriggers)
        .orderBy(desc(webhookTriggers.createdAt))
      // RFC-260 D1：全量只读——不再按 owner 过滤。
      return c.json(rows.map(toWire))
    },
  )

  registerRoute(
    app,
    {
      method: 'POST',
      path: '/api/webhook-triggers',
      permissions: ['webhook-triggers:create', 'tasks:execute'],
      tokenAccess: 'allow',
      summary: 'Create a webhook trigger (arms event-driven launches)',
    },
    async (c) => {
      const actor = actorOf(c)
      // 对齐 scheduled create：建触发器 = 预授权未来 launch，同 launch 权门。
      requireLaunchPermission(actor)
      const parsed = CreateWebhookTriggerSchema.safeParse(await safeJson(c.req.raw))
      if (!parsed.success) {
        throw new ValidationError('webhook-trigger-invalid', 'invalid trigger body', {
          issues: parsed.error.issues,
        })
      }
      const body = parsed.data
      const endpoint = (
        await deps.db
          .select({ id: webhookEndpoints.id })
          .from(webhookEndpoints)
          .where(eq(webhookEndpoints.id, body.endpointId))
          .limit(1)
      )[0]
      if (!endpoint) {
        throw new ValidationError('webhook-endpoint-not-found', 'endpoint does not exist')
      }
      await assertSaveable(deps, actor, {
        launchKind: body.launchKind,
        launchRefId: body.launchRefId,
        launchPayload: body.launchPayload,
        eventTypes: body.eventTypes,
        autoRegisterRepos: body.autoRegisterRepos,
      })
      const id = ulid()
      const rows = await deps.db
        .insert(webhookTriggers)
        .values({
          id,
          name: body.name,
          endpointId: body.endpointId,
          ownerUserId: actor.user.id,
          enabled: body.enabled,
          repoScope: JSON.stringify(body.repoScope),
          eventTypes: JSON.stringify(body.eventTypes),
          branchFilter: body.branchFilter ?? null,
          commandPrefix: body.commandPrefix ?? null,
          ignoreUsernames: JSON.stringify(body.ignoreUsernames),
          launchKind: body.launchKind,
          launchRefId: body.launchRefId,
          launchPayload: JSON.stringify(body.launchPayload),
          maxConsecutiveFires: body.maxConsecutiveFires,
          autoRegisterRepos: body.autoRegisterRepos,
        })
        .returning()
      return c.json(toWire(rows[0]!), 201)
    },
  )

  registerRoute(
    app,
    {
      method: 'GET',
      path: '/api/webhook-triggers/:id',
      permissions: ['webhook-triggers:read'],
      tokenAccess: 'allow',
      summary: 'Get one webhook trigger',
    },
    async (c) => {
      const row = (
        await deps.db
          .select()
          .from(webhookTriggers)
          .where(eq(webhookTriggers.id, c.req.param('id')))
          .limit(1)
      )[0]
      if (!row) {
        throw new NotFoundError('webhook-trigger-not-found', 'trigger not found')
      }
      return c.json(toWire(row))
    },
  )

  registerRoute(
    app,
    {
      method: 'PUT',
      path: '/api/webhook-triggers/:id',
      permissions: ['webhook-triggers:update'],
      tokenAccess: 'allow',
      summary: 'Update a webhook trigger (kind/endpoint immutable)',
    },
    async (c) => {
      const actor = actorOf(c)
      const row = (
        await deps.db
          .select()
          .from(webhookTriggers)
          .where(eq(webhookTriggers.id, c.req.param('id')))
          .limit(1)
      )[0]
      if (!row) {
        throw new NotFoundError('webhook-trigger-not-found', 'trigger not found')
      }
      requireWrite(actor, row)
      const parsed = UpdateWebhookTriggerSchema.safeParse(await safeJson(c.req.raw))
      if (!parsed.success) {
        throw new ValidationError('webhook-trigger-invalid', 'invalid trigger patch', {
          issues: parsed.error.issues,
        })
      }
      const patch = parsed.data
      if (patch.launchKind !== undefined && patch.launchKind !== row.launchKind) {
        throw new ValidationError('webhook-trigger-kind-immutable', 'launchKind cannot change')
      }
      if (patch.endpointId !== undefined && patch.endpointId !== row.endpointId) {
        throw new ValidationError('webhook-trigger-endpoint-immutable', 'endpointId cannot change')
      }
      const storedEventTypes = z
        .array(z.enum(CODE_HOST_EVENT_TYPES))
        .catch([])
        .parse(JSON.parse(row.eventTypes))
      const next = {
        launchKind: row.launchKind,
        launchRefId: patch.launchRefId ?? row.launchRefId,
        launchPayload:
          patch.launchPayload !== undefined ? patch.launchPayload : JSON.parse(row.launchPayload),
        eventTypes: patch.eventTypes !== undefined ? patch.eventTypes : storedEventTypes,
        autoRegisterRepos: patch.autoRegisterRepos ?? row.autoRegisterRepos,
      }
      await assertSaveable(deps, actor, next)
      const launchConfigTouched =
        patch.launchRefId !== undefined ||
        patch.launchPayload !== undefined ||
        patch.eventTypes !== undefined ||
        patch.autoRegisterRepos !== undefined
      const rows = await deps.db
        .update(webhookTriggers)
        .set({
          ...(patch.name !== undefined ? { name: patch.name } : {}),
          ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
          ...(patch.repoScope !== undefined ? { repoScope: JSON.stringify(patch.repoScope) } : {}),
          ...(patch.eventTypes !== undefined
            ? { eventTypes: JSON.stringify(patch.eventTypes) }
            : {}),
          ...(patch.branchFilter !== undefined ? { branchFilter: patch.branchFilter } : {}),
          ...(patch.commandPrefix !== undefined ? { commandPrefix: patch.commandPrefix } : {}),
          ...(patch.ignoreUsernames !== undefined
            ? { ignoreUsernames: JSON.stringify(patch.ignoreUsernames) }
            : {}),
          ...(patch.launchRefId !== undefined ? { launchRefId: patch.launchRefId } : {}),
          ...(patch.launchPayload !== undefined
            ? { launchPayload: JSON.stringify(patch.launchPayload) }
            : {}),
          ...(patch.maxConsecutiveFires !== undefined
            ? { maxConsecutiveFires: patch.maxConsecutiveFires }
            : {}),
          ...(patch.autoRegisterRepos !== undefined
            ? { autoRegisterRepos: patch.autoRegisterRepos }
            : {}),
          updatedAt: Date.now(),
        })
        .where(
          launchConfigTouched
            ? and(
                eq(webhookTriggers.id, row.id),
                eq(webhookTriggers.launchRefId, row.launchRefId),
                eq(webhookTriggers.launchPayload, row.launchPayload),
                eq(webhookTriggers.eventTypes, row.eventTypes),
                eq(webhookTriggers.autoRegisterRepos, row.autoRegisterRepos),
              )
            : eq(webhookTriggers.id, row.id),
        )
        .returning()
      if (launchConfigTouched && rows.length === 0) {
        throw new ConflictError(
          'webhook-trigger-update-conflict',
          'trigger launch configuration changed; reload and retry',
        )
      }
      return c.json(toWire(rows[0]!))
    },
  )

  registerRoute(
    app,
    {
      method: 'DELETE',
      path: '/api/webhook-triggers/:id',
      permissions: ['webhook-triggers:delete'],
      tokenAccess: 'allow',
      summary: 'Delete a webhook trigger (fires/streams cascade)',
    },
    async (c) => {
      const actor = actorOf(c)
      const row = (
        await deps.db
          .select()
          .from(webhookTriggers)
          .where(eq(webhookTriggers.id, c.req.param('id')))
          .limit(1)
      )[0]
      if (!row) {
        throw new NotFoundError('webhook-trigger-not-found', 'trigger not found')
      }
      requireWrite(actor, row)
      await deps.db.delete(webhookTriggers).where(eq(webhookTriggers.id, row.id))
      return c.json({ ok: true })
    },
  )

  registerRoute(
    app,
    {
      method: 'GET',
      path: '/api/webhook-triggers/:id/fires',
      permissions: ['webhook-triggers:read'],
      tokenAccess: 'allow',
      summary: 'Fire history of one trigger (owner-facing troubleshooting)',
    },
    async (c) => {
      const row = (
        await deps.db
          .select()
          .from(webhookTriggers)
          .where(eq(webhookTriggers.id, c.req.param('id')))
          .limit(1)
      )[0]
      if (!row) {
        throw new NotFoundError('webhook-trigger-not-found', 'trigger not found')
      }
      const limit = Math.min(200, Number(c.req.query('limit') ?? 50) || 50)
      const fires = await deps.db
        .select()
        .from(webhookTriggerFires)
        .where(eq(webhookTriggerFires.triggerId, row.id))
        .orderBy(desc(webhookTriggerFires.firedAt))
        .limit(limit)
      return c.json(fires)
    },
  )

  registerRoute(
    app,
    {
      method: 'POST',
      path: '/api/webhook-triggers/:id/streams/reset',
      permissions: ['webhook-triggers:update'],
      tokenAccess: 'allow',
      summary: 'Reset the circuit counter of one stream (D22 manual reset)',
    },
    async (c) => {
      const actor = actorOf(c)
      const row = (
        await deps.db
          .select()
          .from(webhookTriggers)
          .where(eq(webhookTriggers.id, c.req.param('id')))
          .limit(1)
      )[0]
      if (!row) {
        throw new NotFoundError('webhook-trigger-not-found', 'trigger not found')
      }
      requireWrite(actor, row)
      const body = z
        .object({ streamKey: z.string().min(1).max(1000) })
        .safeParse(await safeJson(c.req.raw))
      if (!body.success) {
        throw new ValidationError('webhook-stream-invalid', 'streamKey required')
      }
      await deps.db
        .update(webhookTriggerStreams)
        .set({ consecutiveFires: 0, resetAt: Date.now(), resetBy: actor.user.id })
        .where(
          and(
            eq(webhookTriggerStreams.triggerId, row.id),
            eq(webhookTriggerStreams.streamKey, body.data.streamKey),
          ),
        )
      return c.json({ ok: true })
    },
  )
}

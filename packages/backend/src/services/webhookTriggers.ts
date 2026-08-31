// RFC-284 T28（审计 N10 主证）—— webhook 触发器 CRUD 自 routes/webhookTriggers.ts
// 薄壳化下沉：路由层只剩 registerRoute 元数据 + actor/param/query 抽取，全部
// db/schema/config 访问与业务判定在本文件。行为承诺：RFC-283/292 落地后的字节级
// 保留——保真判据是 rfc257-webhook-dispatch/-management、rfc268、rfc269 等套件全绿。
//
// 领域注释（自 routes 原文迁入）：
// RFC-257 T8/T9 触发器管理面（owner 制写面，D19：非 RFC-099 ACL —— fire 以 owner
// 身份执行，grants 写权 = 改绑目标后借 owner 身份的提权通道）。RFC-260 D1/D5：
// **读面全量开放**（列表/详情/fires 对任何过了 read 方法门的 viewer 可见，原
// 「不可见 = 404」读语义退役）；RFC-283/RFC-305 写面行级门为 owner ∨
// `event-automation-rules:override-owner`（404 同形）。保存期校验三层
// （services/webhook/triggerValidation.ts 注释）；创建/更新时以**保存者身份**跑
// 「彩排渲染 + assertScheduledTargetUsable」——launch 目标对保存者不可见即拒绝
// （对齐 services/resourceRefs.ts 的新增引用校验惯例）。
import { and, desc, eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import { z } from 'zod'

import {
  CODE_HOST_EVENT_TYPES,
  CreateWebhookTriggerSchema,
  UpdateWebhookTriggerSchema,
  WEBHOOK_TRIGGER_TERMINAL_POLICY_CONFLICT,
  webhookTriggerTerminalPolicyIssue,
  type WebhookTrigger,
} from '@agent-workflow/shared'
import type { Actor } from '@/auth/actor'
import type { DbClient } from '@/db/client'
import {
  webhookEndpoints,
  webhookTriggerFires,
  webhookTriggers,
  webhookTriggerStreams,
} from '@/db/schema'
import { migrateTriggerRowTemplateToV2, parseTriggerRow } from '@/services/webhook/webhookDispatch'
import { assertTriggerSaveable } from '@/services/webhook/triggerValidation'
import { loadConfig } from '@/config'
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '@/util/errors'
import type { IntegrationTriggerResourceAuthority } from '@/services/scheduledTasks'

export interface WebhookTriggerServiceDeps {
  db: DbClient
  configPath: string
}

type Row = typeof webhookTriggers.$inferSelect

export type WebhookTriggerFireRow = typeof webhookTriggerFires.$inferSelect

/**
 * RFC-260 D1/D5：读路径不再做行级过滤（触发器全量只读，用户拍板——规则本身
 * 不敏感，全量可见最利排障）；RFC-283/RFC-305 写路径的行级门为 owner ∨
 * `event-automation-rules:override-owner`。方法权限与跨 owner 权限相互独立。原「非 owner
 * 404 同形」读语义随 D1 显式退役。
 */
function requireWrite(actor: Actor, row: Row): void {
  if (
    !(
      row.ownerUserId === actor.user.id ||
      actor.permissions.has('event-automation-rules:override-owner')
    )
  ) {
    throw new NotFoundError('webhook-trigger-not-found', `trigger '${row.id}' not found`)
  }
}

function requireLaunchPermission(actor: Actor, launchKind: Row['launchKind']): void {
  const permission =
    launchKind === 'digital-employee' ? 'development-missions:launch' : 'tasks:execute'
  if (!actor.permissions.has(permission)) {
    throw new ForbiddenError('forbidden', `missing permission: ${permission}`, {
      requiredPermission: permission,
    })
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
      cancelOnMrTerminal: row.cancelOnMrTerminal,
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
      cancelOnMrTerminal: parsed.reason === 'terminal-policy-invalid' ? parsed.reason : null,
    },
    maxConsecutiveFires: row.maxConsecutiveFires,
    autoRegisterRepos: row.autoRegisterRepos,
    cancelOnMrTerminal: row.cancelOnMrTerminal,
    lastFiredAt: row.lastFiredAt,
    lastStatus: row.lastStatus,
    lastError: row.lastError,
    lastTaskId: row.lastTaskId,
    consecutiveFailures: row.consecutiveFailures,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

/** 保存期校验（assertTriggerSaveable 的装配：解析 defaultRuntime）。 */
async function assertSaveable(
  deps: WebhookTriggerServiceDeps,
  actor: Actor,
  resourceAuthority: IntegrationTriggerResourceAuthority,
  candidate: Parameters<typeof assertTriggerSaveable>[3],
): Promise<void> {
  let defaultRuntime: string | null | undefined
  try {
    defaultRuntime = loadConfig(deps.configPath).defaultRuntime
  } catch {
    defaultRuntime = undefined
  }
  await assertTriggerSaveable(deps.db, actor, resourceAuthority, candidate, defaultRuntime)
}

async function loadRowOrThrow(db: DbClient, id: string): Promise<Row> {
  const row = (
    await db.select().from(webhookTriggers).where(eq(webhookTriggers.id, id)).limit(1)
  )[0]
  if (!row) {
    throw new NotFoundError('webhook-trigger-not-found', 'trigger not found')
  }
  return row
}

export async function listWebhookTriggers(
  deps: WebhookTriggerServiceDeps,
): Promise<WebhookTrigger[]> {
  const rows = await deps.db.select().from(webhookTriggers).orderBy(desc(webhookTriggers.createdAt))
  // RFC-260 D1：全量只读——不再按 owner 过滤。
  const canonicalRows = await Promise.all(
    rows.map((row) => migrateTriggerRowTemplateToV2(deps.db, row)),
  )
  return canonicalRows.map(toWire)
}

export async function getWebhookTrigger(
  deps: WebhookTriggerServiceDeps,
  id: string,
): Promise<WebhookTrigger> {
  const row = await loadRowOrThrow(deps.db, id)
  return toWire(await migrateTriggerRowTemplateToV2(deps.db, row))
}

export async function createWebhookTrigger(
  deps: WebhookTriggerServiceDeps,
  actor: Actor,
  resourceAuthority: IntegrationTriggerResourceAuthority,
  rawBody: unknown,
): Promise<WebhookTrigger> {
  // 对齐 scheduled create：建触发器 = 预授权未来 launch，同 launch 权门。
  const parsed = CreateWebhookTriggerSchema.safeParse(rawBody)
  if (!parsed.success) {
    const policyConflict = parsed.error.issues.some(
      (issue) => issue.message === WEBHOOK_TRIGGER_TERMINAL_POLICY_CONFLICT,
    )
    throw new ValidationError(
      policyConflict ? WEBHOOK_TRIGGER_TERMINAL_POLICY_CONFLICT : 'webhook-trigger-invalid',
      policyConflict ? WEBHOOK_TRIGGER_TERMINAL_POLICY_CONFLICT : 'invalid trigger body',
      {
        issues: parsed.error.issues,
      },
    )
  }
  const body = parsed.data
  requireLaunchPermission(actor, body.launchKind)
  // RFC-310 PR-10 T104：code-round writer 已删除——launchKind 值保留在 shared
  // enum 只为解析历史行；新建一律拒（fire 只会落 skipped-trigger-invalid）。
  if (body.launchKind === 'code-round') {
    throw new ValidationError(
      'webhook-trigger-kind-retired',
      'code-round triggers were retired by RFC-310; use development missions',
    )
  }
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
  await assertSaveable(deps, actor, resourceAuthority, {
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
      templateSyntaxVersion: 2,
      maxConsecutiveFires: body.maxConsecutiveFires,
      autoRegisterRepos: body.autoRegisterRepos,
      cancelOnMrTerminal: body.cancelOnMrTerminal,
    })
    .returning()
  return toWire(rows[0]!)
}

export async function updateWebhookTrigger(
  deps: WebhookTriggerServiceDeps,
  actor: Actor,
  resourceAuthority: IntegrationTriggerResourceAuthority,
  id: string,
  rawBody: unknown,
): Promise<WebhookTrigger> {
  const storedRow = await loadRowOrThrow(deps.db, id)
  // RFC-310 T104：capability trigger 行已是历史遗留（writer 删除），允许用户
  // 正常编辑/删除以清理。
  const row = await migrateTriggerRowTemplateToV2(deps.db, storedRow)
  requireWrite(actor, row)
  const parsed = UpdateWebhookTriggerSchema.safeParse(rawBody)
  if (!parsed.success) {
    const policyConflict = parsed.error.issues.some(
      (issue) => issue.message === WEBHOOK_TRIGGER_TERMINAL_POLICY_CONFLICT,
    )
    throw new ValidationError(
      policyConflict ? WEBHOOK_TRIGGER_TERMINAL_POLICY_CONFLICT : 'webhook-trigger-invalid',
      policyConflict ? WEBHOOK_TRIGGER_TERMINAL_POLICY_CONFLICT : 'invalid trigger patch',
      {
        issues: parsed.error.issues,
      },
    )
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
    cancelOnMrTerminal: patch.cancelOnMrTerminal ?? row.cancelOnMrTerminal,
  }
  if (
    webhookTriggerTerminalPolicyIssue({
      cancelOnMrTerminal: next.cancelOnMrTerminal,
      eventTypes: next.eventTypes,
    }) !== null
  ) {
    throw new ValidationError(
      WEBHOOK_TRIGGER_TERMINAL_POLICY_CONFLICT,
      WEBHOOK_TRIGGER_TERMINAL_POLICY_CONFLICT,
    )
  }
  await assertSaveable(deps, actor, resourceAuthority, next)
  const launchConfigTouched =
    patch.launchRefId !== undefined ||
    patch.launchPayload !== undefined ||
    patch.eventTypes !== undefined ||
    patch.autoRegisterRepos !== undefined ||
    patch.cancelOnMrTerminal !== undefined
  const rows = await deps.db
    .update(webhookTriggers)
    .set({
      // A successful PUT is also the repair path for an invalid historical
      // v1 payload. The validated candidate is canonical even when the
      // read-time migration could not parse the stored bytes.
      templateSyntaxVersion: 2,
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
      ...(patch.repoScope !== undefined ? { repoScope: JSON.stringify(patch.repoScope) } : {}),
      ...(patch.eventTypes !== undefined ? { eventTypes: JSON.stringify(patch.eventTypes) } : {}),
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
      ...(patch.cancelOnMrTerminal !== undefined
        ? { cancelOnMrTerminal: patch.cancelOnMrTerminal }
        : {}),
      updatedAt: Date.now(),
    })
    .where(
      launchConfigTouched
        ? and(
            eq(webhookTriggers.id, row.id),
            eq(webhookTriggers.templateSyntaxVersion, row.templateSyntaxVersion),
            eq(webhookTriggers.launchRefId, row.launchRefId),
            eq(webhookTriggers.launchPayload, row.launchPayload),
            eq(webhookTriggers.eventTypes, row.eventTypes),
            eq(webhookTriggers.autoRegisterRepos, row.autoRegisterRepos),
            eq(webhookTriggers.cancelOnMrTerminal, row.cancelOnMrTerminal),
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
  return toWire(rows[0]!)
}

export async function deleteWebhookTrigger(
  deps: Pick<WebhookTriggerServiceDeps, 'db'>,
  actor: Actor,
  id: string,
): Promise<void> {
  const row = await loadRowOrThrow(deps.db, id)
  requireWrite(actor, row)
  await deps.db.delete(webhookTriggers).where(eq(webhookTriggers.id, row.id))
}

export async function listWebhookTriggerFires(
  deps: Pick<WebhookTriggerServiceDeps, 'db'>,
  id: string,
  limit: number,
): Promise<WebhookTriggerFireRow[]> {
  const row = await loadRowOrThrow(deps.db, id)
  return deps.db
    .select()
    .from(webhookTriggerFires)
    .where(eq(webhookTriggerFires.triggerId, row.id))
    .orderBy(desc(webhookTriggerFires.firedAt))
    .limit(limit)
}

export async function resetWebhookTriggerStream(
  deps: Pick<WebhookTriggerServiceDeps, 'db'>,
  actor: Actor,
  id: string,
  rawBody: unknown,
): Promise<void> {
  const row = await loadRowOrThrow(deps.db, id)
  requireWrite(actor, row)
  const body = z.object({ streamKey: z.string().min(1).max(1000) }).safeParse(rawBody)
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
}

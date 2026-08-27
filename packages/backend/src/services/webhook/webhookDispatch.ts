// RFC-257 T6 — Webhook response execution service（design §0/§4/§5）。
// 生产入口只使用 dispatchSubscription：一条 Event Center Delivery 精确执行一条
// 已匹配规则，绝不重扫 endpoint，也不修改共享 Webhook audit 状态。旧 dispatch
// 仅为存量嵌入方/回归夹具保留。每个执行结果仍写一条 fires 行；启动唯一收口 =
// startExecution（RFC-243 门面，
// 本文件在 rfc243-executor-facade.test.ts 的 CALL_FACES 清单内——设计门 F-7：
// 该锁是硬编码清单，新调用面必须显式登记）。
//
// 并发纪律（设计门 F-5 / D24）：per (triggerId, streamKey) 的 KeyedSerialQueue
// 串行化「supersede 判定 → 熔断评估 → 启动 → 落库」全段。dispatch 全程多
// await 点（DB / clone / cancel 5s 轮询），无互斥则两并发同流事件会双取消旧
// 任务后各自启动 —— 双任务存活且 fires 链出孤儿。
import { and, desc, eq, sql } from 'drizzle-orm'
import { ulid } from 'ulid'

import { type Actor } from '@/auth/actor'
import { buildInheritedActor } from '@/auth/actor'
import type { SecretBox } from '@/auth/secretBox'
import type { DbClient } from '@/db/client'
import {
  cachedRepos,
  tasks,
  webhookDeliveries,
  webhookEndpoints,
  webhookMrControlEffects,
  webhookTriggerFires,
  webhookTriggers,
  webhookTriggerStreams,
} from '@/db/schema'
import type {
  EventCenterAutomationWorkStarter,
  EventCenterCodeHostDeliveryDispatcher,
  WebhookDispatcher,
  WebhookEndpointRow,
} from '@/services/webhook/dispatcherTypes'
import { CODE_HOST_ADAPTERS, replayHeaders } from '@/services/webhook/codeHostAdapter'
import { cancelExecution, startExecution } from '@/services/execution/executor'
import type { ExecutionInvoker } from '@/services/execution/types'
import { assertScheduledTargetUsable } from '@/services/scheduledTasks'
import { buildStartTaskDeps } from '@/services/startTaskDeps'
import { markDelivery } from '@/services/webhook/deliveryStore'
import {
  evaluateCircuit,
  matchTrigger,
  streamKeyOf,
  type TriggerRule,
} from '@/services/webhook/matching'
import { unsealRepoUrl } from '@/services/repoCredentials'
import { ValidationError } from '@/util/errors'
import { KeyedSerialQueue } from '@/util/keyedSerialQueue'
import { createLogger } from '@/util/log'
import {
  CodeHostEventTypeSchema,
  WebhookRepoScopeSchema,
  isTerminalTaskStatus,
  gitUrlCacheKeyWith,
  mapWebhookTemplateSurfaces,
  isFileSchemeUrl,
  parseGitUrl,
  renderTemplate,
  templateVarIssues,
  migrateWebhookPayloadTemplateToV2,
  webhookPayloadTemplateSchemaFor,
  type CodeHostEvent,
  type StartAgentTask,
  type StartTask,
  type StartWorkgroupTask,
  type TriggerContext,
  type WebhookAgentPayloadTemplate,
  type WebhookDigitalEmployeePayloadTemplate,
  type WebhookFireOutcome,
  type WebhookLaunchKind,
  type WebhookLaunchPayloadTemplate,
  type WebhookWorkflowPayloadTemplate,
  type WebhookWorkgroupPayloadTemplate,
  webhookTriggerContextOf,
  webhookTriggerTerminalPolicyIssue,
} from '@agent-workflow/shared'
import { z } from 'zod'
import { sha1Hex } from '@/util/hash'
import {
  decideProtectedLaunch,
  type MrStreamState,
} from '@/modules/integration/domain/mrTerminalControl'
import type {
  MrTerminalControl,
  ProtectedMrLaunchGuard,
} from '@/modules/integration/public/mrTerminalControl'
import { DomainError } from '@/util/errors'
import type {
  DigitalEmployeeWorkStartPort,
  WorkStartReceipt,
  WorkStartTarget,
} from '@/modules/integration/public/participants'
import type { RepositoryPublicationTransport } from '@/modules/source-control/public/types'
import type { EventResponseTarget } from '@/modules/event-center/public/types'

const log = createLogger('webhook-dispatch')

export type WebhookDispatchDeps = {
  db: DbClient
  configPath: string
  secretBox: SecretBox
  repositoryPublicationTransport?: RepositoryPublicationTransport
  /** per-dispatch 读取（对齐 scheduledTaskScheduler 的 per-tick cfg.defaultRuntime）。 */
  getDefaultRuntime: () => Promise<string | null | undefined>
  /**
   * 测试接缝（fireSchedule 的 buildLaunch 注入同款先例）：缺省走真实现——
   * launch = startExecution 门面、cancel = cancelExecution。生产装配不传。
   */
  launch?: (
    actor: Actor,
    rendered: RenderedLaunch,
    invoker: ExecutionInvoker,
  ) => Promise<string | WorkStartReceipt>
  cancel?: (taskId: string) => Promise<unknown>
  /** RFC-268 测试接缝：证明 scratch 在 repo resolver 入口之前即完成分流。 */
  resolveRepo?: typeof resolveRepoForEvent
  /** RFC-303 bootstrap-owned durable guard/effect controller. */
  terminalControl?: MrTerminalControl
  /** Source-neutral peer of Task start; bound after the Digital Employee owner composes. */
  digitalEmployeeWorkStart?: DigitalEmployeeWorkStartPort
}

// ---------------------------------------------------------------------------
// 触发器行解析（JSON 列行级容错：单行坏数据跳过并告警，不拖垮整个端点的分发）
// ---------------------------------------------------------------------------

export type ParsedTrigger = {
  row: typeof webhookTriggers.$inferSelect
  rule: TriggerRule
  launchKind: WebhookLaunchKind
  launchRefId: string
  payloadTemplate: WebhookLaunchPayloadTemplate
  templateMigrated: boolean
}

function parseTriggerRuleRow(
  row: typeof webhookTriggers.$inferSelect,
  options: { ignoreTerminalPolicy?: boolean } = {},
): { ok: true; rule: TriggerRule } | { ok: false; reason: string } {
  const scope = (() => {
    try {
      return WebhookRepoScopeSchema.safeParse(JSON.parse(row.repoScope))
    } catch {
      return null
    }
  })()
  if (scope === null || !scope.success) return { ok: false, reason: 'repo-scope-invalid' }
  const eventTypes = (() => {
    try {
      return z.array(CodeHostEventTypeSchema).min(1).safeParse(JSON.parse(row.eventTypes))
    } catch {
      return null
    }
  })()
  if (eventTypes === null || !eventTypes.success) {
    return { ok: false, reason: 'event-types-invalid' }
  }
  if (
    options.ignoreTerminalPolicy !== true &&
    webhookTriggerTerminalPolicyIssue({
      cancelOnMrTerminal: row.cancelOnMrTerminal,
      eventTypes: eventTypes.data,
    }) !== null
  ) {
    return { ok: false, reason: 'terminal-policy-invalid' }
  }
  const ignore = (() => {
    try {
      return z.array(z.string()).safeParse(JSON.parse(row.ignoreUsernames))
    } catch {
      return null
    }
  })()
  if (ignore === null || !ignore.success) {
    return { ok: false, reason: 'ignore-usernames-invalid' }
  }
  return {
    ok: true,
    rule: {
      repoScope: scope.data,
      eventTypes: eventTypes.data,
      branchFilter: row.branchFilter,
      commandPrefix: row.commandPrefix,
      ignoreUsernames: ignore.data,
    },
  }
}

async function recordInvalidTerminalPolicyFire(
  deps: WebhookDispatchDeps,
  queue: KeyedSerialQueue<string>,
  input: {
    deliveryId: string
    event: CodeHostEvent
    row: typeof webhookTriggers.$inferSelect
  },
): Promise<void> {
  const streamKey = streamKeyOf(input.event)
  await queue.run(`${input.row.id}|${streamKey}`, async () => {
    const fresh = (
      await deps.db
        .select({ enabled: webhookTriggers.enabled })
        .from(webhookTriggers)
        .where(eq(webhookTriggers.id, input.row.id))
        .limit(1)
    )[0]
    await recordFire(deps.db, {
      fireId: ulid(),
      deliveryId: input.deliveryId,
      triggerId: input.row.id,
      streamKey,
      outcome: fresh?.enabled ? 'skipped-trigger-invalid' : 'skipped-trigger-disabled',
      ...(fresh?.enabled ? { error: 'terminal-policy-invalid' } : {}),
    })
  })
}

export function parseTriggerRow(
  row: typeof webhookTriggers.$inferSelect,
): { ok: true; trigger: ParsedTrigger } | { ok: false; reason: string } {
  const parsedRule = parseTriggerRuleRow(row)
  if (!parsedRule.ok) return parsedRule
  const payload = (() => {
    try {
      const raw = JSON.parse(row.launchPayload)
      const legacyParsed = webhookPayloadTemplateSchemaFor(row.launchKind).safeParse(raw)
      if (!legacyParsed.success) return legacyParsed
      if (row.templateSyntaxVersion === 1) {
        return webhookPayloadTemplateSchemaFor(row.launchKind).safeParse(
          migrateWebhookPayloadTemplateToV2(row.launchKind, legacyParsed.data),
        )
      }
      if (row.templateSyntaxVersion !== 2) return null
      return legacyParsed
    } catch {
      return null
    }
  })()
  if (payload === null || !payload.success) return { ok: false, reason: 'launch-payload-invalid' }
  if (templateVarIssues(row.launchKind, payload.data, parsedRule.rule.eventTypes).length > 0) {
    return { ok: false, reason: 'launch-payload-invalid' }
  }
  return {
    ok: true,
    trigger: {
      row,
      rule: parsedRule.rule,
      launchKind: row.launchKind,
      launchRefId: row.launchRefId,
      payloadTemplate: payload.data,
      templateMigrated: row.templateSyntaxVersion === 1,
    },
  }
}

/** CAS-write a successfully parsed v1 payload before it is returned/fired. */
export async function migrateTriggerRowTemplateToV2(
  db: DbClient,
  row: typeof webhookTriggers.$inferSelect,
): Promise<typeof webhookTriggers.$inferSelect> {
  const parsed = parseTriggerRow(row)
  if (!parsed.ok || !parsed.trigger.templateMigrated) return row
  const updated = await db
    .update(webhookTriggers)
    .set({
      launchPayload: JSON.stringify(parsed.trigger.payloadTemplate),
      templateSyntaxVersion: 2,
      updatedAt: Date.now(),
    })
    .where(
      and(
        eq(webhookTriggers.id, row.id),
        eq(webhookTriggers.templateSyntaxVersion, 1),
        eq(webhookTriggers.launchPayload, row.launchPayload),
      ),
    )
    .returning()
  if (updated[0] !== undefined) return updated[0]
  return (
    (await db.select().from(webhookTriggers).where(eq(webhookTriggers.id, row.id)).limit(1))[0] ??
    row
  )
}

// ---------------------------------------------------------------------------
// repo 解析（design §5.1；F-17 unseal 等值复核）
// ---------------------------------------------------------------------------

export type RepoResolution =
  | { kind: 'cached'; cachedRepoId: string }
  | { kind: 'url'; repoUrl: string }
  | { kind: 'unregistered' }

export type WebhookLaunchSpace =
  | Exclude<RepoResolution, { kind: 'unregistered' }>
  | { kind: 'scratch' }

export async function resolveRepoForEvent(
  db: DbClient,
  secretBox: SecretBox,
  event: CodeHostEvent,
  endpoint: Pick<WebhookEndpointRow, 'preferredCloneProtocol'>,
  autoRegister: boolean,
): Promise<RepoResolution> {
  // 双协议族 key：git-url.ts 不跨族折叠，GitLab payload 恰好两个 URL 都给。
  for (const url of [event.repoHttpUrl, event.repoSshUrl]) {
    const parsed = parseGitUrl(url)
    if (parsed === null) continue
    const key = gitUrlCacheKeyWith(parsed, sha1Hex)
    const row = (
      await db.select().from(cachedRepos).where(eq(cachedRepos.urlHash, key.hash)).limit(1)
    )[0]
    if (!row) continue
    // F-17：url_hash 是 8-hex sha1 截断（git-url.ts:293-295 自认碰撞风险）。
    // 人工启动时人眼可见仓名，webhook 自动化下碰撞 = 静默在错误仓库上跑任务
    // 并用写凭据 push —— 桶命中后 unseal 原 URL 做 canonical 等值复核。
    const plain = unsealRepoUrl(row, secretBox)
    if (plain !== null) {
      const rowParsed = parseGitUrl(plain)
      if (
        rowParsed === null ||
        gitUrlCacheKeyWith(rowParsed, sha1Hex).canonical !== key.canonical
      ) {
        log.warn('url_hash bucket collision — not adopting cached repo', {
          repoPath: event.repoPath,
          cachedRepoId: row.id,
        })
        continue
      }
    } else {
      // 密封行但当前进程无法解封（key 轮换中）：无从复核，按旧行为采纳 + 告警。
      log.warn('cached repo url not verifiable (sealed, unseal failed); adopting by hash', {
        cachedRepoId: row.id,
      })
    }
    return { kind: 'cached', cachedRepoId: row.id }
  }
  if (!autoRegister) return { kind: 'unregistered' }
  const autoUrl = endpoint.preferredCloneProtocol === 'ssh' ? event.repoSshUrl : event.repoHttpUrl
  // RFC-287 G5 / T14 实现门：自动注册这条路是 `file://` 的**第三条**绕过。
  //
  // webhook 的事件 schema 对两个仓库 URL 只做「非空字符串」校验，而 workflow 分支
  // 把 payload 用 `as unknown as StartTask` 强转直接交给 executor——`StartTaskSchema`
  // 那道 refine 全程没被执行过。于是一个签名正确、repoPath 匹配规则、
  // `project.git_http_url` 为 `file:///srv/private/repo` 的事件，就能让平台去跑
  // 本机路径。判在这里是因为它是「事件 URL 变成启动 spec」的唯一入口，三个
  // spaceFields 站点都从它取值。
  //
  // 收场走既有的 `unregistered`——它已有完整的可见处置（launchGuard.failed +
  // `skipped-repo-unregistered` 落 fire 记录），不需要新增失败态。
  if (isFileSchemeUrl(autoUrl)) {
    log.warn('refusing to auto-register a file:// repo from a webhook event', {
      repoPath: event.repoPath,
    })
    return { kind: 'unregistered' }
  }
  return { kind: 'url', repoUrl: autoUrl }
}

// ---------------------------------------------------------------------------
// 启动参数渲染（design §4.2；渲染后的全量校验 = 各 launch 服务的既有校验，
// 失败走 launch-failed —— 不在此重复实现校验器）
// ---------------------------------------------------------------------------

function fireTaskName(triggerName: string, event: CodeHostEvent): string {
  const anchor = event.mrIid !== undefined ? `${event.repoPath}!${event.mrIid}` : event.repoPath
  return `[${triggerName}] ${anchor}`.slice(0, 255)
}

type RenderedLaunch = WorkStartTarget

function renderEventResponseTarget(
  target: EventResponseTarget,
  context: TriggerContext,
): RenderedLaunch {
  const render = (value: string) => renderTemplate(value, context)
  if (target.kind === 'workflow') {
    return {
      kind: 'workflow',
      refId: target.refId,
      payload: {
        workflowId: target.refId,
        name: render(target.nameTemplate),
        inputs: Object.fromEntries(
          Object.entries(target.inputs).map(([key, value]) => [key, render(value)]),
        ),
        scratch: true,
      },
    }
  }
  if (target.kind === 'agent') {
    return {
      kind: 'agent',
      refId: target.refId,
      payload: {
        agentId: target.refId,
        name: render(target.nameTemplate),
        allowClarify: true,
        ...(target.descriptionTemplate === null
          ? {}
          : { description: render(target.descriptionTemplate) }),
        ...(Object.keys(target.inputs).length === 0
          ? {}
          : {
              inputs: Object.fromEntries(
                Object.entries(target.inputs).map(([key, value]) => [key, render(value)]),
              ),
            }),
        scratch: true,
      },
    }
  }
  if (target.kind === 'workgroup') {
    return {
      kind: 'workgroup',
      refId: target.refId,
      payload: {
        workgroupId: target.refId,
        name: render(target.nameTemplate),
        goal: render(target.goalTemplate),
        scratch: true,
      },
    }
  }
  return {
    kind: 'digital-employee',
    refId: target.refId,
    intake: {
      kind: target.intakeKind,
      target: Object.fromEntries(
        Object.entries(target.target).map(([key, value]) => [key, render(value)]),
      ),
      body: target.intakeKind === 'body' ? render(target.valueTemplate) : null,
      externalId: target.intakeKind === 'external-id' ? render(target.valueTemplate) : null,
      uploads: [],
    },
  }
}
/**
 * RFC-304. Carries only the capability: a round reads its MR, commit and diff
 * from the frozen trigger context, so copying them here would make a second
 * copy of the same fact — and two copies eventually disagree.
 */

/** The launch payload（T104 后三种 kind 全部携带 payload）。 */
export function renderedLaunchPayload(rendered: RenderedLaunch): unknown {
  return rendered.kind === 'digital-employee' ? rendered.intake : rendered.payload
}

export function renderWebhookLaunch(
  trigger: Pick<ParsedTrigger, 'launchKind' | 'launchRefId' | 'payloadTemplate'>,
  triggerName: string,
  event: CodeHostEvent,
  space: WebhookLaunchSpace,
): RenderedLaunch {
  const context = webhookTriggerContextOf(event)
  const renderedTemplate = mapWebhookTemplateSurfaces(
    trigger.launchKind,
    trigger.payloadTemplate,
    (surface) => renderTemplate(surface.text, context),
  )
  const name = fireTaskName(triggerName, event)
  const spaceFields =
    space.kind === 'scratch'
      ? { scratch: true as const }
      : space.kind === 'cached'
        ? { cachedRepoId: space.cachedRepoId }
        : { repoUrl: space.repoUrl }
  // scratch 是新建空白 Git 仓，不得把事件仓 branch 误当成 checkout ref。
  const refFields =
    space.kind !== 'scratch' && event.branch !== undefined ? { ref: event.branch } : {}
  if (trigger.launchKind === 'workflow') {
    const t = renderedTemplate as WebhookWorkflowPayloadTemplate
    const inputs: Record<string, string> = {}
    for (const [key, mapping] of Object.entries(t.inputs)) {
      inputs[key] =
        mapping.kind === 'template'
          ? mapping.template
          : // git-kind 输入的 packed 形（F-10）：平台代包，运行期由
            // workflowLaunchInputIssues 按既有规则校验。
            JSON.stringify({ kind: 'branch', ref: event.branch ?? '' })
    }
    return {
      kind: 'workflow',
      refId: trigger.launchRefId,
      payload: {
        workflowId: trigger.launchRefId,
        name,
        inputs,
        ...spaceFields,
        ...refFields,
        ...(space.kind !== 'scratch' && t.workingBranch !== undefined
          ? { workingBranch: t.workingBranch }
          : {}),
        ...(space.kind !== 'scratch' && t.autoCommitPush !== undefined
          ? { autoCommitPush: t.autoCommitPush }
          : {}),
        ...(t.maxDurationMs !== undefined ? { maxDurationMs: t.maxDurationMs } : {}),
        ...(t.maxTotalTokens !== undefined ? { maxTotalTokens: t.maxTotalTokens } : {}),
      } as unknown as StartTask,
    }
  }
  if (trigger.launchKind === 'agent') {
    const t = renderedTemplate as WebhookAgentPayloadTemplate
    const inputs = t.inputs === undefined ? undefined : { ...t.inputs }
    return {
      kind: 'agent',
      refId: trigger.launchRefId,
      payload: {
        agentId: trigger.launchRefId,
        name,
        ...(t.description !== undefined ? { description: t.description } : {}),
        ...(inputs !== undefined ? { inputs } : {}),
        ...(t.allowClarify !== undefined ? { allowClarify: t.allowClarify } : {}),
        ...spaceFields,
        ...refFields,
        ...(space.kind !== 'scratch' && t.workingBranch !== undefined
          ? { workingBranch: t.workingBranch }
          : {}),
        ...(space.kind !== 'scratch' && t.autoCommitPush !== undefined
          ? { autoCommitPush: t.autoCommitPush }
          : {}),
        ...(t.maxDurationMs !== undefined ? { maxDurationMs: t.maxDurationMs } : {}),
        ...(t.maxTotalTokens !== undefined ? { maxTotalTokens: t.maxTotalTokens } : {}),
      } as unknown as StartAgentTask & { agentId: string },
    }
  }
  if (trigger.launchKind === 'digital-employee') {
    const t = renderedTemplate as WebhookDigitalEmployeePayloadTemplate
    return {
      kind: 'digital-employee',
      refId: trigger.launchRefId,
      intake: {
        kind: t.intakeKind,
        target: t.target,
        body: t.intakeKind === 'body' ? (t.body ?? null) : null,
        externalId: t.intakeKind === 'external-id' ? (t.externalId ?? null) : null,
        uploads: [],
      },
    }
  }
  const t = renderedTemplate as WebhookWorkgroupPayloadTemplate
  return {
    kind: 'workgroup',
    refId: trigger.launchRefId,
    payload: {
      workgroupId: trigger.launchRefId,
      name,
      goal: t.goal,
      ...spaceFields,
      ...refFields,
      ...(space.kind !== 'scratch' && t.workingBranch !== undefined
        ? { workingBranch: t.workingBranch }
        : {}),
      ...(space.kind !== 'scratch' && t.autoCommitPush !== undefined
        ? { autoCommitPush: t.autoCommitPush }
        : {}),
      ...(t.maxDurationMs !== undefined ? { maxDurationMs: t.maxDurationMs } : {}),
      ...(t.maxTotalTokens !== undefined ? { maxTotalTokens: t.maxTotalTokens } : {}),
    } as unknown as StartWorkgroupTask & { workgroupId: string },
  }
}

// ---------------------------------------------------------------------------
// fire（互斥段）
// ---------------------------------------------------------------------------

async function recordFire(
  db: DbClient,
  input: {
    fireId: string
    deliveryId: string
    triggerId: string
    streamKey: string
    outcome: WebhookFireOutcome
    supersededTaskId?: string | null
    taskId?: string | null
    employeeCaseId?: string | null
    error?: string | null
  },
): Promise<void> {
  await db.insert(webhookTriggerFires).values({
    id: input.fireId,
    deliveryId: input.deliveryId,
    triggerId: input.triggerId,
    streamKey: input.streamKey,
    outcome: input.outcome,
    supersededTaskId: input.supersededTaskId ?? null,
    taskId: input.taskId ?? null,
    employeeCaseId: input.employeeCaseId ?? null,
    error: input.error ?? null,
  })
}

function errText(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 2000)
}

async function launchViaExecutor(
  deps: WebhookDispatchDeps,
  actor: Actor,
  rendered: RenderedLaunch,
  invoker: ExecutionInvoker,
  guard?: ProtectedMrLaunchGuard,
): Promise<WorkStartReceipt> {
  if (rendered.kind === 'digital-employee') {
    if (deps.digitalEmployeeWorkStart === undefined || invoker.type !== 'event') {
      throw new ValidationError(
        'digital-employee-work-start-unavailable',
        'digital employee event work-start is unavailable',
      )
    }
    return {
      kind: 'digital-employee',
      ...deps.digitalEmployeeWorkStart.launch({
        employeeId: rendered.refId,
        intake: {
          ...rendered.intake,
          idempotencyKey: `event-delivery:${invoker.eventDeliveryId}`,
        },
        actorUserId: actor.user.id,
        origin: {
          eventSubscriptionId: invoker.eventSubscriptionId,
          eventDeliveryId: invoker.eventDeliveryId,
        },
      }),
    }
  }
  const launchDeps = {
    ...buildStartTaskDeps(
      deps.db,
      deps.configPath,
      actor.user.id,
      deps.secretBox,
      deps.repositoryPublicationTransport,
    ),
    // 对齐 buildScheduleLaunch：闭包解析在重建的 owner actor 可见性内。
    launchActor: actor,
    // RFC-287 G7：定时/webhook 触发与手动启动**同一套语义**（proposal §G7 原话：
    // 「定时任务与 webhook 触发同一套语义」）。这里没有等 HTTP 响应的用户，但 G7
    // 的另一半收益恰恰是这两条最需要的：**准备失败要留下记录**。不开的话，一次
    // 拉不动远端的定时触发压根不铸任务行——用户在任务列表里什么都看不到，只能去
    // 翻触发历史里的一句错误，也没有任何可重试的对象（AC-11 的重试作用面为空）。
    deferRepoPreparation: true,
    ...(guard === undefined
      ? {}
      : {
          sourceTerminationLaunchSignal: guard.signal,
          sourceTerminationAdmission: guard.assertCanCommit,
        }),
  }
  if (rendered.kind === 'agent') {
    const task = await startExecution(
      deps.db,
      actor,
      {
        kind: 'agent',
        refId: rendered.refId,
        invoker,
        payload: { ...rendered.payload, expectedAgentId: rendered.refId },
      },
      launchDeps,
    )
    return { kind: 'orchestration', taskId: task.id }
  }
  if (rendered.kind === 'workgroup') {
    const task = await startExecution(
      deps.db,
      actor,
      {
        kind: 'workgroup',
        refId: rendered.refId,
        invoker,
        payload: { ...rendered.payload, expectedWorkgroupId: rendered.refId },
      },
      launchDeps,
    )
    return { kind: 'orchestration', taskId: task.id }
  }
  const task = await startExecution(
    deps.db,
    actor,
    { kind: 'workflow', refId: rendered.refId, invoker, payload: rendered.payload },
    launchDeps,
  )
  return { kind: 'orchestration', taskId: task.id }
}

async function fireTrigger(
  deps: WebhookDispatchDeps,
  queue: KeyedSerialQueue<string>,
  input: {
    deliveryId: string
    endpoint: WebhookEndpointRow
    event: CodeHostEvent
    trigger: ParsedTrigger
    fireId?: string
    eventSubscriptionId?: string
    eventDeliveryId?: string
    triggerContext?: TriggerContext
  },
): Promise<void> {
  const { event, trigger } = input
  const streamKey = streamKeyOf(event)
  const fireId = input.fireId ?? ulid()
  const triggerId = trigger.row.id
  await queue.run(`${triggerId}|${streamKey}`, async () => {
    const now = Date.now()
    const db = deps.db
    const base = { fireId, deliveryId: input.deliveryId, triggerId, streamKey }

    // A durable Event Center delivery is also the launch idempotency key. If
    // the process stopped after task creation but before delivery settlement,
    // retry adopts the existing task instead of launching a second one.
    const existingFire = db
      .select({ id: webhookTriggerFires.id })
      .from(webhookTriggerFires)
      .where(
        and(
          eq(webhookTriggerFires.deliveryId, input.deliveryId),
          eq(webhookTriggerFires.triggerId, triggerId),
        ),
      )
      .limit(1)
      .get()
    if (existingFire !== undefined) return
    if (input.fireId !== undefined) {
      const existingTask = db
        .select({ id: tasks.id })
        .from(tasks)
        .where(
          input.eventDeliveryId === undefined
            ? eq(tasks.webhookFireId, fireId)
            : eq(tasks.eventDeliveryId, input.eventDeliveryId),
        )
        .limit(1)
        .get()
      if (existingTask !== undefined) {
        await recordFire(db, { ...base, outcome: 'launched', taskId: existingTask.id })
        return
      }
    }

    // 匹配后启动前可能被并发禁用：互斥段内复查（outcome: skipped-trigger-disabled）。
    const fresh = (
      await db.select().from(webhookTriggers).where(eq(webhookTriggers.id, triggerId)).limit(1)
    )[0]
    if (!fresh || !fresh.enabled) {
      await recordFire(db, { ...base, outcome: 'skipped-trigger-disabled' })
      return
    }
    let effectiveTrigger = trigger
    if (trigger.row.cancelOnMrTerminal || fresh.cancelOnMrTerminal) {
      const freshParsed = parseTriggerRow(fresh)
      if (!freshParsed.ok) {
        await recordFire(db, {
          ...base,
          outcome: 'skipped-trigger-invalid',
          error: freshParsed.reason,
        })
        return
      }
      // RFC-303's durable guard is the terminal-policy configuration
      // linearization point. Legacy rules retain RFC-268's already-matched
      // snapshot semantics; only a rule entering/leaving protection is
      // re-read as one complete generation here.
      if (!matchTrigger(event, freshParsed.trigger.rule).hit) return
      effectiveTrigger = freshParsed.trigger
    }

    // 熔断闸门（D22；evaluateCircuit 顺序见 matching.ts）。
    const streamRow = (
      await db
        .select()
        .from(webhookTriggerStreams)
        .where(
          and(
            eq(webhookTriggerStreams.triggerId, triggerId),
            eq(webhookTriggerStreams.streamKey, streamKey),
          ),
        )
        .limit(1)
    )[0]
    const circuit = evaluateCircuit(
      streamRow
        ? { consecutiveFires: streamRow.consecutiveFires, lastFireAt: streamRow.lastFireAt }
        : null,
      event,
      {
        maxConsecutiveFires: effectiveTrigger.row.maxConsecutiveFires,
        ignoreUsernames: effectiveTrigger.rule.ignoreUsernames,
      },
      now,
    )
    const writeStream = async (count: number, launched: boolean): Promise<void> => {
      await db
        .insert(webhookTriggerStreams)
        .values({
          triggerId,
          streamKey,
          consecutiveFires: count,
          lastFireAt: launched ? now : (streamRow?.lastFireAt ?? null),
        })
        .onConflictDoUpdate({
          target: [webhookTriggerStreams.triggerId, webhookTriggerStreams.streamKey],
          set: {
            consecutiveFires: count,
            ...(launched ? { lastFireAt: now } : {}),
          },
        })
    }
    if (circuit.decision === 'open') {
      await recordFire(db, { ...base, outcome: 'skipped-circuit-open' })
      return
    }
    if (circuit.resetCount) {
      // 「人已介入」的清零独立于本次 launch 成败（D22）。
      await writeStream(0, false)
    }

    const deliveryFact = (
      await db
        .select({
          streamKey: webhookDeliveries.mrStreamKey,
          revision: webhookDeliveries.mrStreamRevision,
          stateAfter: webhookDeliveries.mrStateAfter,
        })
        .from(webhookDeliveries)
        .where(eq(webhookDeliveries.id, input.deliveryId))
        .limit(1)
    )[0]
    const deliveryState: MrStreamState | null =
      deliveryFact?.revision !== null &&
      deliveryFact?.revision !== undefined &&
      deliveryFact.stateAfter !== null
        ? {
            state: deliveryFact.stateAfter,
            revision: deliveryFact.revision,
            lastTerminalRevision: deliveryFact.stateAfter === 'open' ? null : deliveryFact.revision,
          }
        : null
    const protectedDecision = decideProtectedLaunch({
      cancelOnMrTerminal: effectiveTrigger.row.cancelOnMrTerminal,
      endpointId: input.endpoint.id,
      event,
      streamState: deliveryState,
    })
    if (protectedDecision.kind === 'control-only') return
    if (protectedDecision.kind === 'invalid-mr-identity') {
      await recordFire(db, { ...base, outcome: 'skipped-mr-stream-identity-missing' })
      return
    }
    if (protectedDecision.kind === 'blocked') {
      await recordFire(db, {
        ...base,
        outcome:
          protectedDecision.state === 'closed'
            ? 'skipped-mr-stream-closed'
            : 'skipped-mr-stream-merged',
      })
      return
    }

    let launchGuard: ProtectedMrLaunchGuard | undefined
    if (
      protectedDecision.kind === 'protected' &&
      effectiveTrigger.launchKind !== 'digital-employee'
    ) {
      if (
        deliveryFact?.streamKey !== protectedDecision.identity.streamKey ||
        deliveryFact.revision === null ||
        deliveryFact.revision === undefined ||
        deps.terminalControl === undefined
      ) {
        await recordFire(db, {
          ...base,
          outcome: 'skipped-mr-stream-identity-missing',
          error:
            deps.terminalControl === undefined
              ? 'terminal-control-unavailable'
              : 'delivery-linearization-missing',
        })
        return
      }
      try {
        launchGuard = deps.terminalControl.reserveLaunch({
          endpointId: input.endpoint.id,
          streamKey: protectedDecision.identity.streamKey,
          binding: protectedDecision.binding,
          launchRevision: deliveryFact.revision,
          deliveryId: input.deliveryId,
          fireId,
          triggerId,
          triggerName: effectiveTrigger.row.name,
        })
      } catch (error) {
        await recordFire(db, {
          ...base,
          outcome: 'skipped-mr-stream-terminal',
          error: errText(error),
        })
        return
      }
    }

    // RFC-310 PR-10 T104：code-round writer 已删除。存量 trigger 行（历史数据）
    // 的 fire 落 skipped-trigger-invalid 留痕，不再启动任何 round。
    if (effectiveTrigger.launchKind === 'code-round') {
      await recordFire(db, { ...base, outcome: 'skipped-trigger-invalid' })
      return
    }

    // supersede（D8/D21）：同流最近一次 launched 的任务未终态 → 取消。
    let supersededTaskId: string | null = null
    const prevFire = (
      await db
        .select({ taskId: webhookTriggerFires.taskId })
        .from(webhookTriggerFires)
        .where(
          and(
            eq(webhookTriggerFires.triggerId, triggerId),
            eq(webhookTriggerFires.streamKey, streamKey),
            eq(webhookTriggerFires.outcome, 'launched'),
          ),
        )
        .orderBy(desc(webhookTriggerFires.firedAt))
        .limit(1)
    )[0]
    if (prevFire?.taskId) {
      const prevTask = (
        await db
          .select({ id: tasks.id, status: tasks.status })
          .from(tasks)
          .where(eq(tasks.id, prevFire.taskId))
          .limit(1)
      )[0]
      if (prevTask && !isTerminalTaskStatus(prevTask.status)) {
        try {
          await (deps.cancel ?? ((taskId: string) => cancelExecution(db, taskId)))(prevTask.id)
          supersededTaskId = prevTask.id
        } catch (err) {
          // 终态竞态（cancel 时已经收尾）不阻塞新启动。
          log.warn('supersede cancel failed; continuing', {
            taskId: prevTask.id,
            error: errText(err),
          })
        }
      }
    }

    // RFC-268：scratch 在任何 cache/decrypt/clone 前短路。payload 与
    // autoRegisterRepos 同取匹配时快照，避免排队期间编辑造成混合代配置。
    let space: RepoResolution | { kind: 'scratch' }
    try {
      space =
        effectiveTrigger.launchKind === 'digital-employee' ||
        ('scratch' in effectiveTrigger.payloadTemplate &&
          effectiveTrigger.payloadTemplate.scratch === true)
          ? { kind: 'scratch' }
          : await (deps.resolveRepo ?? resolveRepoForEvent)(
              db,
              deps.secretBox,
              event,
              input.endpoint,
              effectiveTrigger.row.autoRegisterRepos,
            )
    } catch (error) {
      launchGuard?.failed(error instanceof DomainError ? error.code : 'repo-resolution-failed')
      launchGuard?.release()
      deps.terminalControl?.wake()
      await recordFire(db, {
        ...base,
        outcome: 'launch-failed',
        supersededTaskId,
        error: errText(error),
      })
      return
    }
    if (space.kind === 'unregistered') {
      launchGuard?.failed('repo-unregistered')
      launchGuard?.release()
      deps.terminalControl?.wake()
      await recordFire(db, { ...base, outcome: 'skipped-repo-unregistered', supersededTaskId })
      return
    }

    // owner 重建 + 目标可用性重校验（每次触发评估，AC-13；照抄 fireSchedule 骨架）。
    const actor = await buildInheritedActor(db, fresh.ownerUserId, 'webhook')
    if (actor === null) {
      launchGuard?.failed('owner-invalid')
      launchGuard?.release()
      deps.terminalControl?.wake()
      await recordFire(db, {
        ...base,
        outcome: 'skipped-owner-invalid',
        supersededTaskId,
        error: `owner '${fresh.ownerUserId}' missing or inactive`,
      })
      return
    }
    const rendered = renderWebhookLaunch(effectiveTrigger, effectiveTrigger.row.name, event, space)
    /** launch-failed 收尾：fires 行 + 触发器行的失败水位（熔断计数的唯一来源）。 */
    const recordLaunchFailed = async (msg: string): Promise<void> => {
      await recordFire(db, { ...base, outcome: 'launch-failed', supersededTaskId, error: msg })
      await db
        .update(webhookTriggers)
        .set({
          lastStatus: 'failed',
          lastError: msg,
          consecutiveFailures: sql`${webhookTriggers.consecutiveFailures} + 1`,
          updatedAt: now,
        })
        .where(eq(webhookTriggers.id, triggerId))
    }
    try {
      if (rendered.kind !== 'digital-employee') {
        await assertScheduledTargetUsable(
          db,
          actor,
          rendered.kind,
          rendered.payload as unknown as Record<string, unknown>,
          await deps.getDefaultRuntime(),
          { kind: 'context', value: webhookTriggerContextOf(event) },
        )
      }
    } catch (err) {
      // 这个 gate 同时做两件事：目标可用性（缺失 / 不可见 / built-in 不可调度）与
      // 渲染后的 payload·输入校验。早期实现把两类异常一律记成 skipped-owner-invalid
      // ——与枚举自身的语义矛盾（launch-failed 才是「owner 有效但启动失败
      // （payload-invalid）」），后果是配错的触发器**永远触不了熔断**、卡片一直挂着
      // 上一次的旧状态。按错误类别分流（RFC-268 实现门 P2，2026-08-09；归属 RFC-257）：
      //   ValidationError            → payload / 输入非法 → launch-failed（计入连续失败）
      //   NotFound / Forbidden / 其它 → 目标不可用或 owner 失去启动权 → skipped-owner-invalid
      if (err instanceof ValidationError) {
        launchGuard?.failed(err.code)
        launchGuard?.release()
        deps.terminalControl?.wake()
        await recordLaunchFailed(errText(err))
        return
      }
      launchGuard?.failed(err instanceof DomainError ? err.code : 'target-unusable')
      launchGuard?.release()
      deps.terminalControl?.wake()
      await recordFire(db, {
        ...base,
        outcome: 'skipped-owner-invalid',
        supersededTaskId,
        error: errText(err),
      })
      return
    }

    // 启动（唯一收口 startExecution；渲染后的全量校验 = launch 服务既有校验，
    // 失败即 launch-failed —— design §4.2「payload-invalid」不在此重复实现）。
    const invoker: ExecutionInvoker =
      input.eventSubscriptionId !== undefined && input.eventDeliveryId !== undefined
        ? {
            type: 'event',
            eventSubscriptionId: input.eventSubscriptionId,
            eventDeliveryId: input.eventDeliveryId,
            triggerContext: input.triggerContext ?? webhookTriggerContextOf(event),
            ...(launchGuard === undefined
              ? {}
              : { sourceTerminationSnapshot: launchGuard.snapshot }),
          }
        : {
            type: 'webhook',
            webhookTriggerId: triggerId,
            webhookFireId: fireId,
            triggerContext: webhookTriggerContextOf(event),
            ...(launchGuard === undefined
              ? {}
              : { sourceTerminationSnapshot: launchGuard.snapshot }),
          }
    try {
      const rawReceipt =
        deps.launch !== undefined
          ? await deps.launch(actor, rendered, invoker)
          : await launchViaExecutor(deps, actor, rendered, invoker, launchGuard)
      const receipt: WorkStartReceipt =
        typeof rawReceipt === 'string' ? { kind: 'orchestration', taskId: rawReceipt } : rawReceipt
      if (receipt.kind === 'orchestration') {
        launchGuard?.taskCommitted(receipt.taskId)
        launchGuard?.launchSettled(receipt.taskId)
      }
      await recordFire(db, {
        ...base,
        outcome: 'launched',
        supersededTaskId,
        ...(receipt.kind === 'orchestration'
          ? { taskId: receipt.taskId }
          : { employeeCaseId: receipt.caseId }),
      })
      await writeStream(circuit.effectiveCount + 1, true)
      await db
        .update(webhookTriggers)
        .set({
          lastFiredAt: now,
          lastStatus: 'launched',
          lastError: null,
          lastTaskId: receipt.kind === 'orchestration' ? receipt.taskId : null,
          consecutiveFailures: 0,
          updatedAt: now,
        })
        .where(eq(webhookTriggers.id, triggerId))
    } catch (err) {
      launchGuard?.failed(err instanceof DomainError ? err.code : 'launch-failed')
      if (err instanceof DomainError && err.code === 'webhook-mr-launch-terminal') {
        await recordFire(db, {
          ...base,
          outcome: 'skipped-mr-stream-terminal',
          supersededTaskId,
          error: errText(err),
        })
      } else {
        await recordLaunchFailed(errText(err))
      }
    } finally {
      launchGuard?.release()
      deps.terminalControl?.wake()
    }
  })
}

async function recordInvalidPayloadFire(
  deps: WebhookDispatchDeps,
  queue: KeyedSerialQueue<string>,
  input: {
    deliveryId: string
    event: CodeHostEvent
    row: typeof webhookTriggers.$inferSelect
  },
): Promise<void> {
  const streamKey = streamKeyOf(input.event)
  const triggerId = input.row.id
  const fireId = ulid()
  await queue.run(`${triggerId}|${streamKey}`, async () => {
    const now = Date.now()
    const fresh = (
      await deps.db
        .select({ enabled: webhookTriggers.enabled })
        .from(webhookTriggers)
        .where(eq(webhookTriggers.id, triggerId))
        .limit(1)
    )[0]
    if (!fresh?.enabled) {
      await recordFire(deps.db, {
        fireId,
        deliveryId: input.deliveryId,
        triggerId,
        streamKey,
        outcome: 'skipped-trigger-disabled',
      })
      return
    }
    const message = 'payload-invalid: webhook launch template migration or validation failed'
    await recordFire(deps.db, {
      fireId,
      deliveryId: input.deliveryId,
      triggerId,
      streamKey,
      outcome: 'launch-failed',
      error: message,
    })
    await deps.db
      .update(webhookTriggers)
      .set({
        lastStatus: 'failed',
        lastError: message,
        consecutiveFailures: sql`${webhookTriggers.consecutiveFailures} + 1`,
        updatedAt: now,
      })
      .where(eq(webhookTriggers.id, triggerId))
  })
}
export function createWebhookDispatcher(
  deps: WebhookDispatchDeps,
): WebhookDispatcher & EventCenterCodeHostDeliveryDispatcher & EventCenterAutomationWorkStarter {
  const streamQueue = new KeyedSerialQueue<string>()
  return {
    async dispatch(input) {
      const { deliveryId, endpoint, event } = input
      const db = deps.db
      try {
        await markDelivery(db, deliveryId, 'processing')
        const rows = await db
          .select()
          .from(webhookTriggers)
          .where(
            and(eq(webhookTriggers.endpointId, endpoint.id), eq(webhookTriggers.enabled, true)),
          )
        const hits: ParsedTrigger[] = []
        const deliveryLineage = (
          await db
            .select({ replayedFromDeliveryId: webhookDeliveries.replayedFromDeliveryId })
            .from(webhookDeliveries)
            .where(eq(webhookDeliveries.id, deliveryId))
            .limit(1)
        )[0]
        const effectDeliveryId = deliveryLineage?.replayedFromDeliveryId ?? deliveryId
        const controlEffect = (
          await db
            .select({ id: webhookMrControlEffects.id })
            .from(webhookMrControlEffects)
            .where(eq(webhookMrControlEffects.deliveryId, effectDeliveryId))
            .limit(1)
        )[0]
        let invalidPayloadMatched = false
        for (const row of rows) {
          const canonicalRow = await migrateTriggerRowTemplateToV2(db, row)
          const parsed = parseTriggerRow(canonicalRow)
          if (!parsed.ok) {
            if (parsed.reason === 'launch-payload-invalid') {
              const parsedRule = parseTriggerRuleRow(canonicalRow)
              if (parsedRule.ok && matchTrigger(event, parsedRule.rule).hit) {
                invalidPayloadMatched = true
                await recordInvalidPayloadFire(deps, streamQueue, {
                  deliveryId,
                  event,
                  row: canonicalRow,
                })
              }
            } else if (parsed.reason === 'terminal-policy-invalid') {
              const parsedRule = parseTriggerRuleRow(canonicalRow, {
                ignoreTerminalPolicy: true,
              })
              if (parsedRule.ok && matchTrigger(event, parsedRule.rule).hit) {
                invalidPayloadMatched = true
                await recordInvalidTerminalPolicyFire(deps, streamQueue, {
                  deliveryId,
                  event,
                  row: canonicalRow,
                })
              }
            }
            // 行级容错：单条坏触发器不拖垮端点分发（管理面负责让它修好）。
            log.warn('skipping unparsable trigger row', {
              triggerId: row.id,
              reason: parsed.reason,
            })
            continue
          }
          if (matchTrigger(event, parsed.trigger.rule).hit) hits.push(parsed.trigger)
        }
        if (hits.length === 0 && !invalidPayloadMatched) {
          if (controlEffect !== undefined) {
            await markDelivery(db, deliveryId, 'matched', 'terminal-control-accepted')
            deps.terminalControl?.wake(controlEffect.id)
          } else {
            await markDelivery(db, deliveryId, 'ignored', 'no-trigger-matched')
          }
          return
        }
        // 命中触发器逐个 fire（同一 delivery 串行；跨 delivery 的并发由
        // per-stream 互斥收敛）。单个 fire 的失败已在 fires 行内终结，不上抛。
        for (const trigger of hits) {
          await fireTrigger(deps, streamQueue, { deliveryId, endpoint, event, trigger })
        }
        await markDelivery(db, deliveryId, 'matched')
        if (controlEffect !== undefined) deps.terminalControl?.wake(controlEffect.id)
      } catch (err) {
        log.error('webhook dispatch failed', { deliveryId, error: errText(err) })
        await markDelivery(db, deliveryId, 'failed', 'internal-error').catch(() => {})
      }
    },
    async dispatchSubscription(input) {
      const db = deps.db
      const delivery = db
        .select()
        .from(webhookDeliveries)
        .where(eq(webhookDeliveries.id, input.deliveryId))
        .limit(1)
        .get()
      if (delivery === undefined || delivery.bodyJson === null || delivery.bodyJson === '') {
        throw new Error(`webhook delivery is unavailable: ${input.deliveryId}`)
      }
      const endpoint = db
        .select()
        .from(webhookEndpoints)
        .where(eq(webhookEndpoints.id, delivery.endpointId))
        .limit(1)
        .get()
      if (endpoint === undefined) {
        throw new Error(`webhook endpoint is unavailable: ${delivery.endpointId}`)
      }
      const adapter = CODE_HOST_ADAPTERS[endpoint.provider]
      if (adapter === undefined) {
        throw new Error(`webhook provider is unavailable: ${endpoint.provider}`)
      }
      let body: unknown
      try {
        body = JSON.parse(delivery.bodyJson) as unknown
      } catch {
        throw new Error(`webhook delivery body is invalid: ${input.deliveryId}`)
      }
      const normalized = adapter.normalize(replayHeaders(adapter, delivery.gitlabEventHeader), body)
      if (!normalized.ok) {
        throw new Error(`webhook delivery cannot be normalized: ${normalized.detail}`)
      }
      const event = normalized.event
      const row = db
        .select()
        .from(webhookTriggers)
        .where(
          and(eq(webhookTriggers.id, input.triggerId), eq(webhookTriggers.endpointId, endpoint.id)),
        )
        .limit(1)
        .get()
      if (row === undefined || !row.enabled) return
      const canonicalRow = await migrateTriggerRowTemplateToV2(db, row)
      const parsed = parseTriggerRow(canonicalRow)
      if (!parsed.ok || !matchTrigger(event, parsed.trigger.rule).hit) return
      await fireTrigger(deps, streamQueue, {
        deliveryId: input.deliveryId,
        endpoint,
        event,
        trigger: parsed.trigger,
        fireId: input.eventDeliveryId,
        eventSubscriptionId: input.eventSubscriptionId,
        eventDeliveryId: input.eventDeliveryId,
        triggerContext: input.triggerContext,
      })
      const rootDeliveryId = delivery.replayedFromDeliveryId ?? input.deliveryId
      const controlEffect = db
        .select({ id: webhookMrControlEffects.id })
        .from(webhookMrControlEffects)
        .where(eq(webhookMrControlEffects.deliveryId, rootDeliveryId))
        .limit(1)
        .get()
      if (controlEffect !== undefined) {
        deps.terminalControl?.wake(controlEffect.id)
      }
    },
    async dispatchEventTarget(input) {
      const actor = await buildInheritedActor(deps.db, input.ownerUserId, 'event')
      if (actor === null) {
        throw new ValidationError(
          'event-response-owner-invalid',
          `event response owner is missing or inactive: ${input.ownerUserId}`,
        )
      }
      const rendered = renderEventResponseTarget(input.target, input.triggerContext)
      if (rendered.kind !== 'digital-employee') {
        await assertScheduledTargetUsable(
          deps.db,
          actor,
          rendered.kind,
          rendered.payload as unknown as Record<string, unknown>,
          await deps.getDefaultRuntime(),
          { kind: 'context', value: input.triggerContext },
        )
      }
      return launchViaExecutor(deps, actor, rendered, {
        type: 'event',
        eventSubscriptionId: input.eventSubscriptionId,
        eventDeliveryId: input.eventDeliveryId,
        triggerContext: input.triggerContext,
      })
    },
  }
}

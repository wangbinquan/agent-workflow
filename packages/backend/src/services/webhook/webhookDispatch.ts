// RFC-257 T6 — Webhook response execution service（design §0/§4/§5）。
// 生产入口只使用 dispatchSubscription：一条 Event Center Delivery 精确执行一条
// 已匹配规则，绝不重扫 endpoint，也不修改共享 Webhook audit 状态。旧 dispatch
// 仅为存量嵌入方/回归夹具保留。每个执行结果仍写一条 fires 行；启动唯一收口 =
// startExecution（RFC-243 门面）。执行器调用面位于 provider-private
// sqliteWebhookDispatchRuntime，并由 rfc243-executor-facade.test.ts 的手工清单锁定。
//
// 并发纪律（设计门 F-5 / D24）：per (triggerId, streamKey) 的 KeyedSerialQueue
// 串行化「supersede 判定 → 熔断评估 → 启动 → 落库」全段。dispatch 全程多
// await 点（DB / clone / cancel 5s 轮询），无互斥则两并发同流事件会双取消旧
// 任务后各自启动 —— 双任务存活且 fires 链出孤儿。
import { ulid } from 'ulid'

import { type Actor } from '@/auth/actor'
import type {
  DelegatedRequestAuthorityFactory,
  RequestAuthority,
} from '@/modules/identity-access/public/participants'
import type { GetUserGitCommitIdentity } from '@/modules/identity-access/public/queries'
import type {
  TaskExecutionResourceAuthority,
  TaskExecutionResourceBinding,
} from '@/services/execution/taskExecutionResources'
import type {
  EventCenterAutomationWorkStarter,
  EventCenterCodeHostDeliveryDispatcher,
  WebhookDispatcher,
  WebhookEndpointRow,
} from '@/services/webhook/dispatcherTypes'
import { CODE_HOST_ADAPTERS, replayHeaders } from '@/services/webhook/codeHostAdapter'
import type { ExecutionInvoker } from '@/services/execution/types'
import type { IntegrationTriggerResourceBinding } from '@/services/scheduledTasks'
import { markDelivery } from '@/services/webhook/deliveryStore'
import {
  evaluateCircuit,
  matchTrigger,
  streamKeyOf,
  type TriggerRule,
} from '@/services/webhook/matching'
import { ValidationError } from '@/util/errors'
import { KeyedSerialQueue } from '@/util/keyedSerialQueue'
import { createLogger } from '@/util/log'
import {
  CodeHostEventTypeSchema,
  WebhookRepoScopeSchema,
  isTerminalTaskStatus,
  mapWebhookTemplateSurfaces,
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
import {
  decideProtectedLaunch,
  type MrStreamState,
} from '@/modules/integration/domain/mrTerminalControl'
import type {
  MrTerminalControl,
  ProtectedMrLaunchGuard,
} from '@/modules/integration/public/mrTerminalControl'
import { DomainError } from '@/util/errors'
import type { WorkStartReceipt, WorkStartTarget } from '@/modules/integration/public/participants'
import type { EventResponseTarget } from '@/modules/event-center/public/types'
import type {
  WebhookDispatchPersistencePort,
  WebhookTriggerRecord,
} from '@/modules/integration/application/ports/webhookDispatchPersistence'
import type { WebhookDeliveryPersistencePort } from '@/modules/integration/application/ports/webhookDeliveryPersistence'

const log = createLogger('webhook-dispatch')

export type WebhookDispatchDeps = {
  persistence: WebhookDispatchPersistencePort
  deliveryPersistence: WebhookDeliveryPersistencePort
  identityAccess: Readonly<{
    delegatedRequests: DelegatedRequestAuthorityFactory
    getUserGitCommitIdentity: GetUserGitCommitIdentity
    integrationTriggerResources: IntegrationTriggerResourceBinding
    taskExecutionResources: TaskExecutionResourceBinding
  }>
  resolveEventTargetAuthority: (
    userId: string,
  ) => Promise<Readonly<{ authority: RequestAuthority; actor: Actor }> | null>
  /** per-dispatch 读取（对齐 scheduledTaskScheduler 的 per-tick cfg.defaultRuntime）。 */
  getDefaultRuntime: () => Promise<string | null | undefined>
  /**
   * 测试接缝（fireSchedule 的 buildLaunch 注入同款先例）：缺省走真实现——
   * launch = startExecution 门面、cancel = cancelExecution。生产装配不传。
   */
  launch: (
    actor: Actor,
    rendered: RenderedLaunch,
    invoker: ExecutionInvoker,
    launchResources: TaskExecutionResourceAuthority,
    guard?: ProtectedMrLaunchGuard,
  ) => Promise<string | WorkStartReceipt>
  cancel: (taskId: string) => Promise<unknown>
  /** RFC-268 测试接缝：证明 scratch 在 repo resolver 入口之前即完成分流。 */
  resolveRepo: (
    event: CodeHostEvent,
    endpoint: Pick<WebhookEndpointRow, 'preferredCloneProtocol'>,
    autoRegister: boolean,
  ) => Promise<RepoResolution>
  admitLaunch: (input: {
    readonly rendered: RenderedLaunch
    readonly resourceAuthority: Readonly<{
      authority: RequestAuthority
      actor: Actor
      resources: IntegrationTriggerResourceBinding
      taskExecutionResources: TaskExecutionResourceBinding
    }>
    readonly defaultRuntime: string | null | undefined
    readonly triggerContext: TriggerContext
  }) => Promise<void>
  /** RFC-303 bootstrap-owned durable guard/effect controller. */
  terminalControl?: MrTerminalControl
}

// ---------------------------------------------------------------------------
// 触发器行解析（JSON 列行级容错：单行坏数据跳过并告警，不拖垮整个端点的分发）
// ---------------------------------------------------------------------------

export type ParsedTrigger = {
  row: WebhookTriggerRecord
  rule: TriggerRule
  launchKind: WebhookLaunchKind
  launchRefId: string
  payloadTemplate: WebhookLaunchPayloadTemplate
  templateMigrated: boolean
}

function parseTriggerRuleRow(
  row: WebhookTriggerRecord,
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
    row: WebhookTriggerRecord
  },
): Promise<void> {
  const streamKey = streamKeyOf(input.event)
  await queue.run(`${input.row.id}|${streamKey}`, async () => {
    const enabled = await deps.persistence.triggerEnabled(input.row.id)
    await recordFire(deps.persistence, {
      fireId: ulid(),
      deliveryId: input.deliveryId,
      triggerId: input.row.id,
      streamKey,
      outcome: enabled ? 'skipped-trigger-invalid' : 'skipped-trigger-disabled',
      ...(enabled ? { error: 'terminal-policy-invalid' } : {}),
    })
  })
}

export function parseTriggerRow(
  row: WebhookTriggerRecord,
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
  persistence: WebhookDispatchPersistencePort,
  row: WebhookTriggerRecord,
): Promise<WebhookTriggerRecord> {
  const parsed = parseTriggerRow(row)
  if (!parsed.ok || !parsed.trigger.templateMigrated) return row
  return (
    (await persistence.migrateTriggerTemplate({
      triggerId: row.id,
      expectedLaunchPayload: row.launchPayload,
      launchPayload: JSON.stringify(parsed.trigger.payloadTemplate),
      now: Date.now(),
    })) ?? row
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

// ---------------------------------------------------------------------------
// 启动参数渲染（design §4.2；渲染后的全量校验 = 各 launch 服务的既有校验，
// 失败走 launch-failed —— 不在此重复实现校验器）
// ---------------------------------------------------------------------------

function fireTaskName(triggerName: string, event: CodeHostEvent): string {
  const anchor = event.mrIid !== undefined ? `${event.repoPath}!${event.mrIid}` : event.repoPath
  return `[${triggerName}] ${anchor}`.slice(0, 255)
}

export type RenderedLaunch = WorkStartTarget

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
  persistence: WebhookDispatchPersistencePort,
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
  await persistence.recordFire(input)
}

function errText(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 2000)
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
    const base = { fireId, deliveryId: input.deliveryId, triggerId, streamKey }

    // A durable Event Center delivery is also the launch idempotency key. If
    // the process stopped after task creation but before delivery settlement,
    // retry adopts the existing task instead of launching a second one.
    if (await deps.persistence.fireExists(input.deliveryId, triggerId)) return
    if (input.fireId !== undefined) {
      const existingTaskId = await deps.persistence.findTaskByOrigin({
        fireId,
        ...(input.eventDeliveryId === undefined ? {} : { eventDeliveryId: input.eventDeliveryId }),
      })
      if (existingTaskId !== null) {
        await recordFire(deps.persistence, {
          ...base,
          outcome: 'launched',
          taskId: existingTaskId,
        })
        return
      }
    }

    // 匹配后启动前可能被并发禁用：互斥段内复查（outcome: skipped-trigger-disabled）。
    const fresh = await deps.persistence.getTrigger(triggerId)
    if (!fresh || !fresh.enabled) {
      await recordFire(deps.persistence, { ...base, outcome: 'skipped-trigger-disabled' })
      return
    }
    let effectiveTrigger = trigger
    if (trigger.row.cancelOnMrTerminal || fresh.cancelOnMrTerminal) {
      const freshParsed = parseTriggerRow(fresh)
      if (!freshParsed.ok) {
        await recordFire(deps.persistence, {
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
    const streamRow = await deps.persistence.getTriggerStream(triggerId, streamKey)
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
      await deps.persistence.putTriggerStream({
        triggerId,
        streamKey,
        consecutiveFires: count,
        ...(launched ? { lastFireAt: now } : {}),
      })
    }
    if (circuit.decision === 'open') {
      await recordFire(deps.persistence, { ...base, outcome: 'skipped-circuit-open' })
      return
    }
    if (circuit.resetCount) {
      // 「人已介入」的清零独立于本次 launch 成败（D22）。
      await writeStream(0, false)
    }

    const deliveryFact = await deps.persistence.getDeliveryMrFact(input.deliveryId)
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
      await recordFire(deps.persistence, { ...base, outcome: 'skipped-mr-stream-identity-missing' })
      return
    }
    if (protectedDecision.kind === 'blocked') {
      await recordFire(deps.persistence, {
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
        await recordFire(deps.persistence, {
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
        launchGuard = await deps.terminalControl.reserveLaunch({
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
        await recordFire(deps.persistence, {
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
      await recordFire(deps.persistence, { ...base, outcome: 'skipped-trigger-invalid' })
      return
    }

    // supersede（D8/D21）：同流最近一次 launched 的任务未终态 → 取消。
    let supersededTaskId: string | null = null
    const prevTask = await deps.persistence.findLatestLaunchedTask(triggerId, streamKey)
    if (prevTask !== null && !isTerminalTaskStatus(prevTask.status)) {
      try {
        await deps.cancel(prevTask.id)
        supersededTaskId = prevTask.id
      } catch (err) {
        // 终态竞态（cancel 时已经收尾）不阻塞新启动。
        log.warn('supersede cancel failed; continuing', {
          taskId: prevTask.id,
          error: errText(err),
        })
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
          : await deps.resolveRepo(event, input.endpoint, effectiveTrigger.row.autoRegisterRepos)
    } catch (error) {
      await launchGuard?.failed(
        error instanceof DomainError ? error.code : 'repo-resolution-failed',
      )
      launchGuard?.release()
      deps.terminalControl?.wake()
      await recordFire(deps.persistence, {
        ...base,
        outcome: 'launch-failed',
        supersededTaskId,
        error: errText(error),
      })
      return
    }
    if (space.kind === 'unregistered') {
      await launchGuard?.failed('repo-unregistered')
      launchGuard?.release()
      deps.terminalControl?.wake()
      await recordFire(deps.persistence, {
        ...base,
        outcome: 'skipped-repo-unregistered',
        supersededTaskId,
      })
      return
    }

    // owner 重建 + 目标可用性重校验（每次触发评估，AC-13；照抄 fireSchedule 骨架）。
    const delegated = await deps.identityAccess.delegatedRequests.forWebhook({
      ownerUserId: fresh.ownerUserId,
      triggerId,
      deliveryId: input.deliveryId,
      fireId,
    })
    if (delegated === null) {
      await launchGuard?.failed('owner-invalid')
      launchGuard?.release()
      deps.terminalControl?.wake()
      await recordFire(deps.persistence, {
        ...base,
        outcome: 'skipped-owner-invalid',
        supersededTaskId,
        error: `owner '${fresh.ownerUserId}' missing or inactive`,
      })
      return
    }
    const actor: Actor = delegated.actor
    const resourceAuthority = Object.freeze({
      authority: delegated.authority,
      actor,
      resources: deps.identityAccess.integrationTriggerResources,
      taskExecutionResources: deps.identityAccess.taskExecutionResources,
    })
    const taskExecutionAuthority = Object.freeze({
      authority: delegated.authority,
      actor,
      resources: deps.identityAccess.taskExecutionResources,
    })
    const rendered = renderWebhookLaunch(effectiveTrigger, effectiveTrigger.row.name, event, space)
    /** launch-failed 收尾：fires 行 + 触发器行的失败水位（熔断计数的唯一来源）。 */
    const recordLaunchFailed = async (msg: string): Promise<void> => {
      await recordFire(deps.persistence, {
        ...base,
        outcome: 'launch-failed',
        supersededTaskId,
        error: msg,
      })
      await deps.persistence.markTriggerLaunchFailed(triggerId, msg, now)
    }
    try {
      await deps.admitLaunch({
        rendered,
        resourceAuthority,
        defaultRuntime: await deps.getDefaultRuntime(),
        triggerContext: webhookTriggerContextOf(event),
      })
    } catch (err) {
      // 这个 gate 同时做两件事：目标可用性（缺失 / 不可见 / built-in 不可调度）与
      // 渲染后的 payload·输入校验。早期实现把两类异常一律记成 skipped-owner-invalid
      // ——与枚举自身的语义矛盾（launch-failed 才是「owner 有效但启动失败
      // （payload-invalid）」），后果是配错的触发器**永远触不了熔断**、卡片一直挂着
      // 上一次的旧状态。按错误类别分流（RFC-268 实现门 P2，2026-08-09；归属 RFC-257）：
      //   ValidationError            → payload / 输入非法 → launch-failed（计入连续失败）
      //   NotFound / Forbidden / 其它 → 目标不可用或 owner 失去启动权 → skipped-owner-invalid
      if (err instanceof ValidationError) {
        await launchGuard?.failed(err.code)
        launchGuard?.release()
        deps.terminalControl?.wake()
        await recordLaunchFailed(errText(err))
        return
      }
      await launchGuard?.failed(err instanceof DomainError ? err.code : 'target-unusable')
      launchGuard?.release()
      deps.terminalControl?.wake()
      await recordFire(deps.persistence, {
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
      const rawReceipt = await deps.launch(
        actor,
        rendered,
        invoker,
        taskExecutionAuthority,
        launchGuard,
      )
      const receipt: WorkStartReceipt =
        typeof rawReceipt === 'string' ? { kind: 'orchestration', taskId: rawReceipt } : rawReceipt
      if (receipt.kind === 'orchestration') {
        await launchGuard?.taskCommitted(receipt.taskId)
        await launchGuard?.launchSettled(receipt.taskId)
      }
      await recordFire(deps.persistence, {
        ...base,
        outcome: 'launched',
        supersededTaskId,
        ...(receipt.kind === 'orchestration'
          ? { taskId: receipt.taskId }
          : { employeeCaseId: receipt.caseId }),
      })
      await writeStream(circuit.effectiveCount + 1, true)
      await deps.persistence.markTriggerLaunched({
        triggerId,
        taskId: receipt.kind === 'orchestration' ? receipt.taskId : null,
        now,
      })
    } catch (err) {
      await launchGuard?.failed(err instanceof DomainError ? err.code : 'launch-failed')
      if (err instanceof DomainError && err.code === 'webhook-mr-launch-terminal') {
        await recordFire(deps.persistence, {
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
    row: WebhookTriggerRecord
  },
): Promise<void> {
  const streamKey = streamKeyOf(input.event)
  const triggerId = input.row.id
  const fireId = ulid()
  await queue.run(`${triggerId}|${streamKey}`, async () => {
    const now = Date.now()
    if (!(await deps.persistence.triggerEnabled(triggerId))) {
      await recordFire(deps.persistence, {
        fireId,
        deliveryId: input.deliveryId,
        triggerId,
        streamKey,
        outcome: 'skipped-trigger-disabled',
      })
      return
    }
    const message = 'payload-invalid: webhook launch template migration or validation failed'
    await recordFire(deps.persistence, {
      fireId,
      deliveryId: input.deliveryId,
      triggerId,
      streamKey,
      outcome: 'launch-failed',
      error: message,
    })
    await deps.persistence.markTriggerLaunchFailed(triggerId, message, now)
  })
}
export function createWebhookDispatcher(
  deps: WebhookDispatchDeps,
): WebhookDispatcher & EventCenterCodeHostDeliveryDispatcher & EventCenterAutomationWorkStarter {
  const streamQueue = new KeyedSerialQueue<string>()
  return {
    async dispatch(input) {
      const { deliveryId, endpoint, event } = input
      try {
        await markDelivery(deps.deliveryPersistence, deliveryId, 'processing')
        const rows = await deps.persistence.listEnabledTriggers(endpoint.id)
        const hits: ParsedTrigger[] = []
        const controlEffectId = await deps.persistence.deliveryControlEffectId(deliveryId)
        let invalidPayloadMatched = false
        for (const row of rows) {
          const canonicalRow = await migrateTriggerRowTemplateToV2(deps.persistence, row)
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
          if (controlEffectId !== null) {
            await markDelivery(
              deps.deliveryPersistence,
              deliveryId,
              'matched',
              'terminal-control-accepted',
            )
            deps.terminalControl?.wake(controlEffectId)
          } else {
            await markDelivery(
              deps.deliveryPersistence,
              deliveryId,
              'ignored',
              'no-trigger-matched',
            )
          }
          return
        }
        // 命中触发器逐个 fire（同一 delivery 串行；跨 delivery 的并发由
        // per-stream 互斥收敛）。单个 fire 的失败已在 fires 行内终结，不上抛。
        for (const trigger of hits) {
          await fireTrigger(deps, streamQueue, { deliveryId, endpoint, event, trigger })
        }
        await markDelivery(deps.deliveryPersistence, deliveryId, 'matched')
        if (controlEffectId !== null) deps.terminalControl?.wake(controlEffectId)
      } catch (err) {
        log.error('webhook dispatch failed', { deliveryId, error: errText(err) })
        await markDelivery(deps.deliveryPersistence, deliveryId, 'failed', 'internal-error').catch(
          () => {},
        )
      }
    },
    async dispatchSubscription(input) {
      const envelope = await deps.persistence.subscriptionEnvelope(input.deliveryId)
      const bodyJson = envelope?.delivery.bodyJson ?? null
      if (envelope === null || bodyJson === null || bodyJson === '') {
        throw new Error(`webhook delivery is unavailable: ${input.deliveryId}`)
      }
      const { delivery, endpoint } = envelope
      const adapter = CODE_HOST_ADAPTERS[endpoint.provider]
      if (adapter === undefined) {
        throw new Error(`webhook provider is unavailable: ${endpoint.provider}`)
      }
      let body: unknown
      try {
        body = JSON.parse(bodyJson) as unknown
      } catch {
        throw new Error(`webhook delivery body is invalid: ${input.deliveryId}`)
      }
      const normalized = adapter.normalize(replayHeaders(adapter, delivery.gitlabEventHeader), body)
      if (!normalized.ok) {
        throw new Error(`webhook delivery cannot be normalized: ${normalized.detail}`)
      }
      const event = normalized.event
      const row = await deps.persistence.getTrigger(input.triggerId)
      if (row === null || row.endpointId !== endpoint.id || !row.enabled) return
      const canonicalRow = await migrateTriggerRowTemplateToV2(deps.persistence, row)
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
      const controlEffectId = await deps.persistence.deliveryControlEffectId(input.deliveryId)
      if (controlEffectId !== null) {
        deps.terminalControl?.wake(controlEffectId)
      }
    },
    async dispatchEventTarget(input) {
      const admitted = await deps.resolveEventTargetAuthority(input.ownerUserId)
      if (admitted === null) {
        throw new ValidationError(
          'event-response-owner-invalid',
          `event response owner is missing or inactive: ${input.ownerUserId}`,
        )
      }
      const resourceAuthority = Object.freeze({
        authority: admitted.authority,
        actor: admitted.actor,
        resources: deps.identityAccess.integrationTriggerResources,
        taskExecutionResources: deps.identityAccess.taskExecutionResources,
      })
      const rendered = renderEventResponseTarget(input.target, input.triggerContext)
      await deps.admitLaunch({
        rendered,
        resourceAuthority,
        defaultRuntime: await deps.getDefaultRuntime(),
        triggerContext: input.triggerContext,
      })
      const rawReceipt = await deps.launch(
        admitted.actor,
        rendered,
        {
          type: 'event',
          eventSubscriptionId: input.eventSubscriptionId,
          eventDeliveryId: input.eventDeliveryId,
          triggerContext: input.triggerContext,
        },
        Object.freeze({
          authority: admitted.authority,
          actor: admitted.actor,
          resources: deps.identityAccess.taskExecutionResources,
        }),
      )
      return typeof rawReceipt === 'string'
        ? { kind: 'orchestration', taskId: rawReceipt }
        : rawReceipt
    },
  }
}

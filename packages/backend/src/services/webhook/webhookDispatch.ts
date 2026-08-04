// RFC-257 T6 — 异步分流服务（五步流水线的 [2]-[5]，design §0/§4/§5）。
// 契约：接手 received 行后推进 processing → 终态（matched / ignored / failed）；
// 每个命中触发器一条 fires 行。启动唯一收口 = startExecution（RFC-243 门面，
// 本文件在 rfc243-executor-facade.test.ts 的 CALL_FACES 清单内——设计门 F-7：
// 该锁是硬编码清单，新调用面必须显式登记）。
//
// 并发纪律（设计门 F-5 / D24）：per (triggerId, streamKey) 的 KeyedSerialQueue
// 串行化「supersede 判定 → 熔断评估 → 启动 → 落库」全段。dispatch 全程多
// await 点（DB / clone / cancel 5s 轮询），无互斥则两并发同流事件会双取消旧
// 任务后各自启动 —— 双任务存活且 fires 链出孤儿。
import { and, desc, eq, sql } from 'drizzle-orm'
import { createHash } from 'node:crypto'
import { ulid } from 'ulid'

import type { Actor } from '@/auth/actor'
import { buildActor } from '@/auth/actor'
import type { SecretBox } from '@/auth/secretBox'
import type { DbClient } from '@/db/client'
import {
  cachedRepos,
  tasks,
  users,
  webhookTriggerFires,
  webhookTriggers,
  webhookTriggerStreams,
} from '@/db/schema'
import type { WebhookDispatcher, WebhookEndpointRow } from '@/routes/webhooks'
import { cancelExecution, startExecution } from '@/services/execution/executor'
import type { ExecutionInvoker } from '@/services/execution/types'
import { assertScheduledTargetUsable } from '@/services/scheduledTasks'
import type { ContainmentCoordinator } from '@/services/sandbox'
import { buildStartTaskDeps } from '@/services/startTaskDeps'
import { markDelivery } from '@/services/webhook/deliveryStore'
import {
  evaluateCircuit,
  matchTrigger,
  streamKeyOf,
  type TriggerRule,
} from '@/services/webhook/matching'
import { unsealRepoUrl } from '@/services/repoCredentials'
import { KeyedSerialQueue } from '@/util/keyedSerialQueue'
import { createLogger } from '@/util/log'
import { resolveOpencodeCmd } from '@/util/opencode'
import {
  CodeHostEventTypeSchema,
  WebhookRepoScopeSchema,
  eventVarsOf,
  isTerminalTaskStatus,
  gitUrlCacheKeyWith,
  parseGitUrl,
  renderTemplate,
  webhookPayloadTemplateSchemaFor,
  type CodeHostEvent,
  type StartAgentTask,
  type StartTask,
  type StartWorkgroupTask,
  type WebhookAgentPayloadTemplate,
  type WebhookFireOutcome,
  type WebhookLaunchKind,
  type WebhookLaunchPayloadTemplate,
  type WebhookWorkflowPayloadTemplate,
  type WebhookWorkgroupPayloadTemplate,
} from '@agent-workflow/shared'
import { z } from 'zod'

const log = createLogger('webhook-dispatch')

const sha1Hex = (s: string): string => createHash('sha1').update(s).digest('hex')

export type WebhookDispatchDeps = {
  db: DbClient
  configPath: string
  secretBox: SecretBox
  containmentCoordinator?: ContainmentCoordinator
  /** per-dispatch 读取（对齐 scheduledTaskScheduler 的 per-tick cfg.defaultRuntime）。 */
  getDefaultRuntime: () => Promise<string | null | undefined>
  /**
   * 测试接缝（fireSchedule 的 buildLaunch 注入同款先例）：缺省走真实现——
   * launch = startExecution 门面、cancel = cancelExecution。生产装配不传。
   */
  launch?: (actor: Actor, rendered: RenderedLaunch, invoker: ExecutionInvoker) => Promise<string>
  cancel?: (taskId: string) => Promise<unknown>
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
}

export function parseTriggerRow(
  row: typeof webhookTriggers.$inferSelect,
): { ok: true; trigger: ParsedTrigger } | { ok: false; reason: string } {
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
  if (eventTypes === null || !eventTypes.success)
    return { ok: false, reason: 'event-types-invalid' }
  const ignore = (() => {
    try {
      return z.array(z.string()).safeParse(JSON.parse(row.ignoreUsernames))
    } catch {
      return null
    }
  })()
  if (ignore === null || !ignore.success) return { ok: false, reason: 'ignore-usernames-invalid' }
  const payload = (() => {
    try {
      return webhookPayloadTemplateSchemaFor(row.launchKind).safeParse(
        JSON.parse(row.launchPayload),
      )
    } catch {
      return null
    }
  })()
  if (payload === null || !payload.success) return { ok: false, reason: 'launch-payload-invalid' }
  return {
    ok: true,
    trigger: {
      row,
      rule: {
        repoScope: scope.data,
        eventTypes: eventTypes.data,
        branchFilter: row.branchFilter,
        commandPrefix: row.commandPrefix,
        ignoreUsernames: ignore.data,
      },
      launchKind: row.launchKind,
      launchRefId: row.launchRefId,
      payloadTemplate: payload.data,
    },
  }
}

// ---------------------------------------------------------------------------
// repo 解析（design §5.1；F-17 unseal 等值复核）
// ---------------------------------------------------------------------------

export type RepoResolution =
  | { kind: 'cached'; cachedRepoId: string }
  | { kind: 'url'; repoUrl: string }
  | { kind: 'unregistered' }

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
    const plain = unsealRepoUrl({ url: row.url, urlEnc: row.urlEnc }, secretBox)
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
  return {
    kind: 'url',
    repoUrl: endpoint.preferredCloneProtocol === 'ssh' ? event.repoSshUrl : event.repoHttpUrl,
  }
}

// ---------------------------------------------------------------------------
// 启动参数渲染（design §4.2；渲染后的全量校验 = 各 launch 服务的既有校验，
// 失败走 launch-failed —— 不在此重复实现校验器）
// ---------------------------------------------------------------------------

function fireTaskName(triggerName: string, event: CodeHostEvent): string {
  const anchor = event.mrIid !== undefined ? `${event.repoPath}!${event.mrIid}` : event.repoPath
  return `[${triggerName}] ${anchor}`.slice(0, 255)
}

type RenderedLaunch =
  | { kind: 'workflow'; refId: string; payload: StartTask }
  | { kind: 'agent'; refId: string; payload: StartAgentTask & { agentId: string } }
  | { kind: 'workgroup'; refId: string; payload: StartWorkgroupTask & { workgroupId: string } }

export function renderWebhookLaunch(
  trigger: Pick<ParsedTrigger, 'launchKind' | 'launchRefId' | 'payloadTemplate'>,
  triggerName: string,
  event: CodeHostEvent,
  repo: Exclude<RepoResolution, { kind: 'unregistered' }>,
): RenderedLaunch {
  const vars = eventVarsOf(event)
  const name = fireTaskName(triggerName, event)
  const repoFields =
    repo.kind === 'cached' ? { cachedRepoId: repo.cachedRepoId } : { repoUrl: repo.repoUrl }
  const ref = event.branch
  if (trigger.launchKind === 'workflow') {
    const t = trigger.payloadTemplate as WebhookWorkflowPayloadTemplate
    const inputs: Record<string, string> = {}
    for (const [key, mapping] of Object.entries(t.inputs)) {
      inputs[key] =
        mapping.kind === 'template'
          ? renderTemplate(mapping.template, vars)
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
        ...repoFields,
        ...(ref !== undefined ? { ref } : {}),
        ...(t.workingBranch !== undefined ? { workingBranch: t.workingBranch } : {}),
        ...(t.autoCommitPush !== undefined ? { autoCommitPush: t.autoCommitPush } : {}),
        ...(t.maxDurationMs !== undefined ? { maxDurationMs: t.maxDurationMs } : {}),
        ...(t.maxTotalTokens !== undefined ? { maxTotalTokens: t.maxTotalTokens } : {}),
      } as unknown as StartTask,
    }
  }
  if (trigger.launchKind === 'agent') {
    const t = trigger.payloadTemplate as WebhookAgentPayloadTemplate
    const inputs =
      t.inputs === undefined
        ? undefined
        : Object.fromEntries(Object.entries(t.inputs).map(([k, v]) => [k, renderTemplate(v, vars)]))
    return {
      kind: 'agent',
      refId: trigger.launchRefId,
      payload: {
        agentId: trigger.launchRefId,
        name,
        ...(t.description !== undefined
          ? { description: renderTemplate(t.description, vars) }
          : {}),
        ...(inputs !== undefined ? { inputs } : {}),
        ...(t.allowClarify !== undefined ? { allowClarify: t.allowClarify } : {}),
        ...repoFields,
        ...(ref !== undefined ? { ref } : {}),
        ...(t.workingBranch !== undefined ? { workingBranch: t.workingBranch } : {}),
        ...(t.autoCommitPush !== undefined ? { autoCommitPush: t.autoCommitPush } : {}),
        ...(t.maxDurationMs !== undefined ? { maxDurationMs: t.maxDurationMs } : {}),
        ...(t.maxTotalTokens !== undefined ? { maxTotalTokens: t.maxTotalTokens } : {}),
      } as unknown as StartAgentTask & { agentId: string },
    }
  }
  const t = trigger.payloadTemplate as WebhookWorkgroupPayloadTemplate
  return {
    kind: 'workgroup',
    refId: trigger.launchRefId,
    payload: {
      workgroupId: trigger.launchRefId,
      name,
      goal: renderTemplate(t.goal, vars),
      ...repoFields,
      ...(ref !== undefined ? { ref } : {}),
      ...(t.workingBranch !== undefined ? { workingBranch: t.workingBranch } : {}),
      ...(t.autoCommitPush !== undefined ? { autoCommitPush: t.autoCommitPush } : {}),
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
): Promise<string> {
  const launchDeps = {
    ...buildStartTaskDeps(
      deps.db,
      deps.configPath,
      actor.user.id,
      resolveOpencodeCmd(deps.configPath),
      undefined,
      deps.containmentCoordinator,
    ),
    // 对齐 buildScheduleLaunch：闭包解析在重建的 owner actor 可见性内。
    launchActor: actor,
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
    return task.id
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
    return task.id
  }
  const task = await startExecution(
    deps.db,
    actor,
    { kind: 'workflow', refId: rendered.refId, invoker, payload: rendered.payload },
    launchDeps,
  )
  return task.id
}

async function fireTrigger(
  deps: WebhookDispatchDeps,
  queue: KeyedSerialQueue<string>,
  input: {
    deliveryId: string
    endpoint: WebhookEndpointRow
    event: CodeHostEvent
    trigger: ParsedTrigger
  },
): Promise<void> {
  const { event, trigger } = input
  const streamKey = streamKeyOf(event)
  const fireId = ulid()
  const triggerId = trigger.row.id
  await queue.run(`${triggerId}|${streamKey}`, async () => {
    const now = Date.now()
    const db = deps.db
    const base = { fireId, deliveryId: input.deliveryId, triggerId, streamKey }

    // 匹配后启动前可能被并发禁用：互斥段内复查（outcome: skipped-trigger-disabled）。
    const fresh = (
      await db.select().from(webhookTriggers).where(eq(webhookTriggers.id, triggerId)).limit(1)
    )[0]
    if (!fresh || !fresh.enabled) {
      await recordFire(db, { ...base, outcome: 'skipped-trigger-disabled' })
      return
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
        maxConsecutiveFires: fresh.maxConsecutiveFires,
        ignoreUsernames: trigger.rule.ignoreUsernames,
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

    // repo 解析（D13/D17）。
    const repo = await resolveRepoForEvent(
      db,
      deps.secretBox,
      event,
      input.endpoint,
      fresh.autoRegisterRepos,
    )
    if (repo.kind === 'unregistered') {
      await recordFire(db, { ...base, outcome: 'skipped-repo-unregistered', supersededTaskId })
      return
    }

    // owner 重建 + 目标可用性重校验（每次触发评估，AC-13；照抄 fireSchedule 骨架）。
    const owner = (await db.select().from(users).where(eq(users.id, fresh.ownerUserId)).limit(1))[0]
    if (!owner || owner.status !== 'active') {
      await recordFire(db, {
        ...base,
        outcome: 'skipped-owner-invalid',
        supersededTaskId,
        error: `owner '${fresh.ownerUserId}' missing or inactive`,
      })
      return
    }
    const actor = buildActor({
      user: {
        id: owner.id,
        username: owner.username,
        displayName: owner.displayName,
        role: owner.role,
        status: owner.status,
      },
      source: 'daemon',
    })
    const rendered = renderWebhookLaunch(trigger, fresh.name, event, repo)
    try {
      await assertScheduledTargetUsable(
        db,
        actor,
        rendered.kind,
        rendered.payload as unknown as Record<string, unknown>,
        await deps.getDefaultRuntime(),
      )
    } catch (err) {
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
    const invoker: ExecutionInvoker = {
      type: 'webhook',
      webhookTriggerId: triggerId,
      webhookFireId: fireId,
    }
    try {
      const taskId = await (deps.launch ?? ((a, r, i) => launchViaExecutor(deps, a, r, i)))(
        actor,
        rendered,
        invoker,
      )
      await recordFire(db, { ...base, outcome: 'launched', supersededTaskId, taskId })
      await writeStream(circuit.effectiveCount + 1, true)
      await db
        .update(webhookTriggers)
        .set({
          lastFiredAt: now,
          lastStatus: 'launched',
          lastError: null,
          lastTaskId: taskId,
          consecutiveFailures: 0,
          updatedAt: now,
        })
        .where(eq(webhookTriggers.id, triggerId))
    } catch (err) {
      const msg = errText(err)
      await recordFire(db, {
        ...base,
        outcome: 'launch-failed',
        supersededTaskId,
        error: msg,
      })
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
  })
}

// ---------------------------------------------------------------------------
// dispatcher
// ---------------------------------------------------------------------------

export function createWebhookDispatcher(deps: WebhookDispatchDeps): WebhookDispatcher {
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
        for (const row of rows) {
          const parsed = parseTriggerRow(row)
          if (!parsed.ok) {
            // 行级容错：单条坏触发器不拖垮端点分发（管理面负责让它修好）。
            log.warn('skipping unparsable trigger row', {
              triggerId: row.id,
              reason: parsed.reason,
            })
            continue
          }
          if (matchTrigger(event, parsed.trigger.rule).hit) hits.push(parsed.trigger)
        }
        if (hits.length === 0) {
          await markDelivery(db, deliveryId, 'ignored', 'no-trigger-matched')
          return
        }
        // 命中触发器逐个 fire（同一 delivery 串行；跨 delivery 的并发由
        // per-stream 互斥收敛）。单个 fire 的失败已在 fires 行内终结，不上抛。
        for (const trigger of hits) {
          await fireTrigger(deps, streamQueue, { deliveryId, endpoint, event, trigger })
        }
        await markDelivery(db, deliveryId, 'matched')
      } catch (err) {
        log.error('webhook dispatch failed', { deliveryId, error: errText(err) })
        await markDelivery(db, deliveryId, 'failed', 'internal-error').catch(() => {})
      }
    },
  }
}

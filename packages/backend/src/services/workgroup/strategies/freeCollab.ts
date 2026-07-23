// RFC-217 T3 — free_collab strategy: the task-batch turn (claim → single
// host run → per-card settle) and its result settling (moved verbatim from
// runner.ts).

import {
  parseWgMessagesPort,
  parseWgTaskResultsPort,
  buildBatchShardKey,
  resolveWorkgroupSwitches,
  WG_PORT_MESSAGES,
  WG_PORT_RESULT,
  WG_PORT_TASK_RESULTS,
  WG_PORT_TASKS_ADD,
  type WgTaskResultItem,
  type WorkgroupAssignment,
} from '@agent-workflow/shared'
import { WG_MEMBER_NODE_ID, WG_RERUN_CAUSE } from '@/services/workgroup/constants'
import {
  casAssignmentStatus,
  repointAssignmentRun,
  consumeTasksAdd,
  settleCardAfterFailure,
} from '@/services/workgroup/lifecycle'
import { executeTurn, WG_PROTOCOL_RETRIES } from '@/services/workgroup/turnExecution'
import { type EngineDbState } from '@/services/workgroup/state'
import { roundMode } from '@/services/workgroup/rounds'
import { memberDisplayName, rosterDisplayNames } from '@/services/workgroup/context'
import {
  persistWgMessages,
  postAssignmentMessage,
  postMessage,
} from '@/services/workgroup/messages'
import { composeMemberPrompt } from '@/services/workgroup/prompts'
import type { WorkgroupEngineArgs } from '@/services/workgroup/engine'
import { resolveMemberAgent } from '@/services/workgroup/memberTurns'

/**
 * RFC-215 §3.2 — fc 任务批：一个成员一批卡一个 run。逐卡 CAS 认领（bumpAttempt
 * 计预算）、单 host 行（shardKey 编 memberId+全部卡 id）、`wg_task_results` 逐卡
 * 汇报落库；失败/漏报经 {@link settleCardAfterFailure} 预算内回 open。游标不推
 * （G3——消息轨专职）。`candidateIds` 允许混合来源：open（新配）、dispatched
 * （恢复批/CAS 后崩溃）、running/awaiting_human（领养续跑）。
 */
export async function driveBatchTurn(
  args: WorkgroupEngineArgs,
  state: EngineDbState,
  memberId: string,
  candidateIds: readonly string[],
  adoptedRunId?: string,
): Promise<void> {
  const { db, taskId } = args
  const config = state.config
  const agent = await resolveMemberAgent(args, state, memberId)
  if (agent === null) {
    // 成员配置坏（agent 不可解析）。实现门 C-1（2026-07-21）：open 卡也必须
    // 认领（bumpAttempt）后走失败收尾——旧版把 open 卡原样留池，而
    // deriveWakeSet 不感知 agent 可解析性，下一 pass 对同一成员重派同一批：
    // 不 mint ⇒ budgetUsed 永不增长、items 恒非空 ⇒ 引擎以 DB 往返速度空转，
    // 且每圈追加一条 system 消息（房间消息无限增长）。认领+失败收尾让
    // attempt_count 预算封顶自然收敛：预算内回 open 可被其他成员接手，耗尽
    // failed 终态——与单卡时代 agent-null → failed 的收敛语义一致。
    await postMessage(db, taskId, roundMode(config), {
      authorKind: 'system',
      kind: 'system',
      bodyMd: `batch for @${memberDisplayName(config, memberId)} skipped: agent unresolvable`,
    })
    for (const id of candidateIds) {
      const card = state.assignments.find((a) => a.id === id)
      if (card === undefined) continue
      if (card.status === 'open') {
        const claimed = await casAssignmentStatus(
          db,
          id,
          'open',
          'dispatched',
          { assigneeMemberId: memberId },
          { bumpAttempt: true },
        )
        if (claimed) await settleCardAfterFailure(db, state, id)
        continue
      }
      await settleCardAfterFailure(db, state, id)
    }
    return
  }

  // 1. 认领/纳入：拷贝卡对象为本 run 的批内快照（Task k 序 = 数组序）。
  const batch: WorkgroupAssignment[] = []
  for (const id of candidateIds) {
    const card = state.assignments.find((a) => a.id === id)
    if (card === undefined) continue
    if (card.status === 'open') {
      const claimed = await casAssignmentStatus(
        db,
        id,
        'open',
        'dispatched',
        { assigneeMemberId: memberId },
        { bumpAttempt: true },
      )
      // Lost race (another engine pass / manual op) just skips this card.
      if (claimed) batch.push({ ...card, status: 'dispatched', assigneeMemberId: memberId })
      continue
    }
    if (card.assigneeMemberId !== memberId) continue // stale candidate — not ours
    if (card.status === 'dispatched' || card.status === 'running') {
      batch.push({ ...card })
      continue
    }
    if (card.status === 'awaiting_human' && adoptedRunId !== undefined) {
      // clarify-answer 续跑：泊卡回 running（同单卡领养语义）。
      const moved = await casAssignmentStatus(db, id, 'awaiting_human', 'running', {
        nodeRunId: adoptedRunId,
      })
      if (moved) batch.push({ ...card, status: 'running', assigneeMemberId: memberId })
    }
  }
  if (batch.length === 0) return // 全部被抢/失效：不 mint、不烧预算（design §8）

  const shardKey = buildBatchShardKey(
    memberId,
    batch.map((b) => b.id),
  )
  const adoptedRow =
    adoptedRunId !== undefined ? state.hostRuns.find((r) => r.id === adoptedRunId) : undefined

  const roster = rosterDisplayNames(config)
  interface BatchTurnValue {
    reported: ReturnType<typeof parseWgTaskResultsPort> extends { ok: true; value: infer V }
      ? V
      : never
    outMessages: ReturnType<typeof parseWgMessagesPort>
    tasksAddRaw: string | undefined
  }
  // 耗尽时的部分落卡（design §3.2）：parse 闭包每轮捕获「已合法汇报」的子集，
  // protocol-exhausted 收尾据此照落合法项、只失败未汇报项。
  let lastReported: {
    task: number
    status: 'done' | 'failed'
    summary: string
    detail?: string
  }[] = []
  let lastMissing: number[] = batch.map((_, i) => i + 1)
  const outcome = await executeTurn<BatchTurnValue>(
    {
      db,
      taskId,
      hooks: args.hooks,
      ...(args.registerMint !== undefined ? { registerMint: args.registerMint } : {}),
      ...(adoptedRunId !== undefined ? { adoptedRunId } : {}),
      retryBase: adoptedRow?.retryIndex ?? 0,
    },
    {
      nodeId: WG_MEMBER_NODE_ID,
      agent,
      role: 'fc_member',
      config,
      clarifyShardKey: shardKey,
      maxAttempts: WG_PROTOCOL_RETRIES + 1,
      clarifyForbiddenNotice:
        '- Ask-back is OFF in this autonomous group. Do NOT emit <workflow-clarify>.\n' +
        '  Proceed with your best judgment and emit wg_task_results as usual.',
      protocolOpts: { count: batch.length },
      mintRow: (attempt, retryBase) => ({
        cause: attempt > 0 ? WG_RERUN_CAUSE.protocolRetry : WG_RERUN_CAUSE.assignment,
        retryIndex: retryBase + attempt,
        overrides: {
          shardKey,
          agentOverrideName: agent.name,
          agentOverrideId: agent.id,
          wgRound: null, // fc member rows stay NULL (RFC-189 count-based budget)
        },
      }),
      // 2. 逐卡 running + nodeRunId 刷新（协议重试轮把卡指向最新行，同单卡语义）。
      onAttemptStart: async (runId) => {
        for (const card of batch) {
          if (card.status === 'dispatched') {
            await casAssignmentStatus(db, card.id, 'dispatched', 'running', { nodeRunId: runId })
            card.status = 'running'
            card.nodeRunId = runId
          } else if (card.nodeRunId !== runId) {
            await repointAssignmentRun(db, card.id, runId)
            card.nodeRunId = runId
          }
        }
      },
      composePrompt: (envelopeNonce) => composeMemberPrompt(state, memberId, batch, envelopeNonce),
      parse: (outputs) => {
        const resultsRaw = outputs[WG_PORT_TASK_RESULTS]
        const parsed =
          resultsRaw !== undefined
            ? parseWgTaskResultsPort(resultsRaw, batch.length)
            : ({
                ok: false,
                errors: [
                  `missing required port ${WG_PORT_TASK_RESULTS} (this batch run does NOT use ${WG_PORT_RESULT})`,
                ],
              } as const)
        const messagesRaw = outputs[WG_PORT_MESSAGES]
        const outMessages =
          messagesRaw !== undefined
            ? parseWgMessagesPort(messagesRaw, roster)
            : { ok: true as const, value: [] }
        lastReported = parsed.ok ? [...parsed.value] : []
        lastMissing = parsed.ok ? [...parsed.missing] : batch.map((_, i) => i + 1)
        const errors: string[] = []
        if (!parsed.ok) errors.push(...parsed.errors.map((e) => `${WG_PORT_TASK_RESULTS}: ${e}`))
        else if (parsed.missing.length > 0) {
          errors.push(
            `${WG_PORT_TASK_RESULTS}: missing entries for ${parsed.missing
              .map((k) => `Task ${k}`)
              .join(', ')} — EVERY task in the batch must be reported exactly once`,
          )
        }
        if (!outMessages.ok) errors.push(...outMessages.errors.map((e) => `wg_messages: ${e}`))
        if (errors.length > 0) return { ok: false, errors }
        return {
          ok: true,
          value: {
            reported: (parsed.ok ? parsed.value : []) as BatchTurnValue['reported'],
            outMessages,
            tasksAddRaw: outputs[WG_PORT_TASKS_ADD],
          },
        }
      },
    },
  )

  if (outcome.kind === 'canceled') {
    for (const card of batch) {
      await casAssignmentStatus(db, card.id, 'running', 'canceled').catch(() => false)
    }
    return
  }
  if (outcome.kind === 'awaiting') {
    // 整批同泊（design §3.2）：clarify shard 即批 shardKey，答案续跑经领养重建整批。
    for (const card of batch) {
      await casAssignmentStatus(db, card.id, 'running', 'awaiting_human').catch(() => false)
    }
    return
  }
  if (outcome.kind === 'clarify-forbidden-exhausted' || outcome.kind === 'failed') {
    await postMessage(db, taskId, roundMode(config), {
      authorKind: 'system',
      kind: 'system',
      bodyMd: `batch of ${batch.length} task(s) for @${memberDisplayName(config, memberId)} failed: ${outcome.errorMessage}`,
    })
    for (const card of batch) {
      await settleCardAfterFailure(db, state, card.id)
    }
    return
  }
  if (outcome.kind === 'protocol-exhausted') {
    // 耗尽：已合法汇报的卡照落（design §3.2），未汇报/不可解析的走失败收尾。
    await settleBatchResults(args, state, batch, lastReported)
    await postMessage(db, taskId, roundMode(config), {
      authorKind: 'system',
      kind: 'system',
      bodyMd: `batch for @${memberDisplayName(config, memberId)}: protocol violation after retries (${outcome.errors.join('; ')})`,
    })
    for (const k of lastMissing) {
      const card = batch[k - 1]
      if (card !== undefined) await settleCardAfterFailure(db, state, card.id)
    }
    return
  }

  // 全绿：先旁路端口（消息/新卡），再逐卡落结果。
  const { reported, outMessages, tasksAddRaw } = outcome.value
  const switches = resolveWorkgroupSwitches(config.mode, config.switches)
  if (outMessages.ok && outMessages.value.length > 0) {
    await persistWgMessages(db, taskId, config, batch[0]?.round ?? 0, memberId, outMessages.value, {
      allowDirect: switches.directMessages,
      allowBlackboard: switches.blackboard,
    })
  }
  await consumeTasksAdd(db, taskId, state, memberId, tasksAddRaw)
  await settleBatchResults(args, state, batch, reported)
  // G3：不推游标——@ 消息由消息轨消费。
}

/**
 * RFC-215 §3.2-6 — 批结果逐卡落库（全绿与耗尽两条路径共用）：`done` 卡落 result
 * 消息 + CAS done；`failed` 卡落系统消息 + 失败收尾（预算内回 open）。
 */
export async function settleBatchResults(
  args: WorkgroupEngineArgs,
  state: EngineDbState,
  batch: readonly WorkgroupAssignment[],
  reported: readonly WgTaskResultItem[],
): Promise<void> {
  const { db, taskId } = args
  const config = state.config
  for (const item of reported) {
    const card = batch[item.task - 1]
    if (card === undefined) continue
    if (item.status === 'done') {
      const resultMessageId = await postAssignmentMessage(db, taskId, roundMode(config), card, {
        authorKind: 'member',
        authorMemberId: card.assigneeMemberId,
        kind: 'result',
        bodyMd: item.summary,
      })
      await casAssignmentStatus(db, card.id, 'running', 'done', { resultMessageId }).catch(
        () => false,
      )
    } else {
      await postAssignmentMessage(db, taskId, roundMode(config), card, {
        authorKind: 'system',
        kind: 'system',
        bodyMd: `assignment '${card.title}' reported failed by @${memberDisplayName(config, card.assigneeMemberId ?? '')}: ${item.summary}`,
      })
      await settleCardAfterFailure(db, state, card.id)
    }
  }
}

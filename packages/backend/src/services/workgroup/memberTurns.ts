// RFC-217 T3 — member-side turn drivers shared by BOTH round modes (moved
// verbatim from runner.ts): the single-card assignment turn (lw + fc adopt
// paths) and the single-shot message turn, plus the roster→Agent resolver.

import { getAgentById } from '@/services/agent'
import {
  buildMsgShardKey,
  parseWgMessagesPort,
  parseWgResultPort,
  resolveWorkgroupSwitches,
  WG_PORT_MESSAGES,
  WG_PORT_RESULT,
  WG_PORT_TASKS_ADD,
  type Agent,
  type WorkgroupAssignment,
} from '@agent-workflow/shared'
import { WG_MEMBER_NODE_ID, WG_RERUN_CAUSE } from '@/services/workgroup/constants'
import {
  casAssignmentStatus,
  repointAssignmentRun,
  advanceMemberCursor,
  consumeTasksAdd,
  settleCardAfterFailure,
} from '@/services/workgroup/lifecycle'
import { executeTurn, WG_PROTOCOL_RETRIES } from '@/services/workgroup/turnExecution'
import { type EngineDbState } from '@/services/workgroup/state'
import {
  currentRound,
  roundMode,
  stampWgRound,
  resolveMessageRound,
} from '@/services/workgroup/rounds'
import {
  maxMessageId,
  memberById,
  memberDisplayName,
  rosterDisplayNames,
  type WorkgroupProtocolRole,
} from '@/services/workgroup/context'
import {
  persistWgMessages,
  postAssignmentMessage,
  postMessage,
} from '@/services/workgroup/messages'
import { composeMemberPrompt } from '@/services/workgroup/prompts'
import type { WorkgroupEngineArgs } from '@/services/workgroup/engine'

export async function resolveMemberAgent(
  args: WorkgroupEngineArgs,
  state: EngineDbState,
  memberId: string,
): Promise<Agent | null> {
  const member = memberById(state.config, memberId)
  if (member === null || member.memberType !== 'agent') return null
  // RFC-223 (PR-3a): resolve the member's agent by the CANONICAL agentId frozen
  // at launch (rename/ABA-safe), NOT the mutable display name. Crucially the
  // R4-1 quarantine sentinel is a PRESENT id that resolves to NO agent — so a
  // migrated legacy config fails closed HERE (getAgentById → null), never
  // re-binding whatever agent currently holds the stale name (possibly a
  // different tenant's).
  if (typeof member.agentId === 'string' && member.agentId.length > 0) {
    return getAgentById(args.db, member.agentId)
  }
  // Name-only snapshots are corrupt legacy data. Fail closed instead of
  // re-binding a mutable display selector to a different persisted identity.
  return null
}

export async function driveAssignmentTurn(
  args: WorkgroupEngineArgs,
  state: EngineDbState,
  assignment: WorkgroupAssignment,
  adoptedRunId?: string,
): Promise<void> {
  const { db, taskId } = args
  const config = state.config
  const memberId = assignment.assigneeMemberId
  if (memberId === null) return
  const agent = await resolveMemberAgent(args, state, memberId)
  if (agent === null) {
    await casAssignmentStatus(db, assignment.id, assignment.status, 'failed').catch(() => false)
    await postAssignmentMessage(db, taskId, roundMode(config), assignment, {
      authorKind: 'system',
      kind: 'system',
      bodyMd: `assignment '${assignment.title}' failed: agent for @${memberDisplayName(config, memberId)} unresolvable`,
    })
    return
  }

  // RFC-189 — a member run belongs to the round that DISPATCHED its assignment
  // (lw display grouping; never budget). fc rows stay NULL — the fc round
  // budget is a row COUNT by design (design.md §1 修订), not an ordinal.
  const memberWgRound = config.mode === 'leader_worker' ? assignment.round : null
  const adoptedMemberRow =
    adoptedRunId !== undefined ? state.hostRuns.find((r) => r.id === adoptedRunId) : undefined
  if (
    adoptedMemberRow !== undefined &&
    adoptedMemberRow.wgRound === null &&
    memberWgRound !== null
  ) {
    await stampWgRound(db, adoptedMemberRow.id, memberWgRound)
  }

  const role: WorkgroupProtocolRole = config.mode === 'free_collab' ? 'fc_member' : 'worker'
  const roster = rosterDisplayNames(config)
  interface AssignmentTurnValue {
    summary: string
    outMessages: ReturnType<typeof parseWgMessagesPort>
    tasksAddRaw: string | undefined
  }
  let card = assignment
  const outcome = await executeTurn<AssignmentTurnValue>(
    {
      db,
      taskId,
      hooks: args.hooks,
      ...(args.registerMint !== undefined ? { registerMint: args.registerMint } : {}),
      ...(adoptedRunId !== undefined ? { adoptedRunId } : {}),
      // Codex 实现门 P2-1（member 侧同形）— adopted 续跑的重试从其存量 index
      // 续排，防 (node, shard, retry_index) 重复铸行。
      retryBase: adoptedMemberRow?.retryIndex ?? 0,
    },
    {
      nodeId: WG_MEMBER_NODE_ID,
      agent,
      role,
      config,
      clarifyShardKey: assignment.id,
      maxAttempts: WG_PROTOCOL_RETRIES + 1,
      clarifyForbiddenNotice:
        '- Ask-back is OFF in this autonomous group. Do NOT emit <workflow-clarify>.\n' +
        '  Proceed with your best judgment and emit wg_result as usual.',
      // RFC-187 §3-3 / RFC-189 — retry rows are budget-excluded; retryIndex is
      // the plain attempt ordinal (round lives in wg_round).
      mintRow: (attempt, retryBase) => ({
        cause: attempt > 0 ? WG_RERUN_CAUSE.protocolRetry : WG_RERUN_CAUSE.assignment,
        retryIndex: retryBase + attempt,
        overrides: {
          shardKey: assignment.id,
          agentOverrideName: agent.name,
          agentOverrideId: agent.id,
          wgRound: memberWgRound,
        },
      }),
      onAttemptStart: async (runId) => {
        if (card.status === 'dispatched') {
          await casAssignmentStatus(db, card.id, 'dispatched', 'running', { nodeRunId: runId })
          card = { ...card, status: 'running', nodeRunId: runId }
        } else if (card.nodeRunId !== runId) {
          await repointAssignmentRun(db, card.id, runId)
          card = { ...card, nodeRunId: runId }
        }
      },
      composePrompt: (envelopeNonce) =>
        composeMemberPrompt(state, memberId, [card], envelopeNonce, { singleCard: true }),
      parse: (outputs) => {
        const resultRaw = outputs[WG_PORT_RESULT]
        const parsedResult = resultRaw !== undefined ? parseWgResultPort(resultRaw) : null
        const errors: string[] = []
        if (parsedResult === null) errors.push('missing required port wg_result')
        else if (!parsedResult.ok) errors.push(...parsedResult.errors.map((e) => `wg_result: ${e}`))
        const messagesRaw = outputs[WG_PORT_MESSAGES]
        const outMessages =
          messagesRaw !== undefined
            ? parseWgMessagesPort(messagesRaw, roster)
            : { ok: true as const, value: [] }
        if (!outMessages.ok) errors.push(...outMessages.errors.map((e) => `wg_messages: ${e}`))
        if (errors.length > 0) return { ok: false, errors }
        return {
          ok: true,
          value: {
            summary: parsedResult !== null && parsedResult.ok ? parsedResult.value.summary : '',
            outMessages,
            tasksAddRaw: outputs[WG_PORT_TASKS_ADD],
          },
        }
      },
    },
  )

  if (outcome.kind === 'canceled') {
    await casAssignmentStatus(db, assignment.id, 'running', 'canceled').catch(() => false)
    return
  }
  if (outcome.kind === 'awaiting') {
    await casAssignmentStatus(db, assignment.id, 'running', 'awaiting_human')
    return
  }
  if (outcome.kind === 'clarify-forbidden-exhausted' || outcome.kind === 'failed') {
    // RFC-215 §3.5 — 失败收尾走共享子例程：fc 预算判据用 attempt_count 列
    // （协议重试不误耗预算——只在 open→dispatched 认领时自增）。suppressed
    // ask-back 耗尽与普通失败同路：卡面浮出 failed，绝不 park（RFC-181 C）。
    await settleCardAfterFailure(db, state, assignment.id)
    await postAssignmentMessage(db, taskId, roundMode(config), assignment, {
      authorKind: 'system',
      kind: 'system',
      bodyMd: `assignment '${assignment.title}' failed: ${outcome.errorMessage}`,
    })
    return
  }
  if (outcome.kind === 'protocol-exhausted') {
    await casAssignmentStatus(db, assignment.id, 'running', 'failed')
    await postAssignmentMessage(db, taskId, roundMode(config), assignment, {
      authorKind: 'system',
      kind: 'system',
      bodyMd: `assignment '${assignment.title}' failed: protocol violation (${outcome.errors.join('; ')})`,
    })
    return
  }

  const { summary, outMessages, tasksAddRaw } = outcome.value
  const switches = resolveWorkgroupSwitches(config.mode, config.switches)
  if (outMessages.ok && outMessages.value.length > 0) {
    await persistWgMessages(db, taskId, config, assignment.round, memberId, outMessages.value, {
      allowDirect: switches.directMessages,
      allowBlackboard: switches.blackboard,
    })
  }
  await consumeTasksAdd(db, taskId, state, memberId, tasksAddRaw)
  const resultMessageId = await postAssignmentMessage(db, taskId, roundMode(config), assignment, {
    authorKind: 'member',
    authorMemberId: memberId,
    kind: 'result',
    bodyMd: summary,
  })
  await casAssignmentStatus(db, assignment.id, 'running', 'done', { resultMessageId })
  // RFC-186 T5 (audit §5 F6): advance the worker cursor AFTER the effects
  // persist. RFC-215 §4 (G3) — lw ONLY: fc 任务 run 不消费消息、不推游标。
  if (config.mode === 'leader_worker') {
    await advanceMemberCursor(db, taskId, memberId, maxMessageId(state.messages))
  }
}

export async function driveMessageTurn(
  args: WorkgroupEngineArgs,
  state: EngineDbState,
  memberId: string,
  isFcInitial: boolean,
  adoptedRunId?: string,
): Promise<void> {
  const { db, taskId } = args
  const config = state.config
  const agent = await resolveMemberAgent(args, state, memberId)
  if (agent === null) return

  if (adoptedRunId !== undefined && config.mode === 'leader_worker') {
    // Codex 实现门 P2-4 — an ADOPTED msg continuation (clarify-answer rerun on
    // a msg:* shard, minted outside without a stamp) gets its round in place;
    // display-only in lw (message turns never advance the ledger), idempotent
    // via the IS NULL guard.
    await stampWgRound(db, adoptedRunId, currentRound(state))
  }

  const fcAddendum = isFcInitial
    ? [
        '## Initial planning turn',
        '',
        'The shared task list is empty. Break the group goal into concrete',
        'tasks (wg_tasks_add) — check the blackboard first to avoid duplicating',
        'what teammates already proposed. You may also record findings via',
        'wg_result.',
      ].join('\n')
    : null
  const role = config.mode === 'free_collab' ? ('fc_member' as const) : ('worker' as const)
  const roster = rosterDisplayNames(config)
  interface MessageTurnValue {
    outMessages: ReturnType<typeof parseWgMessagesPort>
    resultRaw: string | undefined
    tasksAddRaw: string | undefined
  }
  // 单发（RFC-186 §2.2 deferred retry）——maxAttempts=1：协议/端口问题不重试、
  // 容错跳过（parse 恒 ok），与旧实现逐字同语义；骨架只贡献 mint/领养/nonce/
  // clarify resolve-once/结果分派的公共面（设计门 P2：重试预算是 spec 入参）。
  const outcome = await executeTurn<MessageTurnValue>(
    {
      db,
      taskId,
      hooks: args.hooks,
      ...(args.registerMint !== undefined ? { registerMint: args.registerMint } : {}),
      ...(adoptedRunId !== undefined ? { adoptedRunId } : {}),
    },
    {
      nodeId: WG_MEMBER_NODE_ID,
      agent,
      role,
      config,
      // The shard key embeds the member; only that part identifies the asker
      // (RFC-207 §3.6.3) — the message id is irrelevant to the clarify gate.
      clarifyShardKey: buildMsgShardKey(memberId, '0'),
      maxAttempts: 1,
      clarifyForbiddenNotice: '', // unreachable at maxAttempts=1 — exhaustion path only
      mintRow: () => ({
        cause: WG_RERUN_CAUSE.messageTurn,
        // RFC-189 — single-shot turn ⇒ plain attempt 0; the lw round it belongs
        // to rides wg_round (fc: NULL — count-based budget, where each message
        // turn IS one budget row and needs no ordinal).
        retryIndex: 0,
        overrides: {
          shardKey: buildMsgShardKey(memberId, maxMessageId(state.messages)),
          agentOverrideName: agent.name,
          agentOverrideId: agent.id,
          wgRound: config.mode === 'leader_worker' ? currentRound(state) : null,
        },
      }),
      composePrompt: (envelopeNonce) =>
        composeMemberPrompt(state, memberId, null, envelopeNonce) +
        (fcAddendum !== null ? `\n\n${fcAddendum}` : ''),
      parse: (outputs) => {
        const messagesRaw = outputs[WG_PORT_MESSAGES]
        const outMessages =
          messagesRaw !== undefined
            ? parseWgMessagesPort(messagesRaw, roster)
            : { ok: true as const, value: [] }
        return {
          ok: true,
          value: {
            outMessages,
            resultRaw: outputs[WG_PORT_RESULT],
            tasksAddRaw: outputs[WG_PORT_TASKS_ADD],
          },
        }
      },
    },
  )

  // RFC-186 T5 (audit §5 F6): advance the member cursor AFTER the hook RETURNS
  // (any outcome — each consumes the @-mention so it can't re-loop), but never
  // BEFORE the hook. A mid-turn daemon crash (hook never returns) leaves it
  // un-advanced so the resumed engine re-derives the turn instead of skipping.
  await advanceMemberCursor(db, taskId, memberId, maxMessageId(state.messages))
  // RFC-186 §2.2 (audit §2 P1-7) — surface a failed message turn as a system
  // note so the black hole is visible (the member otherwise appears to ignore
  // the message).
  if (outcome.kind === 'failed' || outcome.kind === 'clarify-forbidden-exhausted') {
    await postMessage(db, taskId, roundMode(config), {
      authorKind: 'system',
      kind: 'system',
      bodyMd: `message turn for ${memberDisplayName(config, memberId)} failed: ${outcome.errorMessage}`,
    })
    return
  }
  if (outcome.kind !== 'done') return // canceled / awaiting — parks or ends upstream

  const { outMessages, resultRaw, tasksAddRaw } = outcome.value
  const switches = resolveWorkgroupSwitches(config.mode, config.switches)
  // RFC-209 —— 解析一次，本轮产出的所有消息共用（此前读的是**过期快照**：这个 turn 可能是
  // 好几个引擎 pass 之前启动的，它的 `state` 早就不是当前值了，fc 首轮因此永远写 round 0）。
  const turnRound = await resolveMessageRound(db, taskId, roundMode(config))
  if (outMessages.ok && outMessages.value.length > 0) {
    await persistWgMessages(db, taskId, config, turnRound, memberId, outMessages.value, {
      allowDirect: switches.directMessages,
      allowBlackboard: switches.blackboard,
    })
  }
  if (resultRaw !== undefined) {
    const parsed = parseWgResultPort(resultRaw)
    if (parsed.ok) {
      await postMessage(db, taskId, roundMode(config), {
        round: turnRound,
        authorKind: 'member',
        authorMemberId: memberId,
        kind: 'chat',
        bodyMd: parsed.value.summary,
      })
    }
  }
  await consumeTasksAdd(db, taskId, state, memberId, tasksAddRaw)
}

// RFC-217 T3 — turn prompt composition (moved verbatim from runner.ts).
// Thin shells over the block renderers in context.ts; EngineDbState in,
// prompt text out — no IO, table-testable.

import {
  fenceUntrusted,
  sanitizeInlineField,
  type WorkgroupAssignment,
} from '@agent-workflow/shared'
import type { EngineDbState } from '@/services/workgroup/state'
import {
  renderCharterBlock,
  renderGoalBlock,
  renderLeaderLedger,
  renderMessagesBlock,
  renderRosterBlock,
  selectMemberSlices,
} from '@/services/workgroup/context'

export function composeLeaderPrompt(state: EngineDbState, envelopeNonce = ''): string {
  const { config } = state
  const ledger = state.assignments.map((a) => {
    const resultMsg =
      a.resultMessageId !== null ? state.messages.find((m) => m.id === a.resultMessageId) : null
    return { assignment: a, resultSummary: resultMsg?.bodyMd ?? null }
  })
  const cursor = state.cursors.get(config.leaderMemberId ?? '') ?? ''
  const fresh = state.messages.filter((m) => m.id > cursor)
  const blocks = [
    renderCharterBlock(config, envelopeNonce),
    // RFC-176: the leader owns goal decomposition — carry it every turn.
    renderGoalBlock(config, envelopeNonce),
    renderRosterBlock(
      config,
      {
        excludeMemberId: config.leaderMemberId ?? undefined,
        agentCards: state.agentCards,
      },
      envelopeNonce,
    ),
    renderLeaderLedger(config, ledger, envelopeNonce),
    renderMessagesBlock(config, 'New activity since your last turn', fresh, envelopeNonce),
  ]
  if (state.gate.rejected) {
    const rejection = state.gate.rejectedComment
      ? `A human rejected your completion declaration:\n${fenceUntrusted(
          'completion-gate-feedback',
          state.gate.rejectedComment,
          envelopeNonce,
        )}`
      : 'A human rejected your completion declaration.'
    blocks.push(
      [
        '## Completion gate REJECTED',
        '',
        rejection,
        'Address the feedback and continue coordinating.',
      ].join('\n'),
    )
  }
  return blocks.filter((b) => b.length > 0).join('\n\n')
}

export function composeMemberPrompt(
  state: EngineDbState,
  memberId: string,
  assignments: readonly WorkgroupAssignment[] | null,
  envelopeNonce = '',
  opts: { singleCard?: boolean } = {},
): string {
  const { config } = state
  // RFC-215 §4 — fc 任务 run：@ 消息由消息轨专职消费（不注入、不推游标），
  // peerResults/blackboard 改尾窗模式（cursor 无关，char budget 兜底有界）。
  // lw 单卡与消息回合保持原 cursor 语义。
  const fcTaskRun = config.mode === 'free_collab' && assignments !== null
  const slices = selectMemberSlices(
    config,
    memberId,
    {
      assignments: state.assignments,
      messages: state.messages,
      cursorMessageId: fcTaskRun ? '' : (state.cursors.get(memberId) ?? ''),
    },
    { omitMentions: fcTaskRun },
  )
  const blocks = [renderCharterBlock(config, envelopeNonce)]
  // RFC-176: free_collab has no leader to decompose the goal — every member
  // owns it, so all members see it. A leader_worker worker never does: it acts
  // on the leader's assignment brief ('## Your assignment') below.
  if (config.mode === 'free_collab') blocks.push(renderGoalBlock(config, envelopeNonce))
  blocks.push(
    renderRosterBlock(
      config,
      { excludeMemberId: memberId, agentCards: state.agentCards },
      envelopeNonce,
    ),
  )
  if (assignments !== null && (config.mode === 'leader_worker' || opts.singleCard === true)) {
    // lw：恒单卡，块与 RFC-215 之前逐字一致（AC-8 零 diff）。
    // fc + singleCard（实现门 C-2，2026-07-21）：driveAssignmentTurn 领养的
    // pre-215 单卡行，其协议块/hostOutputPorts/解析侧全是 wg_result 单卡形态
    // （不带 batch count）——prompt 必须同形。旧版恒走下面的批形态，同一
    // prompt 里「Report EACH in wg_task_results」与协议块「emit wg_result」
    // 互斥指令并存，模型按任务块发 wg_task_results 即烧协议重试，最坏烧穿
    // 预算 failed。仅升级窗口的领养路径可达；正规 fc 批走 driveBatchTurn。
    const assignment = assignments[0] as WorkgroupAssignment
    const title =
      envelopeNonce.length > 0 ? sanitizeInlineField(assignment.title) : assignment.title
    blocks.push(
      [
        '## Your assignment',
        '',
        `Title: ${title}`,
        '',
        fenceUntrusted('assignment-brief', assignment.briefMd, envelopeNonce),
      ].join('\n'),
    )
  } else if (assignments !== null) {
    // fc 批（含 N=1，RFC-215 §4）：Task k 锚点与 wg_task_results 的序号恒同在。
    const lines = [`## Your assignments (batch of ${assignments.length})`]
    for (const [i, a] of assignments.entries()) {
      const title = envelopeNonce.length > 0 ? sanitizeInlineField(a.title) : a.title
      lines.push(
        '',
        `### Task ${i + 1}: ${title}`,
        '',
        fenceUntrusted('assignment-brief', a.briefMd, envelopeNonce),
      )
    }
    lines.push(
      '',
      'Work through every task above. Report EACH one in wg_task_results by its',
      'Task number. You may also post wg_messages / add wg_tasks_add as usual.',
    )
    blocks.push(lines.join('\n'))
  } else {
    blocks.push(
      [
        '## Message turn',
        '',
        'You were woken because teammates (or a human) messaged you — respond or',
        'record what matters. Do NOT claim or start task work in this turn.',
      ].join('\n'),
    )
  }
  if (slices.peerResults.length > 0) {
    blocks.push(renderMessagesBlock(config, 'Teammate results', slices.peerResults, envelopeNonce))
  }
  if (slices.mentions.length > 0) {
    blocks.push(
      renderMessagesBlock(config, 'Messages addressed to you', slices.mentions, envelopeNonce),
    )
  }
  if (slices.blackboard.length > 0) {
    blocks.push(
      renderMessagesBlock(config, 'Group blackboard (recent)', slices.blackboard, envelopeNonce),
    )
  }
  return blocks.filter((b) => b.length > 0).join('\n\n')
}

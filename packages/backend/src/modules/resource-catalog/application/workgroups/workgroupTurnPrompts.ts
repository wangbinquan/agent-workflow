// RFC-359 W4-D19c —— 工作组回合的提示词组装：一份实现，两个引擎。
//
// 合一之前这段只在 legacy engine 里（`legacy/workgroup/prompts.ts`），中立驱动自带一份**更简单**的
// `composePrompt`——也就是说 PostgreSQL 上的 agent 收到的提示词一直是降级版：没有 charter 围栏、
// 没有 goal 块、没有能力卡名册、没有领队账本、没有 peer results / mentions / 黑板三段切片、
// 也没有完成闸门被打回的反馈块。正典取合一前 SQLite 这一份（13 个行为套件盯着它），逐字搬过来，
// 输入从 legacy 的 `EngineDbState` 换成中立的 `WorkgroupTurnsSnapshot`——两者字段一一对应
// （`gate.rejected*` ↔ `snapshot.gateStatus`/`gateRejectedComment`、`agentCards` ↔ `memberAgents[].capabilityCard`）。

import {
  fenceUntrusted,
  followupPolicyForFailure,
  sanitizeInlineField,
  type EnvelopeFollowupReason,
  type FailureCode,
  type WorkgroupAssignment,
} from '@agent-workflow/shared'
import {
  renderCharterBlock,
  renderGoalBlock,
  renderLeaderLedger,
  renderMessagesBlock,
  renderRosterBlock,
  selectMemberSlices,
} from './workgroupTurnContext'
import type { WorkgroupTurnsSnapshot } from './workgroupTurnsDriver'

/** 能力卡按成员取（legacy 的 `agentCards` 是 Map，中立快照里是 memberAgents 的一列）。 */
function agentCardsOf(snapshot: WorkgroupTurnsSnapshot): Map<string, string> {
  return new Map(
    snapshot.memberAgents.flatMap((entry) =>
      entry.capabilityCard.length > 0 ? [[entry.memberId, entry.capabilityCard] as const] : [],
    ),
  )
}

export function composeLeaderPrompt(snapshot: WorkgroupTurnsSnapshot, envelopeNonce = ''): string {
  const { config } = snapshot
  const ledger = snapshot.assignments.map((a) => {
    const resultMsg =
      a.resultMessageId !== null ? snapshot.messages.find((m) => m.id === a.resultMessageId) : null
    return { assignment: a, resultSummary: resultMsg?.bodyMd ?? null }
  })
  const cursor = snapshot.cursors.get(config.leaderMemberId ?? '') ?? ''
  const fresh = snapshot.messages.filter((m) => m.id > cursor)
  const blocks = [
    renderCharterBlock(config, envelopeNonce),
    // RFC-176: the leader owns goal decomposition — carry it every turn.
    renderGoalBlock(config, envelopeNonce),
    renderRosterBlock(
      config,
      {
        excludeMemberId: config.leaderMemberId ?? undefined,
        agentCards: agentCardsOf(snapshot),
      },
      envelopeNonce,
    ),
    renderLeaderLedger(config, ledger, envelopeNonce),
    renderMessagesBlock(config, 'New activity since your last turn', fresh, envelopeNonce),
  ]
  if (snapshot.state.gateStatus === 'rejected') {
    const rejection = snapshot.state.gateRejectedComment
      ? `A human rejected your completion declaration:\n${fenceUntrusted(
          'completion-gate-feedback',
          snapshot.state.gateRejectedComment,
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
  snapshot: WorkgroupTurnsSnapshot,
  memberId: string,
  assignments: readonly WorkgroupAssignment[] | null,
  envelopeNonce = '',
  opts: { singleCard?: boolean } = {},
): string {
  const { config } = snapshot
  // RFC-215 §4 — fc 任务 run：@ 消息由消息轨专职消费（不注入、不推游标），
  // peerResults/blackboard 改尾窗模式（cursor 无关，char budget 兜底有界）。
  // lw 单卡与消息回合保持原 cursor 语义。
  const fcTaskRun = config.mode === 'free_collab' && assignments !== null
  const slices = selectMemberSlices(
    config,
    memberId,
    {
      assignments: snapshot.assignments,
      messages: snapshot.messages,
      cursorMessageId: fcTaskRun ? '' : (snapshot.cursors.get(memberId) ?? ''),
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
      { excludeMemberId: memberId, agentCards: agentCardsOf(snapshot) },
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

/**
 * RFC-186 §2.2 — unify the workgroup turn's retry-vs-fatal decision on the SAME
 * `FOLLOWUP_POLICY` table normal nodes use (`decideEnvelopeFollowup`), replacing
 * the order-sensitive `errorMessage.startsWith(...)` chain + the per-code
 * `failureCode === 'envelope-missing'` special-case (audit §2 P1-5). A failure
 * with a structured `FailureCode` in the table is retryable; an unstructured
 * failure (`failureCode` undefined — iso-setup / injection / subprocess crash /
 * merge-back conflict) is genuinely fatal. `clarify-forbidden` is handled by its
 * OWN branch BEFORE this (workgroup autonomous soft-reject semantics, RFC-181/183)
 * — never routed here as a normal envelope-missing retry.
 */
export function followupForFailure(
  failureCode: FailureCode | undefined,
): { retry: true; reason: EnvelopeFollowupReason } | { retry: false } {
  const policy = followupPolicyForFailure(failureCode)
  return policy ? { retry: true, reason: policy.reason } : { retry: false }
}

/**
 * RFC-186 §2.3 — reason-tailored re-prompt for a workgroup turn. Unlike the
 * normal node, we do NOT reuse `renderEnvelopeFollowupPrompt` verbatim: that
 * renderer REPLACES the whole prompt, which would drop the `workgroupProtocolBlock`
 * (where the wg_* port contract lives) on the fresh retry subprocess. Instead we
 * return a concise `errorNotice` appended to the FULL turn prompt (which still
 * carries the wg protocol block via runHostNode), reason-mapped from the same
 * 6-value `EnvelopeFollowupReason` domain.
 */
export function wgFollowupNotice(reason: EnvelopeFollowupReason): string {
  switch (reason) {
    case 'envelope-missing':
      return (
        '- Your previous reply had NO <workflow-output> envelope. Re-read the\n' +
        '  Workgroup output protocol above and re-emit your FULL reply as ONE\n' +
        '  <workflow-output> envelope with <port name="..."> children (literal\n' +
        '  tag names — never invent your own tags).'
      )
    case 'both-present':
      return (
        '- You emitted BOTH <workflow-output> and <workflow-clarify>. Emit exactly\n' +
        '  ONE — the <workflow-output> envelope with your wg_* ports.'
      )
    case 'clarify-malformed':
      return (
        '- Your <workflow-clarify> reply was malformed. Re-emit a VALID\n' +
        '  <workflow-clarify> envelope (see the clarify format above) OR, if nothing\n' +
        '  needs a human, proceed with a <workflow-output> envelope.'
      )
    case 'envelope-port-malformed':
      return (
        '- A <port> tag in your envelope was unclosed or corrupted. Re-emit ONE\n' +
        '  clean <workflow-output> with each port properly closed by </port>.'
      )
    case 'port-validation':
      return (
        '- A port in your envelope failed validation. Re-emit a <workflow-output>\n' +
        '  whose port bodies are valid JSON matching the protocol above.'
      )
    case 'clarify-required':
      return (
        '- This turn requires a <workflow-clarify> envelope. Re-emit your reply as\n' +
        '  a single valid <workflow-clarify> envelope.'
      )
    case 'branch-marker':
      // RFC-306. A workgroup turn speaks the wg_* protocol and declares no branch
      // ports at all, so reaching this case means the model invented a marker.
      // Telling it to drop the marker is the only correct instruction here — a
      // workgroup turn has no branch it could legitimately close.
      return (
        '- You marked a <port> with active="false". Workgroup turn ports are NOT\n' +
        '  branch ports — re-emit ONE <workflow-output> with plain <port> tags and\n' +
        '  no active attribute.'
      )
  }
}

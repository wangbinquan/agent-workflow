// RFC-164 PR-2 — workgroup prompt-context core: pure functions that decide
// WHAT each member sees per turn (design §6). The engine (PR-3) assembles the
// final prompt through renderUserPrompt; everything here is side-effect-free
// and table-testable.
//
// Slice rules (design §6.2): the three switches control agent injection ONLY —
// the room always shows humans everything. free_collab reads as all-on
// (resolveWorkgroupSwitches, shared).
//
// Prompt-isolation invariant (design §11): nothing returned by this module
// may contain user ids — members are addressed exclusively by displayName.

import type {
  WorkgroupAssignment,
  WorkgroupMessage,
  WorkgroupRuntimeConfig,
  WorkgroupRuntimeMember,
} from '@agent-workflow/shared'
import {
  fenceUntrusted,
  resolveWorkgroupOutputContract,
  resolveWorkgroupSwitches,
  sanitizeInlineField,
} from '@agent-workflow/shared'

// Character budgets for injected slices (clip keeps the TAIL — newest wins).
export const WG_BLACKBOARD_CHAR_BUDGET = 8000
export const WG_PEER_RESULTS_CHAR_BUDGET = 6000
export const WG_MENTIONS_CHAR_BUDGET = 4000

export function memberById(
  config: WorkgroupRuntimeConfig,
  memberId: string,
): WorkgroupRuntimeMember | null {
  return config.members.find((m) => m.id === memberId) ?? null
}

export function memberDisplayName(config: WorkgroupRuntimeConfig, memberId: string | null): string {
  if (memberId === null) return 'unknown'
  return memberById(config, memberId)?.displayName ?? 'unknown'
}

export function rosterDisplayNames(config: WorkgroupRuntimeConfig): Set<string> {
  return new Set(config.members.map((m) => m.displayName))
}

// ---------------------------------------------------------------------------
// Message ordering / cursor slicing (design §1.6) — ULID ids order lexically.
// ---------------------------------------------------------------------------

export function sliceMessagesAfter(
  messages: readonly WorkgroupMessage[],
  cursorMessageId: string,
): WorkgroupMessage[] {
  return messages.filter((m) => m.id > cursorMessageId)
}

export function maxMessageId(messages: readonly WorkgroupMessage[], floor = ''): string {
  let max = floor
  for (const m of messages) {
    if (m.id > max) max = m.id
  }
  return max
}

/**
 * RFC-229 — authoritative direct parent for a message turn. The turn's shard
 * freezes maxMsgId, so fresh and adopted continuations resolve identically.
 */
export function resolveMessageTurnTriggerId(
  memberId: string,
  maxMsgId: string | null,
  messages: readonly {
    id: string
    authorMemberId: string | null
    mentionMemberIds: readonly string[]
  }[],
): string | null {
  if (maxMsgId === null || maxMsgId.length === 0 || maxMsgId === '0') return null
  let best: string | null = null
  for (const message of messages) {
    if (message.id > maxMsgId) continue
    if (message.authorMemberId === memberId) continue
    if (!message.mentionMemberIds.includes(memberId)) continue
    if (best === null || message.id > best) best = message.id
  }
  return best
}

/** Keep the newest items that fit the char budget (render-measured). */
export function clipTailByCharBudget<T>(
  items: readonly T[],
  budget: number,
  render: (item: T) => string,
): { kept: T[]; dropped: number } {
  const kept: T[] = []
  let used = 0
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i] as T
    const len = render(item).length + 1
    if (used + len > budget && kept.length > 0) {
      return { kept, dropped: i + 1 }
    }
    if (used + len > budget && kept.length === 0) {
      // A single oversized item still goes in (truncated at render time).
      kept.unshift(item)
      return { kept, dropped: i }
    }
    kept.unshift(item)
    used += len
  }
  return { kept, dropped: 0 }
}

// ---------------------------------------------------------------------------
// Per-member injection slices (the 2³ switch matrix, design §6.2)
// ---------------------------------------------------------------------------

export interface WorkgroupSliceState {
  assignments: readonly WorkgroupAssignment[]
  /** Full room, ascending id order. */
  messages: readonly WorkgroupMessage[]
  /** This member's consumption cursor ('' = nothing consumed yet). */
  cursorMessageId: string
}

export interface MemberSlices {
  /** share_outputs: peers' finished results (this member's own excluded). */
  peerResults: WorkgroupMessage[]
  /** direct_messages: unconsumed messages that @-mention this member. */
  mentions: WorkgroupMessage[]
  /** blackboard: unconsumed PUBLIC room tail (undirected chat/result/delivery/decision/system). */
  blackboard: WorkgroupMessage[]
  droppedByBudget: { peerResults: number; mentions: number; blackboard: number }
}

function isPublicRoomMessage(m: WorkgroupMessage): boolean {
  if (m.kind === 'chat') return m.mentionMemberIds.length === 0
  return (
    m.kind === 'result' || m.kind === 'delivery' || m.kind === 'decision' || m.kind === 'system'
  )
}

export function selectMemberSlices(
  config: WorkgroupRuntimeConfig,
  memberId: string,
  state: WorkgroupSliceState,
  opts: {
    /**
     * RFC-215 §4 — fc 任务批 run 不消费 @ 消息（消息轨专职，游标单一归属）：
     * 任务 run 的注入跳过 mentions 切片，@ 消息由该成员的消息回合消费并推游标。
     */
    omitMentions?: boolean
  } = {},
): MemberSlices {
  const switches = resolveWorkgroupSwitches(config.mode, config.switches)
  const fresh = sliceMessagesAfter(state.messages, state.cursorMessageId)

  let peerResults: WorkgroupMessage[] = []
  let peerDropped = 0
  if (switches.shareOutputs) {
    const all = fresh.filter(
      (m) => (m.kind === 'result' || m.kind === 'delivery') && m.authorMemberId !== memberId,
    )
    const clipped = clipTailByCharBudget(all, WG_PEER_RESULTS_CHAR_BUDGET, (m) => m.bodyMd)
    peerResults = clipped.kept
    peerDropped = clipped.dropped
  }

  let mentions: WorkgroupMessage[] = []
  let mentionsDropped = 0
  if (switches.directMessages && opts.omitMentions !== true) {
    const all = fresh.filter(
      (m) => m.mentionMemberIds.includes(memberId) && m.authorMemberId !== memberId,
    )
    const clipped = clipTailByCharBudget(all, WG_MENTIONS_CHAR_BUDGET, (m) => m.bodyMd)
    mentions = clipped.kept
    mentionsDropped = clipped.dropped
  }

  let blackboard: WorkgroupMessage[] = []
  let blackboardDropped = 0
  if (switches.blackboard) {
    // Avoid double-injection: entries already carried by the other two slices
    // are excluded from the blackboard tail.
    const carried = new Set([...peerResults, ...mentions].map((m) => m.id))
    const all = fresh.filter((m) => isPublicRoomMessage(m) && !carried.has(m.id))
    const clipped = clipTailByCharBudget(all, WG_BLACKBOARD_CHAR_BUDGET, (m) => m.bodyMd)
    blackboard = clipped.kept
    blackboardDropped = clipped.dropped
  }

  return {
    peerResults,
    mentions,
    blackboard,
    droppedByBudget: {
      peerResults: peerDropped,
      mentions: mentionsDropped,
      blackboard: blackboardDropped,
    },
  }
}

// ---------------------------------------------------------------------------
// Rendered blocks (charter / roster / ledger) — english headers match the
// platform's protocol-block conventions (shared/src/prompt.ts).
// ---------------------------------------------------------------------------

// Charter block — group identity + standing charter (instructions). Injected to
// EVERY member every turn. RFC-176: the objective (goal) is NO LONGER here — it
// is a mode-routed directive (renderGoalBlock), not shared context.
export function renderCharterBlock(config: WorkgroupRuntimeConfig, envelopeNonce = ''): string {
  const groupName =
    envelopeNonce.length > 0 ? sanitizeInlineField(config.workgroupName) : config.workgroupName
  const lines = ['## Workgroup', '', `Group: ${groupName}`]
  lines.push(
    '',
    resolveWorkgroupOutputContract(config.outputContract) === 'files'
      ? 'Delivery contract: FILES. Put the primary deliverable in your own working copy using relative paths so it can be merged back.'
      : 'Delivery contract: DISCUSSION. Put the primary deliverable in the room/result summary as an actionable conclusion; files are optional supporting evidence.',
  )
  if (config.instructions.trim().length > 0) {
    lines.push(
      '',
      'Group charter:',
      fenceUntrusted('workgroup-charter', config.instructions.trim(), envelopeNonce),
    )
  }
  return lines.join('\n')
}

// Goal block — the task objective (RFC-176). Injected ONLY to the members who
// own the decomposition: the leader (leader_worker) or every member
// (free_collab). A leader_worker worker never sees it — it acts on the leader's
// assignment brief ('## Your assignment', composeMemberPrompt).
export function renderGoalBlock(config: WorkgroupRuntimeConfig, envelopeNonce = ''): string {
  const goal = config.goal.trim() || '(not stated)'
  return ['## Group goal', '', fenceUntrusted('workgroup-goal', goal, envelopeNonce)].join('\n')
}

export function renderRosterBlock(
  config: WorkgroupRuntimeConfig,
  opts: { excludeMemberId?: string; agentCards?: ReadonlyMap<string, string> } = {},
  envelopeNonce = '',
): string {
  const rows = config.members
    .filter((m) => m.id !== opts.excludeMemberId)
    .map((m) => {
      const role = m.roleDesc.trim().length > 0 ? ` — ${m.roleDesc.trim()}` : ''
      const head = `- @${m.displayName} (${m.memberType})${role}`
      const displayName =
        envelopeNonce.length > 0 ? sanitizeInlineField(m.displayName) : m.displayName
      const safeRole =
        envelopeNonce.length > 0 ? sanitizeInlineField(m.roleDesc.trim()) : m.roleDesc.trim()
      const renderedHead =
        envelopeNonce.length > 0
          ? `- @${displayName} (${m.memberType})${safeRole.length > 0 ? ` — ${safeRole}` : ''}`
          : head
      // RFC-166: agent members carry a capability card (real declared
      // inputs/outputs/role/prompt summary) so the leader coordinates against
      // actual capability, not just the group roleDesc. human members NEVER
      // get a card — a human's userId must never enter a prompt (design §11
      // prompt-isolation invariant); the card is keyed by memberId and only
      // populated for agent members by buildRosterAgentCards.
      const card = m.memberType === 'agent' ? opts.agentCards?.get(m.id) : undefined
      if (card === undefined || card.trim().length === 0) return renderedHead
      const indented = fenceUntrusted(`capability-${displayName}`, card, envelopeNonce)
        .split('\n')
        .map((line) => (line.length > 0 ? `  ${line}` : line))
        .join('\n')
      return `${renderedHead}\n${indented}`
    })
  return ['## Workgroup roster', '', ...rows].join('\n')
}

export interface LedgerEntry {
  assignment: WorkgroupAssignment
  resultSummary: string | null
}

/** Leader's per-turn assignment ledger (design §6.1-3). */
export function renderLeaderLedger(
  config: WorkgroupRuntimeConfig,
  entries: readonly LedgerEntry[],
  envelopeNonce = '',
): string {
  if (entries.length === 0) {
    return ['## Assignment ledger', '', '(no assignments yet)'].join('\n')
  }
  const rows = entries.map((e) => {
    const a = e.assignment
    const rawWho = memberDisplayName(config, a.assigneeMemberId)
    const who = envelopeNonce.length > 0 ? sanitizeInlineField(rawWho) : rawWho
    const title = envelopeNonce.length > 0 ? sanitizeInlineField(a.title) : a.title
    const base = `- [${a.status}] @${who} — ${title} (source: ${a.source})`
    if (e.resultSummary !== null && e.resultSummary.length > 0) {
      if (envelopeNonce.length > 0) {
        const result = fenceUntrusted('assignment-result', e.resultSummary, envelopeNonce)
          .split('\n')
          .map((line) => `  ${line}`)
          .join('\n')
        return `${base}\n  result:\n${result}`
      }
      return `${base}\n  result: ${e.resultSummary}`
    }
    return base
  })
  return ['## Assignment ledger', '', ...rows].join('\n')
}

// RFC-359 W1-T7e：协议块渲染器（纯函数）迁到 application/workgroups/workgroupProtocol.ts，
// 两个 provider 的工作组宿主回合共用同一份；这里保留再导出给 legacy 调用方。
export {
  renderWgProtocolBlock,
  wgHostRolePorts,
  type WorkgroupProtocolRole,
} from '../../../application/workgroups/workgroupProtocol'

export function renderMessagesBlock(
  config: WorkgroupRuntimeConfig,
  title: string,
  messages: readonly WorkgroupMessage[],
  envelopeNonce = '',
): string {
  if (messages.length === 0) return ''
  const rows = messages.map((m) => {
    const author =
      m.authorKind === 'system'
        ? 'system'
        : m.authorKind === 'human'
          ? 'human'
          : `@${memberDisplayName(config, m.authorMemberId)}`
    const safeAuthor = envelopeNonce.length > 0 ? sanitizeInlineField(author) : author
    if (envelopeNonce.length === 0) return `- ${safeAuthor}: ${m.bodyMd}`
    const body = fenceUntrusted('workgroup-message', m.bodyMd, envelopeNonce)
      .split('\n')
      .map((line) => `  ${line}`)
      .join('\n')
    return `- ${safeAuthor}:\n${body}`
  })
  return [`## ${title}`, '', ...rows].join('\n')
}

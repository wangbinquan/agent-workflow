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
import { resolveWorkgroupSwitches } from '@agent-workflow/shared'

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
  if (switches.directMessages) {
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

export function renderCharterBlock(config: WorkgroupRuntimeConfig): string {
  const lines = [
    '## Workgroup mission',
    '',
    `Group: ${config.workgroupName}`,
    `Goal: ${config.goal.trim() || '(not stated)'}`,
  ]
  if (config.instructions.trim().length > 0) {
    lines.push('', 'Group charter:', config.instructions.trim())
  }
  return lines.join('\n')
}

export function renderRosterBlock(
  config: WorkgroupRuntimeConfig,
  opts: { excludeMemberId?: string; agentCards?: ReadonlyMap<string, string> } = {},
): string {
  const rows = config.members
    .filter((m) => m.id !== opts.excludeMemberId)
    .map((m) => {
      const role = m.roleDesc.trim().length > 0 ? ` — ${m.roleDesc.trim()}` : ''
      const head = `- @${m.displayName} (${m.memberType})${role}`
      // RFC-166: agent members carry a capability card (real declared
      // inputs/outputs/role/prompt summary) so the leader coordinates against
      // actual capability, not just the group roleDesc. human members NEVER
      // get a card — a human's userId must never enter a prompt (design §11
      // prompt-isolation invariant); the card is keyed by memberId and only
      // populated for agent members by buildRosterAgentCards.
      const card = m.memberType === 'agent' ? opts.agentCards?.get(m.id) : undefined
      if (card === undefined || card.trim().length === 0) return head
      const indented = card
        .split('\n')
        .map((line) => (line.length > 0 ? `  ${line}` : line))
        .join('\n')
      return `${head}\n${indented}`
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
): string {
  if (entries.length === 0) {
    return ['## Assignment ledger', '', '(no assignments yet)'].join('\n')
  }
  const rows = entries.map((e) => {
    const a = e.assignment
    const who = memberDisplayName(config, a.assigneeMemberId)
    const base = `- [${a.status}] @${who} — ${a.title} (source: ${a.source})`
    if (e.resultSummary !== null && e.resultSummary.length > 0) {
      return `${base}\n  result: ${e.resultSummary}`
    }
    return base
  })
  return ['## Assignment ledger', '', ...rows].join('\n')
}

// ---------------------------------------------------------------------------
// Protocol blocks (design §5) — replace the agent's own outputs protocol.
// English, mirroring shared/src/prompt.ts buildProtocolBlock conventions.
// ---------------------------------------------------------------------------

export type WorkgroupProtocolRole = 'leader' | 'worker' | 'fc_member'

const ENVELOPE_RULES = [
  'Respond with EXACTLY ONE <workflow-output> envelope at the very end of your reply.',
  'Every port body is a JSON document — no markdown fences inside ports.',
  'If you need a human decision first, emit a <workflow-clarify> envelope INSTEAD (never both).',
].join('\n')

export function renderWgProtocolBlock(
  role: WorkgroupProtocolRole,
  config: WorkgroupRuntimeConfig,
): string {
  const switches = resolveWorkgroupSwitches(config.mode, config.switches)
  const msgTargets = switches.directMessages
    ? 'a member displayName from the roster, or null for the shared blackboard'
    : switches.blackboard
      ? 'null only (blackboard); direct messages are disabled in this group'
      : 'DISABLED in this group — omit the port entirely'
  const lines: string[] = ['## Workgroup output protocol', '']
  if (role === 'leader') {
    lines.push(
      'You are the group LEADER. You COORDINATE ONLY: break the goal down,',
      'dispatch assignments, verify results, and decide when the group is done.',
      'Never write code or produce deliverables yourself (violating this is a',
      'protocol breach). A good brief states the objective, the expected',
      'output, and clear boundaries.',
      '',
      'Ports:',
      '- <port name="wg_assignments">JSON array of {"member","title","brief"}.',
      '  member = an AGENT displayName from the roster. Empty array = no new work.</port>',
      `- <port name="wg_messages">JSON array of {"to","body"}; to = ${msgTargets}.</port>`,
      '- <port name="wg_decision">JSON {"action":"continue"} while work remains,',
      '  or {"action":"done","summary":"..."} to close the group task. REQUIRED every turn.</port>',
    )
  } else {
    if (role === 'worker') {
      lines.push(
        'You are a group WORKER executing ONE assignment. Do the work in the',
        'repository, then report. You CANNOT delegate or re-assign work to',
        'other members — if the assignment should be split, say so in your',
        'result (or message the leader) and the leader will decide.',
      )
    } else {
      lines.push(
        'You are a member of a leaderless workgroup. Work the shared task list:',
        'execute the task attached to this turn (if any), and add any NEW tasks',
        'you discover. Check the current task list first — do NOT add duplicates.',
      )
    }
    lines.push(
      '',
      'Ports:',
      '- <port name="wg_result">JSON {"summary","detail"?}. summary is what the',
      '  group sees — make it self-contained. REQUIRED when you did any work.</port>',
      `- <port name="wg_messages">JSON array of {"to","body"}; to = ${msgTargets}.</port>`,
    )
    if (role === 'fc_member') {
      lines.push(
        '- <port name="wg_tasks_add">JSON array of {"title","brief"?} — new tasks',
        '  for the shared list (deduplicated by title).</port>',
      )
    }
  }
  lines.push('', ENVELOPE_RULES)
  return lines.join('\n')
}

export function renderMessagesBlock(
  config: WorkgroupRuntimeConfig,
  title: string,
  messages: readonly WorkgroupMessage[],
): string {
  if (messages.length === 0) return ''
  const rows = messages.map((m) => {
    const author =
      m.authorKind === 'system'
        ? 'system'
        : m.authorKind === 'human'
          ? 'human'
          : `@${memberDisplayName(config, m.authorMemberId)}`
    return `- ${author}: ${m.bodyMd}`
  })
  return [`## ${title}`, '', ...rows].join('\n')
}

// RFC-207 — locks the contract that replaced RFC-180/181's `autonomous` switch:
// whether a workgroup involves humans is decided by ONE thing, the roster. This
// file is the renamed rfc180-workgroup-autonomous.test.ts; the old cases are kept
// (re-pointed at the new predicate) so the behaviours RFC-180/181 established —
// gate resolution, bounded leader-idle nudging, clarify-invite gating — cannot
// regress while the input changes.
//
// Why the switch went away: "does this group want a human in the loop" was
// expressed twice (roster + `autonomous`), and BOTH disagreeing combinations were
// bugs — no human yet still asking (the original complaint), and a human present
// yet hard-suppressed (the roster edit overruled by a switch).
// See design/RFC-207-workgroup-human-derived-clarify/design.md §1.

import { describe, expect, test } from 'bun:test'
import {
  resolveClarifyBudget,
  resolveCompletionGate,
  WG_CLARIFY_BUDGET_DEFAULT,
  WG_LEADER_IDLE_NUDGE_LIMIT,
  wgClarifyAskerKey,
  workgroupHasHumanMember,
  type WorkgroupMessage,
  type WorkgroupRuntimeConfig,
} from '@agent-workflow/shared'
import { renderWgProtocolBlock } from '../src/services/workgroup/context'
import { WG_LEADER_NODE_ID, WG_MEMBER_NODE_ID } from '../src/services/workgroup/launch'
import {
  decideWorkgroupOutcome,
  WG_NUDGE_BODY,
  type WakeInput,
} from '../src/services/workgroup/wake'

function cfg(over: Partial<WorkgroupRuntimeConfig> = {}): WorkgroupRuntimeConfig {
  return {
    workgroupId: 'wg1',
    workgroupName: 'squad',
    mode: 'leader_worker',
    leaderMemberId: 'm-lead',
    switches: { shareOutputs: true, directMessages: false, blackboard: false },
    maxRounds: 10,
    completionGate: true,
    instructions: '',
    goal: 'g',
    members: [
      {
        id: 'm-lead',
        memberType: 'agent',
        agentName: 'planner',
        userId: null,
        displayName: 'planner',
        roleDesc: '',
      },
      {
        id: 'm-coder',
        memberType: 'agent',
        agentName: 'coder',
        userId: null,
        displayName: 'coder',
        roleDesc: '',
      },
    ],
    ...over,
  }
}

function wakeInput(over: Partial<WakeInput> = {}): WakeInput {
  return {
    config: cfg(),
    assignments: [],
    messages: [],
    cursors: new Map(),
    inFlight: {
      leaderRunning: false,
      runningAssignmentIds: new Set(),
      messageTurnMemberIds: new Set(),
    },
    roundsUsed: 0,
    gate: { declaredDone: false, awaitingConfirmation: false, rejected: false },
    ...over,
  }
}

function nudgeMsg(id: string, bodyMd = WG_NUDGE_BODY): WorkgroupMessage {
  return {
    id,
    taskId: 't',
    round: 0,
    authorKind: 'system',
    authorMemberId: null,
    authorUserId: null,
    kind: 'chat',
    bodyMd,
    mentionMemberIds: [],
    assignmentId: null,
    createdAt: 0,
  }
}

/** Same group plus a human member — the ONE thing that turns ask-back / the gate on. */
function cfgHuman(over: Partial<WorkgroupRuntimeConfig> = {}): WorkgroupRuntimeConfig {
  const base = cfg(over)
  return {
    ...base,
    members: [
      ...base.members,
      {
        id: 'm-human',
        memberType: 'human',
        agentName: null,
        userId: 'u-1',
        displayName: 'owner',
        roleDesc: '',
      },
    ],
  }
}

const EMPTY_WAKE = { items: [], capExceeded: false } as const

describe('RFC-207 — the roster is the single source', () => {
  test('workgroupHasHumanMember: true iff some member is a human', () => {
    expect(workgroupHasHumanMember([])).toBe(false)
    expect(workgroupHasHumanMember(cfg().members)).toBe(false)
    expect(workgroupHasHumanMember(cfgHuman().members)).toBe(true)
  })

  test('resolveCompletionGate: no human ⇒ OFF whatever is stored; with a human the stored value stands', () => {
    expect(resolveCompletionGate(cfg().members, true)).toBe(false)
    expect(resolveCompletionGate(cfg().members, false)).toBe(false)
    expect(resolveCompletionGate(cfgHuman().members, true)).toBe(true)
    expect(resolveCompletionGate(cfgHuman().members, false)).toBe(false)
  })

  test('resolveClarifyBudget is the ONLY fallback — a pre-RFC-207 snapshot reads as the default', () => {
    expect(resolveClarifyBudget({})).toBe(WG_CLARIFY_BUDGET_DEFAULT)
    expect(resolveClarifyBudget({ clarifyBudget: 0 })).toBe(0)
    expect(resolveClarifyBudget({ clarifyBudget: 7 })).toBe(7)
  })

  test('wgClarifyAskerKey: leader is one asker, each assignment one, each member one', () => {
    expect(wgClarifyAskerKey(WG_LEADER_NODE_ID, null, WG_LEADER_NODE_ID)).toBe('leader')
    expect(wgClarifyAskerKey(WG_MEMBER_NODE_ID, 'asg-1', WG_LEADER_NODE_ID)).toBe('asg:asg-1')
    // A message turn is sharded per MESSAGE; keying on that raw shard would mint a
    // fresh asker for every incoming message, resetting the budget forever.
    expect(wgClarifyAskerKey(WG_MEMBER_NODE_ID, 'msg:m-coder:01AAA', WG_LEADER_NODE_ID)).toBe(
      'mem:m-coder',
    )
    expect(wgClarifyAskerKey(WG_MEMBER_NODE_ID, 'msg:m-coder:01ZZZ', WG_LEADER_NODE_ID)).toBe(
      'mem:m-coder',
    )
  })
})

describe('RFC-207 prompt — the clarify invite follows the resolved permission', () => {
  const cases = [
    { role: 'leader' as const, mode: 'leader_worker' as const },
    { role: 'worker' as const, mode: 'leader_worker' as const },
    { role: 'fc_member' as const, mode: 'free_collab' as const },
  ]
  for (const { role, mode } of cases) {
    test(`invite present iff the caller says ask-back is allowed (${role})`, () => {
      const allowed = renderWgProtocolBlock(role, cfgHuman({ mode }), '', true)
      const denied = renderWgProtocolBlock(role, cfg({ mode }), '', false)
      expect(allowed).toContain('<workflow-clarify>') // RFC-172 not regressed
      expect(denied).not.toContain('<workflow-clarify>')
    })

    test(`the renderer never second-guesses the caller (${role})`, () => {
      // Design-gate P1: the invite and the envelope gate must come from ONE
      // resolution. If this function re-derived the answer from the roster, a
      // spent ask-back budget or a per-asker stop would still be invited here and
      // then rejected at the envelope — burning the protocol retry budget.
      expect(renderWgProtocolBlock(role, cfgHuman({ mode }), '', false)).not.toContain(
        '<workflow-clarify>',
      )
    })
  }
})

describe('RFC-207 engine — gate resolve follows the roster', () => {
  test('no human + leader declared done → done (nobody to confirm)', () => {
    const input = wakeInput({
      config: cfg({ completionGate: true }),
      gate: { declaredDone: true, awaitingConfirmation: false, rejected: false },
    })
    expect(decideWorkgroupOutcome(input, EMPTY_WAKE)).toEqual({ kind: 'done' })
  })
  test('human + gate on + declared done → awaiting_gate', () => {
    const input = wakeInput({
      config: cfgHuman({ completionGate: true }),
      gate: { declaredDone: true, awaitingConfirmation: false, rejected: false },
    })
    expect(decideWorkgroupOutcome(input, EMPTY_WAKE)).toEqual({ kind: 'awaiting_gate' })
  })
})

describe('RFC-207 engine — leader-idle auto-nudge (now unconditional)', () => {
  test('leader idle → leader-nudge (nudgeCount 0)', () => {
    const input = wakeInput({ config: cfg() })
    expect(decideWorkgroupOutcome(input, EMPTY_WAKE)).toEqual({
      kind: 'leader-nudge',
      nudgeCount: 0,
    })
  })
  test('nudgeCount = trailing nudge count; below the limit still nudges', () => {
    const near = wakeInput({
      config: cfg(),
      messages: Array.from({ length: WG_LEADER_IDLE_NUDGE_LIMIT - 1 }, (_, i) => nudgeMsg(`n${i}`)),
    })
    expect(decideWorkgroupOutcome(near, EMPTY_WAKE)).toEqual({
      kind: 'leader-nudge',
      nudgeCount: WG_LEADER_IDLE_NUDGE_LIMIT - 1,
    })
  })
  test('at the nudge limit → park awaiting_human (no hot loop)', () => {
    const at = wakeInput({
      config: cfg(),
      messages: Array.from({ length: WG_LEADER_IDLE_NUDGE_LIMIT }, (_, i) => nudgeMsg(`n${i}`)),
    })
    expect(decideWorkgroupOutcome(at, EMPTY_WAKE)).toEqual({
      kind: 'awaiting_human',
      reason: 'leader-idle',
    })
  })
  test('a non-nudge message after nudges resets the count (progress)', () => {
    const input = wakeInput({
      config: cfg(),
      messages: [nudgeMsg('n0'), nudgeMsg('n1'), nudgeMsg('n2', 'real work dispatched')],
    })
    expect(decideWorkgroupOutcome(input, EMPTY_WAKE)).toEqual({
      kind: 'leader-nudge',
      nudgeCount: 0,
    })
  })
  // RFC-207 §3.3 — this used to be "non-autonomous parks immediately". A cheap
  // retry before spending a human's attention is better for BOTH kinds of group,
  // so the split is gone; a roster with a human nudges first as well.
  test('a roster with a human nudges first too, and still parks at the limit', () => {
    expect(decideWorkgroupOutcome(wakeInput({ config: cfgHuman() }), EMPTY_WAKE)).toEqual({
      kind: 'leader-nudge',
      nudgeCount: 0,
    })
    const spent = wakeInput({
      config: cfgHuman(),
      messages: Array.from({ length: WG_LEADER_IDLE_NUDGE_LIMIT }, (_, i) => nudgeMsg(`n${i}`)),
    })
    expect(decideWorkgroupOutcome(spent, EMPTY_WAKE)).toEqual({
      kind: 'awaiting_human',
      reason: 'leader-idle',
    })
  })
})

// RFC-180「全自动」— locks the autonomous-mode contract: the two resolve oracles,
// the prompt clarify-invite gating, and the engine's gate-resolve + leader-idle
// auto-nudge (with the trailing-nudge cap). Non-autonomous paths are asserted
// unchanged (RFC-172 clarify invite / RFC-164 gate + leader-idle parking).
// See design/RFC-180-workgroup-autonomous-mode/design.md §2.

import { describe, expect, test } from 'bun:test'
import {
  resolveClarifyEnabled,
  resolveCompletionGate,
  WG_AUTONOMOUS_NUDGE_LIMIT,
  type WorkgroupMessage,
  type WorkgroupRuntimeConfig,
} from '@agent-workflow/shared'
import { renderWgProtocolBlock } from '../src/services/workgroupContext'
import {
  decideWorkgroupOutcome,
  WG_NUDGE_BODY,
  type WakeInput,
} from '../src/services/workgroupWake'

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

const EMPTY_WAKE = { items: [], capExceeded: false } as const

describe('RFC-180 resolve oracles', () => {
  test('resolveCompletionGate: autonomous overrides to OFF; else stored stands', () => {
    expect(resolveCompletionGate(true, true)).toBe(false)
    expect(resolveCompletionGate(true, false)).toBe(false)
    expect(resolveCompletionGate(false, true)).toBe(true)
    expect(resolveCompletionGate(false, false)).toBe(false)
  })
  test('resolveClarifyEnabled: disabled iff autonomous', () => {
    expect(resolveClarifyEnabled(true)).toBe(false)
    expect(resolveClarifyEnabled(false)).toBe(true)
  })
})

describe('RFC-180 prompt — clarify invite gating', () => {
  const cases = [
    { role: 'leader' as const, mode: 'leader_worker' as const },
    { role: 'worker' as const, mode: 'leader_worker' as const },
    { role: 'fc_member' as const, mode: 'free_collab' as const },
  ]
  for (const { role, mode } of cases) {
    test(`autonomous omits the clarify invite; non-autonomous keeps it (${role})`, () => {
      const on = renderWgProtocolBlock(role, cfg({ mode, autonomous: true }))
      const off = renderWgProtocolBlock(role, cfg({ mode, autonomous: false }))
      expect(on).not.toContain('<workflow-clarify>')
      expect(off).toContain('<workflow-clarify>') // RFC-172 not regressed
    })
  }
})

describe('RFC-180 engine — gate resolve', () => {
  test('autonomous + leader declared done → done (not awaiting_gate)', () => {
    const input = wakeInput({
      config: cfg({ autonomous: true, completionGate: true }),
      gate: { declaredDone: true, awaitingConfirmation: false, rejected: false },
    })
    expect(decideWorkgroupOutcome(input, EMPTY_WAKE)).toEqual({ kind: 'done' })
  })
  test('non-autonomous + gate on + declared done → awaiting_gate (regression)', () => {
    const input = wakeInput({
      config: cfg({ autonomous: false, completionGate: true }),
      gate: { declaredDone: true, awaitingConfirmation: false, rejected: false },
    })
    expect(decideWorkgroupOutcome(input, EMPTY_WAKE)).toEqual({ kind: 'awaiting_gate' })
  })
})

describe('RFC-180 engine — leader-idle auto-nudge', () => {
  test('autonomous + leader idle → leader-nudge (nudgeCount 0)', () => {
    const input = wakeInput({ config: cfg({ autonomous: true }) })
    expect(decideWorkgroupOutcome(input, EMPTY_WAKE)).toEqual({
      kind: 'leader-nudge',
      nudgeCount: 0,
    })
  })
  test('nudgeCount = trailing nudge count; below the limit still nudges', () => {
    const near = wakeInput({
      config: cfg({ autonomous: true }),
      messages: Array.from({ length: WG_AUTONOMOUS_NUDGE_LIMIT - 1 }, (_, i) => nudgeMsg(`n${i}`)),
    })
    expect(decideWorkgroupOutcome(near, EMPTY_WAKE)).toEqual({
      kind: 'leader-nudge',
      nudgeCount: WG_AUTONOMOUS_NUDGE_LIMIT - 1,
    })
  })
  test('at the nudge limit → park awaiting_human (no hot loop)', () => {
    const at = wakeInput({
      config: cfg({ autonomous: true }),
      messages: Array.from({ length: WG_AUTONOMOUS_NUDGE_LIMIT }, (_, i) => nudgeMsg(`n${i}`)),
    })
    expect(decideWorkgroupOutcome(at, EMPTY_WAKE)).toEqual({
      kind: 'awaiting_human',
      reason: 'leader-idle',
    })
  })
  test('a non-nudge message after nudges resets the count (progress)', () => {
    const input = wakeInput({
      config: cfg({ autonomous: true }),
      messages: [nudgeMsg('n0'), nudgeMsg('n1'), nudgeMsg('n2', 'real work dispatched')],
    })
    expect(decideWorkgroupOutcome(input, EMPTY_WAKE)).toEqual({
      kind: 'leader-nudge',
      nudgeCount: 0,
    })
  })
  test('non-autonomous leader idle → awaiting_human/leader-idle (regression, no nudge)', () => {
    const input = wakeInput({ config: cfg({ autonomous: false }) })
    expect(decideWorkgroupOutcome(input, EMPTY_WAKE)).toEqual({
      kind: 'awaiting_human',
      reason: 'leader-idle',
    })
  })
})

// RFC-187 T12 / AC-12 (audit design/workgroup-e2e-audit.md §3-2) — a leader that emits
// `continue` with NO new assignments ends the round with nothing running: the group stalls.
// The recovery halves already exist and are locked here so they can't regress:
//   • bounded auto-nudge, then park awaiting_human.
// RFC-207 §3.3 unified this: the nudge used to be autonomous-only, with supervised groups
// parking on the spot. Nudging first is strictly better in BOTH cases — a leader that merely
// fumbled one turn recovers itself, and a human is only pulled in once it really is stuck —
// so the split is gone and every group now nudges up to the limit first.
// What was missing is WHY: a bare `continue` tells neither the nudge reader nor the human
// what the leader is waiting on. The protocol now requires the leader to say it.

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { WorkgroupMessage, WorkgroupRuntimeConfig } from '@agent-workflow/shared'
import { WG_LEADER_IDLE_NUDGE_LIMIT } from '@agent-workflow/shared'
import {
  decideWorkgroupOutcome,
  WG_NUDGE_BODY,
  type WakeInput,
} from '../src/services/workgroupWake'

function cfg(overrides: Partial<WorkgroupRuntimeConfig> = {}): WorkgroupRuntimeConfig {
  return {
    workgroupId: 'wg1',
    workgroupName: 'squad',
    mode: 'leader_worker',
    leaderMemberId: 'm-lead',
    switches: { shareOutputs: true, directMessages: false, blackboard: false },
    maxRounds: 10,
    completionGate: false,
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
    ],
    ...overrides,
  }
}

/** Same group, but with a human on the roster — RFC-207's ask-back/gate predicate. */
function cfgWithHuman(): WorkgroupRuntimeConfig {
  const base = cfg()
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

const nudge = (n: number): WorkgroupMessage[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `01M${String(i).padStart(6, '0')}`,
    taskId: 't1',
    round: 1,
    authorKind: 'system' as const,
    authorMemberId: null,
    authorUserId: null,
    kind: 'chat' as const,
    bodyMd: WG_NUDGE_BODY,
    mentionMemberIds: [],
    assignmentId: null,
    createdAt: i,
  }))

function wakeInput(overrides: Partial<WakeInput> = {}): WakeInput {
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
    roundsUsed: 1,
    gate: { declaredDone: false, awaitingConfirmation: false, rejected: false },
    ...overrides,
  }
}

const EMPTY = { items: [], capExceeded: false }

describe('RFC-187 §3-2 — continue-no-dispatch recovery (locked, must not regress)', () => {
  test('an idle leader is auto-nudged, bounded by the limit', () => {
    const out = decideWorkgroupOutcome(wakeInput({ config: cfg() }), EMPTY)
    expect(out).toEqual({ kind: 'leader-nudge', nudgeCount: 0 })
  })

  test('nudges are BOUNDED — at the limit it parks instead of nudging forever', () => {
    const out = decideWorkgroupOutcome(
      wakeInput({ config: cfg(), messages: nudge(WG_LEADER_IDLE_NUDGE_LIMIT) }),
      EMPTY,
    )
    expect(out).toEqual({ kind: 'awaiting_human', reason: 'leader-idle' })
  })

  // RFC-207 §3.3 — a roster WITH a human gets the same treatment: the nudge is not a
  // substitute for the human, it is a cheap retry before spending the human's attention.
  test('a roster with a human member nudges first too (no autonomous/supervised split)', () => {
    const out = decideWorkgroupOutcome(wakeInput({ config: cfgWithHuman() }), EMPTY)
    expect(out).toEqual({ kind: 'leader-nudge', nudgeCount: 0 })
  })

  test('a roster with a human member still parks once the nudge budget is spent', () => {
    const out = decideWorkgroupOutcome(
      wakeInput({ config: cfgWithHuman(), messages: nudge(WG_LEADER_IDLE_NUDGE_LIMIT) }),
      EMPTY,
    )
    expect(out).toEqual({ kind: 'awaiting_human', reason: 'leader-idle' })
  })
})

describe('RFC-187 §3-2 — the leader must say WHAT is blocking (AC-12)', () => {
  const CTX = readFileSync(
    resolve(import.meta.dir, '..', 'src', 'services', 'workgroupContext.ts'),
    'utf8',
  )

  test('the leader protocol requires a blocker statement on continue-without-dispatch', () => {
    expect(CTX).toContain(
      'If you emit "continue" WITHOUT any new wg_assignments, you MUST state in',
    )
    expect(CTX).toContain('wg_messages what you are waiting on or what is blocking')
  })
})

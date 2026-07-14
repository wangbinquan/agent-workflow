// RFC-187 F3/F8 (audit design/workgroup-e2e-audit.md §5 F3/F8) — a non-autonomous
// leader that asks a <workflow-clarify> used to spin to max_rounds: the leader
// clarify parks on a __wg_clarify__ row (null shardKey), but the old `leaderParked`
// checked hostRuns for __wg_leader__+awaiting_human (a state that never exists — leader
// runs go `done`) AND loadDbState never even loaded __wg_clarify__ rows. So the engine
// re-drove the leader every round, orphaned N clarify sessions, and the human was never
// asked (probe B: 10 leader rounds → failed "hit max_rounds (10)"). Fix: derive the park
// from the clarify rows and surface awaiting_human reason `leader-clarify`.

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { WorkgroupMessage, WorkgroupRuntimeConfig } from '@agent-workflow/shared'
import {
  decideWorkgroupOutcome,
  deriveWakeSet,
  type WakeInput,
} from '../src/services/workgroupWake'
import { deriveLeaderClarifyPark } from '../src/services/workgroupRunner'

function cfg(overrides: Partial<WorkgroupRuntimeConfig> = {}): WorkgroupRuntimeConfig {
  return {
    workgroupId: 'wg1',
    workgroupName: 'squad',
    mode: 'leader_worker',
    leaderMemberId: 'm-lead',
    switches: { shareOutputs: true, directMessages: false, blackboard: false },
    maxRounds: 10,
    completionGate: false,
    instructions: 'be kind',
    goal: 'fix payments',
    autonomous: false,
    members: [
      {
        id: 'm-lead',
        memberType: 'agent',
        agentName: 'planner',
        userId: null,
        displayName: 'planner',
        roleDesc: '协调',
      },
      {
        id: 'm-coder',
        memberType: 'agent',
        agentName: 'coder-a',
        userId: null,
        displayName: 'coder',
        roleDesc: '实现',
      },
    ],
    ...overrides,
  }
}

function wakeInput(overrides: Partial<WakeInput> = {}): WakeInput {
  return {
    config: cfg(),
    assignments: [],
    messages: [] as WorkgroupMessage[],
    cursors: new Map(),
    inFlight: {
      leaderRunning: false,
      runningAssignmentIds: new Set(),
      messageTurnMemberIds: new Set(),
    },
    roundsUsed: 0,
    gate: { declaredDone: false, awaitingConfirmation: false, rejected: false },
    ...overrides,
  }
}

type ClarifyRow = { status: string; shardKey: string | null }

describe('RFC-187 F3 — deriveLeaderClarifyPark', () => {
  test('an awaiting_human clarify run with null shardKey = leader park', () => {
    const runs: ClarifyRow[] = [{ status: 'awaiting_human', shardKey: null }]
    expect(deriveLeaderClarifyPark(runs)).toBe(true)
  })

  test('a member clarify (non-null shardKey) is NOT a leader park', () => {
    // member clarifies carry the assignment shardKey; they park their assignment
    // awaiting_human (caught by humanPending), never this signal.
    expect(deriveLeaderClarifyPark([{ status: 'awaiting_human', shardKey: 'asg-1' }])).toBe(false)
    expect(
      deriveLeaderClarifyPark([{ status: 'awaiting_human', shardKey: 'msg:m-coder:01' }]),
    ).toBe(false)
  })

  test('a done/answered clarify run does not park', () => {
    expect(deriveLeaderClarifyPark([{ status: 'done', shardKey: null }])).toBe(false)
    expect(deriveLeaderClarifyPark([{ status: 'canceled', shardKey: null }])).toBe(false)
  })

  test('empty clarify set = not parked', () => {
    expect(deriveLeaderClarifyPark([])).toBe(false)
  })

  test('mixed: a leader park among member parks is still detected', () => {
    const runs: ClarifyRow[] = [
      { status: 'awaiting_human', shardKey: 'asg-1' },
      { status: 'done', shardKey: null },
      { status: 'awaiting_human', shardKey: null },
    ]
    expect(deriveLeaderClarifyPark(runs)).toBe(true)
  })
})

describe('RFC-187 F3/F8 — decideWorkgroupOutcome surfaces leader-clarify', () => {
  test('leaderClarifyParked → awaiting_human reason leader-clarify', () => {
    const out = decideWorkgroupOutcome(wakeInput({ leaderClarifyParked: true }), {
      items: [],
      capExceeded: false,
    })
    expect(out).toEqual({ kind: 'awaiting_human', reason: 'leader-clarify' })
  })

  test('leader-clarify park BEATS max_rounds (a blocked leader is not a failure)', () => {
    // this is exactly probe B: without the park signal the same state returned
    // { failed, max-rounds }.
    const out = decideWorkgroupOutcome(wakeInput({ leaderClarifyParked: true, roundsUsed: 10 }), {
      items: [],
      capExceeded: true,
    })
    expect(out).toEqual({ kind: 'awaiting_human', reason: 'leader-clarify' })
  })

  test('without the park signal, the same empty state hits max_rounds (regression contrast)', () => {
    const out = decideWorkgroupOutcome(wakeInput({ roundsUsed: 10 }), {
      items: [],
      capExceeded: true,
    })
    expect(out).toEqual({ kind: 'failed', reason: 'max-rounds' })
  })

  test('an in-flight leader still reports running (park only matters when idle)', () => {
    const out = decideWorkgroupOutcome(
      wakeInput({
        leaderClarifyParked: true,
        inFlight: {
          leaderRunning: true,
          runningAssignmentIds: new Set(),
          messageTurnMemberIds: new Set(),
        },
      }),
      { items: [], capExceeded: false },
    )
    expect(out).toEqual({ kind: 'running' })
  })
})

describe('RFC-187 F3 — deriveWakeSet does not re-drive a clarify-parked leader', () => {
  test('leaderClarifyParked suppresses the leader wake even on the initial round', () => {
    const parked = deriveWakeSet(wakeInput({ leaderClarifyParked: true }))
    expect(parked.items.filter((i) => i.kind === 'leader')).toHaveLength(0)
    // sanity: without the park the leader IS woken (initial round).
    const notParked = deriveWakeSet(wakeInput({ leaderClarifyParked: false }))
    expect(notParked.items.filter((i) => i.kind === 'leader')).toHaveLength(1)
  })
})

describe('RFC-187 F3 — source locks (engine wiring)', () => {
  const RUNNER = readFileSync(
    resolve(import.meta.dir, '..', 'src', 'services', 'workgroupRunner.ts'),
    'utf8',
  )

  test('loadDbState loads __wg_clarify__ runs (partitioned out of hostRuns)', () => {
    expect(RUNNER).toMatch(
      /inArray\(nodeRuns\.nodeId, \[WG_LEADER_NODE_ID, WG_MEMBER_NODE_ID, WG_CLARIFY_NODE_ID\]\)/,
    )
    expect(RUNNER).toContain(
      'clarifyRuns: allHostNodeRuns.filter((r) => r.nodeId === WG_CLARIFY_NODE_ID)',
    )
  })

  test('leaderParked is derived from clarifyRuns, not the dead hostRuns check', () => {
    expect(RUNNER).toContain('deriveLeaderClarifyPark(state.clarifyRuns)')
    // the old dead predicate (leader host run at awaiting_human) must be gone.
    expect(RUNNER).not.toMatch(/r\.nodeId === WG_LEADER_NODE_ID && r\.status === 'awaiting_human'/)
    // and it must NOT be folded back into leaderRunning (that yields a generic
    // `running` outcome instead of the leader-clarify park).
    expect(RUNNER).not.toContain('inflightMeta.leaderRunning || leaderParked')
  })
})

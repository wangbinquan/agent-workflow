// RFC-187 §3-7 (audit design/workgroup-e2e-audit.md §3-7) — maxRounds used to hard-fail
// even when the workers had produced a deliverable. Probe C: maxRounds:1, leader
// dispatches (round 1), worker writes hello.txt, the leader needs round 2 to aggregate
// but can't → task `failed` "hit max_rounds (1)" with hello.txt sitting in canonical.
// Fix: grant ONE grace wrap-up round at the cap when there's completed work (so the
// leader can declare done), and if the cap is still exceeded with work done, park
// awaiting_human (deliverable visible) instead of a bare `failed`.

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type {
  WorkgroupAssignment,
  WorkgroupMessage,
  WorkgroupRuntimeConfig,
} from '@agent-workflow/shared'
import {
  decideWorkgroupOutcome,
  deriveWakeSet,
  type WakeInput,
} from '../src/services/workgroupWake'
import { isLeaderWrapUpContinuation } from '../src/services/workgroupRunner'

function cfg(overrides: Partial<WorkgroupRuntimeConfig> = {}): WorkgroupRuntimeConfig {
  return {
    workgroupId: 'wg1',
    workgroupName: 'squad',
    mode: 'leader_worker',
    leaderMemberId: 'm-lead',
    switches: { shareOutputs: true, directMessages: false, blackboard: false },
    maxRounds: 1,
    completionGate: false,
    instructions: 'go',
    goal: 'make hello.txt',
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

let seq = 0
function doneAsg(): WorkgroupAssignment {
  seq += 1
  return {
    id: `asg-${seq}`,
    taskId: 't1',
    round: 1,
    createdByRunId: null,
    createdByUserId: null,
    assigneeMemberId: 'm-coder',
    source: 'leader',
    title: 'write hello.txt',
    briefMd: 'write a line',
    status: 'done',
    nodeRunId: null,
    resultMessageId: null,
    dedupKey: null,
    createdAt: seq,
    updatedAt: seq,
  }
}

function resultMsg(): WorkgroupMessage {
  seq += 1
  return {
    id: `01M${String(seq).padStart(6, '0')}`,
    taskId: 't1',
    round: 1,
    authorKind: 'member',
    authorMemberId: 'm-coder',
    authorUserId: null,
    kind: 'result',
    bodyMd: 'wrote hello.txt',
    mentionMemberIds: [],
    assignmentId: null,
    createdAt: seq,
  }
}

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
    roundsUsed: 0,
    gate: { declaredDone: false, awaitingConfirmation: false, rejected: false },
    ...overrides,
  }
}

describe('RFC-187 §3-7 — grace wrap-up round at the cap', () => {
  test('probe C shape: at the cap WITH a done assignment → one grace wrap-up leader round', () => {
    // maxRounds:1, one leader round used, worker done, its result unconsumed by the
    // leader (new-content). Without the grace round this was capExceeded → failed.
    const wake = deriveWakeSet(
      wakeInput({
        assignments: [doneAsg()],
        messages: [resultMsg()], // leader cursor empty ⇒ unconsumed ⇒ would wake
        roundsUsed: 1,
      }),
    )
    const leaderItems = wake.items.filter((i) => i.kind === 'leader')
    expect(leaderItems).toHaveLength(1)
    expect((leaderItems[0] as { reason: string }).reason).toBe('wrap-up')
    expect(wake.capExceeded).toBe(false)
  })

  test('at the cap with NO completed work → capExceeded, no grace round', () => {
    const wake = deriveWakeSet(
      wakeInput({
        assignments: [], // nothing produced
        messages: [resultMsg()],
        roundsUsed: 1,
      }),
    )
    expect(wake.items.filter((i) => i.kind === 'leader')).toHaveLength(0)
    expect(wake.capExceeded).toBe(true)
  })

  test('PAST the cap (roundsUsed = maxRounds+1) → no second grace round even with work', () => {
    // the grace round already ran and was counted; only one is ever granted.
    const wake = deriveWakeSet(
      wakeInput({
        assignments: [doneAsg()],
        messages: [resultMsg()],
        roundsUsed: 2, // maxRounds=1, grace already consumed
      }),
    )
    expect(wake.items.filter((i) => i.kind === 'leader')).toHaveLength(0)
    expect(wake.capExceeded).toBe(true)
  })
})

describe('RFC-187 §3-7 — decideWorkgroupOutcome preserves the deliverable', () => {
  test('capExceeded WITH completed work → awaiting_human max-rounds-wrapup (not failed)', () => {
    const out = decideWorkgroupOutcome(wakeInput({ assignments: [doneAsg()], roundsUsed: 2 }), {
      items: [],
      capExceeded: true,
    })
    expect(out).toEqual({ kind: 'awaiting_human', reason: 'max-rounds-wrapup' })
  })

  test('capExceeded with NO completed work → failed max-rounds (genuine spin)', () => {
    const out = decideWorkgroupOutcome(wakeInput({ assignments: [], roundsUsed: 2 }), {
      items: [],
      capExceeded: true,
    })
    expect(out).toEqual({ kind: 'failed', reason: 'max-rounds' })
  })

  test('a delivered (human-handoff) assignment also counts as salvageable', () => {
    const delivered = { ...doneAsg(), status: 'delivered' as const }
    const out = decideWorkgroupOutcome(wakeInput({ assignments: [delivered], roundsUsed: 2 }), {
      items: [],
      capExceeded: true,
    })
    expect(out).toEqual({ kind: 'awaiting_human', reason: 'max-rounds-wrapup' })
  })

  test('a leader that already declaredDone finishes normally (autonomous → done)', () => {
    // the wrap-up path only matters when the leader NEVER declared done.
    const out = decideWorkgroupOutcome(
      wakeInput({
        assignments: [doneAsg()],
        roundsUsed: 2,
        gate: { declaredDone: true, awaitingConfirmation: false, rejected: false },
      }),
      { items: [], capExceeded: false },
    )
    expect(out).toEqual({ kind: 'done' })
  })
})

describe('RFC-187 §3-7 — wrap-up round dispatch-ban + directive (Codex P0-3)', () => {
  const RUNNER = readFileSync(
    resolve(import.meta.dir, '..', 'src', 'services', 'workgroupRunner.ts'),
    'utf8',
  )

  test('the wrap-up round injects a forced "declare done, do not dispatch" directive', () => {
    expect(RUNNER).toContain('FINAL round — the round cap has been reached')
    // threaded from the wake item...
    expect(RUNNER).toContain("item.reason === 'wrap-up'")
    // ...AND re-derived on the adopted (clarify-answer) path — see the Codex
    // impl-gate P1 lock below.
    expect(RUNNER).toContain(
      'driveLeaderTurn(args, state, row.id, isLeaderWrapUpContinuation(state))',
    )
  })

  test('new dispatch on a wrap-up round is DROPPED (not dispatched, not errored)', () => {
    // dropping (vs erroring) keeps a `done` decision landing — graceful, no hard fail.
    expect(RUNNER).toMatch(/wrapUp && dispatches\.ok && dispatches\.value\.length > 0/)
    expect(RUNNER).toContain('wrapUpDroppedDispatch = true')
  })
})

// RFC-187 §3-7 — Codex impl-gate P1: a wrap-up round that asks a human resumes via an
// ADOPTED clarify-answer rerun, which carries no wake item — so `wrapUp` was lost and the
// continuation could answer `continue + wg_assignments`, dispatching work past the cap
// that no later round can aggregate. The flag is now re-derived from state.
describe('RFC-187 §3-7 — isLeaderWrapUpContinuation (adopted clarify-answer keeps wrap-up)', () => {
  const st = (over: {
    mode?: 'leader_worker' | 'free_collab'
    maxRounds?: number
    rounds?: number
    done?: boolean
  }): Parameters<typeof isLeaderWrapUpContinuation>[0] => {
    const rounds = over.rounds ?? 0
    return {
      config: { ...cfg({ maxRounds: over.maxRounds ?? 1 }), mode: over.mode ?? 'leader_worker' },
      assignments: over.done === false ? [] : [doneAsg()],
      // countRoundsUsed(lw) reads max(wgRound) over non-canceled leader rows.
      hostRuns:
        rounds > 0
          ? [
              {
                nodeId: '__wg_leader__',
                status: 'done',
                wgRound: rounds,
                rerunCause: 'wg-leader-round',
              },
            ]
          : [],
    } as unknown as Parameters<typeof isLeaderWrapUpContinuation>[0]
  }

  test('at the cap WITH completed work → continuation stays in wrap-up mode', () => {
    expect(isLeaderWrapUpContinuation(st({ maxRounds: 1, rounds: 1 }))).toBe(true)
    // past the cap too (the grace round itself counted).
    expect(isLeaderWrapUpContinuation(st({ maxRounds: 1, rounds: 2 }))).toBe(true)
  })

  test('below the cap → an ordinary continuation (no FINAL directive / no dispatch-ban)', () => {
    expect(isLeaderWrapUpContinuation(st({ maxRounds: 5, rounds: 1 }))).toBe(false)
  })

  test('at the cap with NO completed work → not a wrap-up (nothing to salvage)', () => {
    expect(isLeaderWrapUpContinuation(st({ maxRounds: 1, rounds: 1, done: false }))).toBe(false)
  })

  test('free_collab has no leader wrap-up', () => {
    expect(isLeaderWrapUpContinuation(st({ mode: 'free_collab', maxRounds: 1, rounds: 1 }))).toBe(
      false,
    )
  })
})

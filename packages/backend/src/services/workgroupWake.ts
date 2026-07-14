// RFC-164 PR-2 — wake-set derivation + terminal-outcome decision (design
// §4.2/§4.4). Pure over plain inputs; the engine (PR-3) re-reads the tables
// each iteration and feeds them here — no in-memory state survives a daemon
// restart (design §4.3), and message consumption is cursor-based
// (workgroup_member_cursors, design §1.6) so wake decisions are idempotent.

import type {
  WorkgroupAssignment,
  WorkgroupMessage,
  WorkgroupRuntimeConfig,
} from '@agent-workflow/shared'
import {
  resolveCompletionGate,
  resolveWorkgroupSwitches,
  WG_AUTONOMOUS_NUDGE_LIMIT,
} from '@agent-workflow/shared'
import { sliceMessagesAfter } from './workgroupContext'

export interface WakeInput {
  config: WorkgroupRuntimeConfig
  assignments: readonly WorkgroupAssignment[]
  /** Full room, ascending id order. */
  messages: readonly WorkgroupMessage[]
  /** memberId → last consumed message id ('' = never consumed). */
  cursors: ReadonlyMap<string, string>
  inFlight: {
    leaderRunning: boolean
    /** assignment ids whose member run is currently being driven. */
    runningAssignmentIds: ReadonlySet<string>
    /** member ids with an in-flight message turn. */
    messageTurnMemberIds: ReadonlySet<string>
  }
  /** lw: completed-or-started leader turns; fc: total member runs (incl. message turns). */
  roundsUsed: number
  /**
   * RFC-187 F3 — the leader host run asked a human via `<workflow-clarify>` and is
   * parked awaiting the answer (an open `__wg_clarify__` run with a null shardKey —
   * leader host runs are unsharded, members always sharded). Derived by
   * `deriveLeaderClarifyPark`. Unlike a member clarify (which parks its assignment
   * `awaiting_human`, caught by `humanPending`), a leader clarify has no assignment,
   * so without this the engine re-drives the leader every round → it re-asks, orphans
   * N clarify sessions, and hits max_rounds (probe B). Suppresses the leader wake and
   * surfaces `awaiting_human` reason `leader-clarify` so a human can actually answer.
   * Optional so existing WakeInput literals default to not-parked.
   */
  leaderClarifyParked?: boolean
  gate: {
    declaredDone: boolean
    awaitingConfirmation: boolean
    /** Present right after a human rejected the completion gate. */
    rejected: boolean
  }
}

export type WakeItem =
  // RFC-187 §3-7 — `wrap-up` is a single grace leader round past max_rounds, granted
  // only when there is completed work to aggregate, so a deliverable-in-hand task can
  // reach `done` instead of hard-failing. It is a normal (counted) leader run, so the
  // next pass has roundsUsed > maxRounds and no second grace round is possible.
  | { kind: 'leader'; reason: 'initial' | 'new-content' | 'gate-rejected' | 'wrap-up' }
  | { kind: 'assignment'; assignmentId: string }
  | { kind: 'message_turn'; memberId: string }
  | { kind: 'fc_initial'; memberId: string }
  | { kind: 'fc_claim'; memberId: string; assignmentId: string }

export interface WakeSet {
  // RFC-170 CI unblock (user-authorized 2026-07-14): `readonly` so a caller can pass
  // an immutable literal (e.g. the rfc180 test's `EMPTY_WAKE = {...} as const`)
  // without a TS2345. Consumers only READ `items` (verified: no `.items` mutation
  // across the backend), and a builder's mutable local array is still assignable
  // to a readonly field, so this is a safe non-behavioral type refinement.
  items: readonly WakeItem[]
  /** True when a needed wake was suppressed ONLY by the max_rounds cap. */
  capExceeded: boolean
}

export type WorkgroupOutcome =
  | { kind: 'running' } // something is (or will be) in flight
  | { kind: 'done' }
  | { kind: 'awaiting_gate' } // completion gate parked for human confirmation
  | {
      kind: 'awaiting_human'
      // RFC-187 §3-7 — `max-rounds-wrapup`: hit the cap WITH completed work the leader
      // never aggregated; park (deliverable visible via diff) instead of hard-failing.
      reason: 'clarify-or-delivery' | 'leader-idle' | 'leader-clarify' | 'max-rounds-wrapup'
    }
  | { kind: 'leader-nudge'; nudgeCount: number } // RFC-180 autonomous: auto-remind an idle leader
  | { kind: 'failed'; reason: 'max-rounds' | 'fc-deadlock' }

/**
 * RFC-187 §3-7 — completed work that would be lost if the task hard-failed at the round
 * cap. `done` (leader_worker: aggregated-pending) or `delivered` (human handoff consumed
 * next leader turn) assignments mean a deliverable exists in the worktree; probe C
 * produced hello.txt then the task `failed` on maxRounds:1 with that file in canonical.
 */
function hasSalvageableWork(input: WakeInput): boolean {
  return input.assignments.some((a) => a.status === 'done' || a.status === 'delivered')
}

/**
 * RFC-180 — the auto-nudge an「全自动」leader gets on an idle round (posted as a
 * system chat directed at the leader). Identifying nudges by this exact body is
 * the single source both the poster (runner) and the counter (below) share.
 */
export const WG_NUDGE_BODY =
  'Autonomous mode: you ended a round without dispatching work or declaring done. If the goal is complete, emit wg_decision done; otherwise dispatch the next assignment(s) or say what is blocking.'

/** Consecutive trailing system-nudge messages = consecutive no-progress rounds. */
function countTrailingNudges(messages: readonly WorkgroupMessage[]): number {
  let n = 0
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as WorkgroupMessage
    if (m.authorKind === 'system' && m.bodyMd === WG_NUDGE_BODY) n++
    else break
  }
  return n
}

function agentMemberIds(config: WorkgroupRuntimeConfig): string[] {
  return config.members.filter((m) => m.memberType === 'agent').map((m) => m.id)
}

function isAgentAssignee(config: WorkgroupRuntimeConfig, a: WorkgroupAssignment): boolean {
  if (a.assigneeMemberId === null) return false
  return config.members.some((m) => m.id === a.assigneeMemberId && m.memberType === 'agent')
}

function hasUnconsumed(input: WakeInput, memberId: string): boolean {
  const cursor = input.cursors.get(memberId) ?? ''
  // Self-authored messages are OUTPUT, not input — a leader's own dispatch
  // notes must not re-wake it (the engine advances cursors BEFORE the run,
  // so a turn's own writes land after its cursor).
  return sliceMessagesAfter(input.messages, cursor).some(
    (m: WorkgroupMessage) => m.authorMemberId !== memberId,
  )
}

function hasUnconsumedMention(input: WakeInput, memberId: string): boolean {
  const cursor = input.cursors.get(memberId) ?? ''
  return sliceMessagesAfter(input.messages, cursor).some(
    (m: WorkgroupMessage) => m.mentionMemberIds.includes(memberId) && m.authorMemberId !== memberId,
  )
}

/** Member ids that currently have an active (dispatched/running/awaiting) assignment. */
function busyMemberIds(input: WakeInput): Set<string> {
  const busy = new Set<string>()
  for (const a of input.assignments) {
    if (a.assigneeMemberId === null) continue
    if (a.status === 'dispatched' || a.status === 'running' || a.status === 'awaiting_human') {
      busy.add(a.assigneeMemberId)
    }
  }
  for (const id of input.inFlight.messageTurnMemberIds) busy.add(id)
  return busy
}

export function deriveWakeSet(input: WakeInput): WakeSet {
  const { config } = input
  const switches = resolveWorkgroupSwitches(config.mode, config.switches)
  const items: WakeItem[] = []
  let capExceeded = false

  // Gate parked: nothing runs until the human decides (design §8.2).
  if (input.gate.awaitingConfirmation) return { items: [], capExceeded: false }

  // 1. Dispatched agent assignments start immediately (both modes, §4.2).
  for (const a of input.assignments) {
    if (a.status !== 'dispatched') continue
    if (!isAgentAssignee(config, a)) continue // human assignments wait for delivery
    if (input.inFlight.runningAssignmentIds.has(a.id)) continue
    if (config.mode === 'free_collab' && input.roundsUsed + items.length >= config.maxRounds) {
      capExceeded = true
      continue
    }
    items.push({ kind: 'assignment', assignmentId: a.id })
  }

  // 2. Message turns (direct_messages gated, both modes, §6.3).
  if (switches.directMessages) {
    const busy = busyMemberIds(input)
    for (const memberId of agentMemberIds(config)) {
      if (config.mode === 'leader_worker' && memberId === config.leaderMemberId) continue
      if (busy.has(memberId)) continue
      if (!hasUnconsumedMention(input, memberId)) continue
      if (config.mode === 'free_collab' && input.roundsUsed + items.length >= config.maxRounds) {
        capExceeded = true
        continue
      }
      items.push({ kind: 'message_turn', memberId })
    }
  }

  if (config.mode === 'leader_worker') {
    // 3lw. Leader batch-wake: no agent assignment still dispatched/running and
    // (initial | new content since the leader's cursor | gate rejection).
    const leaderId = config.leaderMemberId
    // RFC-187 F3 — a leader parked on a clarify must NOT be re-driven; it resumes
    // via the human's answer (clarify-answer rerun), not a fresh wake.
    if (leaderId !== null && !input.inFlight.leaderRunning && input.leaderClarifyParked !== true) {
      const blocking = input.assignments.some(
        (a) => isAgentAssignee(config, a) && (a.status === 'dispatched' || a.status === 'running'),
      )
      const anyPending = items.some((i) => i.kind === 'assignment')
      if (!blocking && !anyPending && !input.gate.declaredDone) {
        const initial = input.roundsUsed === 0
        const reason: 'initial' | 'new-content' | 'gate-rejected' | null = initial
          ? 'initial'
          : input.gate.rejected
            ? 'gate-rejected'
            : hasUnconsumed(input, leaderId)
              ? 'new-content'
              : null
        if (reason !== null) {
          if (input.roundsUsed >= config.maxRounds) {
            // RFC-187 §3-7 — grant ONE grace wrap-up round exactly AT the cap when
            // there's completed work to aggregate, so the leader can declare done
            // rather than the task hard-failing with a deliverable in hand. Counted,
            // so roundsUsed > maxRounds next pass ⇒ no second grace round.
            if (input.roundsUsed === config.maxRounds && hasSalvageableWork(input)) {
              items.push({ kind: 'leader', reason: 'wrap-up' })
            } else {
              capExceeded = true
            }
          } else {
            items.push({ kind: 'leader', reason })
          }
        }
      }
    }
  } else {
    // 3fc. Initial planning burst: every agent member, in parallel (决策 #17).
    const nothingStarted =
      input.roundsUsed === 0 &&
      input.assignments.length === 0 &&
      input.inFlight.runningAssignmentIds.size === 0 &&
      input.inFlight.messageTurnMemberIds.size === 0
    if (nothingStarted) {
      for (const memberId of agentMemberIds(config)) {
        if (input.roundsUsed + items.length >= config.maxRounds) {
          capExceeded = true
          break
        }
        items.push({ kind: 'fc_initial', memberId })
      }
      return { items, capExceeded }
    }

    // 4fc. Platform claims open tasks for idle agent members (CAS at the
    // engine layer makes it race-free; here we just pair deterministically:
    // open tasks in creation order × idle members in roster order, one each).
    const busy = busyMemberIds(input)
    const claimedThisWake = new Set<string>()
    const open = input.assignments.filter((a) => a.status === 'open')
    for (const a of open) {
      const member = agentMemberIds(config).find((id) => !busy.has(id) && !claimedThisWake.has(id))
      if (member === undefined) break
      if (input.roundsUsed + items.length >= config.maxRounds) {
        capExceeded = true
        break
      }
      claimedThisWake.add(member)
      items.push({ kind: 'fc_claim', memberId: member, assignmentId: a.id })
    }
  }

  return { items, capExceeded }
}

/**
 * Terminal decision — only meaningful when the wake set is empty AND nothing
 * is in flight; callers with a non-empty wake set keep running.
 */
export function decideWorkgroupOutcome(input: WakeInput, wake: WakeSet): WorkgroupOutcome {
  if (
    wake.items.length > 0 ||
    input.inFlight.leaderRunning ||
    input.inFlight.runningAssignmentIds.size > 0 ||
    input.inFlight.messageTurnMemberIds.size > 0
  ) {
    return { kind: 'running' }
  }
  // RFC-187 F3 — leader parked on a clarify: surface awaiting_human so a human can
  // answer (takes precedence over max_rounds — a blocked leader isn't a failure).
  if (input.leaderClarifyParked === true) {
    return { kind: 'awaiting_human', reason: 'leader-clarify' }
  }
  if (input.gate.awaitingConfirmation) return { kind: 'awaiting_gate' }
  if (wake.capExceeded) {
    // RFC-187 §3-7 — hit the cap. If completed work exists (a grace wrap-up round
    // already ran or the leader dispatched instead of declaring done), park for a
    // human with the deliverable intact rather than a bare `failed` that reads as
    // "nothing produced" (probe C). Only a genuine no-output spin hard-fails.
    if (hasSalvageableWork(input)) {
      return { kind: 'awaiting_human', reason: 'max-rounds-wrapup' }
    }
    return { kind: 'failed', reason: 'max-rounds' }
  }

  const humanPending = input.assignments.some(
    (a) =>
      a.status === 'awaiting_human' ||
      (a.status === 'dispatched' && !isAgentAssignee(input.config, a)),
  )

  if (input.config.mode === 'leader_worker') {
    if (input.gate.declaredDone) {
      // RFC-180: autonomous treats the gate as off (leader-done finishes directly).
      return resolveCompletionGate(input.config.autonomous ?? false, input.config.completionGate)
        ? { kind: 'awaiting_gate' }
        : { kind: 'done' }
    }
    if (humanPending) return { kind: 'awaiting_human', reason: 'clarify-or-delivery' }
    // Leader consumed everything, dispatched nothing, declared nothing.
    // RFC-180: an autonomous group auto-nudges the leader (up to N consecutive
    // no-progress rounds) before parking; a non-autonomous group parks for a
    // human nudge right away (a room message re-wakes the leader) — design §4.2.
    if (input.config.autonomous ?? false) {
      const nudges = countTrailingNudges(input.messages)
      if (nudges < WG_AUTONOMOUS_NUDGE_LIMIT) return { kind: 'leader-nudge', nudgeCount: nudges }
    }
    return { kind: 'awaiting_human', reason: 'leader-idle' }
  }

  // free_collab convergence (design §4.4): list drained + nothing unconsumed.
  const openOrActive = input.assignments.some(
    (a) =>
      a.status === 'open' ||
      a.status === 'dispatched' ||
      a.status === 'running' ||
      a.status === 'awaiting_human' ||
      a.status === 'delivered',
  )
  if (!openOrActive) {
    return { kind: 'done' }
  }
  if (humanPending) return { kind: 'awaiting_human', reason: 'clarify-or-delivery' }
  const openLeft = input.assignments.some((a) => a.status === 'open')
  if (openLeft) return { kind: 'failed', reason: 'fc-deadlock' }
  // delivered-but-unconsumed etc. resolve on the next engine pass; treat as
  // human-pending parking rather than a hard failure.
  return { kind: 'awaiting_human', reason: 'clarify-or-delivery' }
}

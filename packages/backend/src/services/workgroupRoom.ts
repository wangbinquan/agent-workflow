// RFC-179 — workgroup room runtime visibility: derive each member's "current
// session run" from the task's host node_runs, so the room can make members
// clickable (→ Session drawer) and show an executing indicator. Pure +
// read-only (design §2.1 / §5); the result NEVER feeds a prompt (design §11
// prompt-isolation invariant) — it is room/UI rendering only.
//
// Run classification is by `rerun_cause` (the authoritative kind marker, set at
// mint time — nodeRunMint.ts:177 maps `cause`→`rerun_cause`):
//   __wg_leader__ + wg-leader-round → leader-round (wg-gate holder runs skipped)
//   __wg_member__ + wg-assignment   → assignment    (shardKey = assignment.id)
//   __wg_member__ + wg-message-turn → message-turn  (shardKey = msg:${memberId}:${maxMsgId})

import type { WorkgroupMemberCurrentRun, WorkgroupRunKind } from '@agent-workflow/shared'
import { WG_LEADER_NODE_ID, WG_MEMBER_NODE_ID } from './workgroupLaunch'

/** Minimal node_run shape the derivation reads (subset of the DB row). */
export interface HostRunLite {
  id: string
  nodeId: string
  shardKey: string | null
  status: string
  rerunCause: string | null
}
export interface AssignmentLite {
  id: string
  assigneeMemberId: string | null
}
export interface MessageLite {
  id: string
  mentionMemberIds: readonly string[]
}
export interface MemberLite {
  id: string
  memberType: 'agent' | 'human'
}

// message-turn shardKey format: `msg:${memberId}:${maxMsgId}` (workgroupRunner.ts:1251).
// memberId is a colon-free ULID; maxMsgId is a ULID or '0'. A drift in this
// format is locked by the shardKey-prefix contract test (design §8.2).
const MESSAGE_TURN_SHARD_RE = /^msg:([^:]+):(.*)$/

function runKindOf(run: HostRunLite): WorkgroupRunKind | null {
  if (run.nodeId === WG_LEADER_NODE_ID) {
    // wg-gate is the completion-gate holder run, not a leader thinking round
    // (aligns with workgroupRunner.ts:361).
    return run.rerunCause === 'wg-gate' ? null : 'leader-round'
  }
  if (run.nodeId === WG_MEMBER_NODE_ID) {
    if (run.rerunCause === 'wg-assignment') return 'assignment'
    if (run.rerunCause === 'wg-message-turn') return 'message-turn'
  }
  return null
}

interface ClassifiedRun {
  run: HostRunLite
  kind: WorkgroupRunKind
  memberId: string
  maxMsgId: string | null
}

function classify(
  run: HostRunLite,
  leaderMemberId: string | null,
  assignmentToMember: ReadonlyMap<string, string | null>,
): ClassifiedRun | null {
  const kind = runKindOf(run)
  if (kind === null) return null
  if (kind === 'leader-round') {
    if (leaderMemberId === null) return null
    return { run, kind, memberId: leaderMemberId, maxMsgId: null }
  }
  if (kind === 'assignment') {
    const memberId = run.shardKey ? (assignmentToMember.get(run.shardKey) ?? null) : null
    if (memberId === null) return null
    return { run, kind, memberId, maxMsgId: null }
  }
  // message-turn
  const m = run.shardKey ? MESSAGE_TURN_SHARD_RE.exec(run.shardKey) : null
  if (m === null) return null
  const memberId = m[1] ?? ''
  if (memberId.length === 0) return null
  return { run, kind, memberId, maxMsgId: m[2] ?? null }
}

/** running wins; else newest by id (ULID monotonic) — pending or terminal. */
function isBetter(candidate: ClassifiedRun, incumbent: ClassifiedRun): boolean {
  const cRun = candidate.run.status === 'running'
  const iRun = incumbent.run.status === 'running'
  if (cRun !== iRun) return cRun
  return candidate.run.id > incumbent.run.id
}

/** The @-mention that woke a message-turn: newest message ≤ maxMsgId mentioning the member. */
function resolveTriggerMessageId(
  memberId: string,
  maxMsgId: string | null,
  messages: readonly MessageLite[],
): string | null {
  if (maxMsgId === null || maxMsgId.length === 0 || maxMsgId === '0') return null
  let best: string | null = null
  for (const m of messages) {
    if (m.id > maxMsgId) continue
    if (!m.mentionMemberIds.includes(memberId)) continue
    if (best === null || m.id > best) best = m.id
  }
  return best
}

/**
 * Map every member to its current session run (RFC-179 §2.1). Agent members with
 * no host run — and all human members (no agent run) — map to `null`.
 */
export function deriveMemberCurrentRuns(
  members: readonly MemberLite[],
  leaderMemberId: string | null,
  hostRuns: readonly HostRunLite[],
  assignments: readonly AssignmentLite[],
  messages: readonly MessageLite[],
): Record<string, WorkgroupMemberCurrentRun | null> {
  const assignmentToMember = new Map<string, string | null>(
    assignments.map((a) => [a.id, a.assigneeMemberId]),
  )
  // Winning classified run per member.
  const winners = new Map<string, ClassifiedRun>()
  for (const run of hostRuns) {
    const cr = classify(run, leaderMemberId, assignmentToMember)
    if (cr === null) continue
    const incumbent = winners.get(cr.memberId)
    if (incumbent === undefined || isBetter(cr, incumbent)) winners.set(cr.memberId, cr)
  }

  const out: Record<string, WorkgroupMemberCurrentRun | null> = {}
  for (const member of members) {
    // Human members never own an agent run; be defensive even if one leaked.
    const cr = member.memberType === 'agent' ? winners.get(member.id) : undefined
    if (cr === undefined) {
      out[member.id] = null
      continue
    }
    out[member.id] = {
      nodeRunId: cr.run.id,
      status: cr.run.status,
      kind: cr.kind,
      triggerMessageId:
        cr.kind === 'message-turn'
          ? resolveTriggerMessageId(member.id, cr.maxMsgId, messages)
          : null,
    }
  }
  return out
}

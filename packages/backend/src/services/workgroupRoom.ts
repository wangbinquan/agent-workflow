// RFC-179 / RFC-182 — workgroup room runtime visibility: derive the room's
// FULL execution history (`runHistory`, RFC-182 G5 single source) and each
// member's "current session run" (`memberRuns`, a projection of the history —
// running wins, else newest) from the task's host node_runs. Pure + read-only;
// the result NEVER feeds a prompt (design §11 prompt-isolation invariant) —
// it is room/UI rendering only.
//
// Run classification is by nodeId + shardKey SHAPE (RFC-182 design-gate P1 —
// NOT by rerun_cause: a clarify-answer host rerun keeps its shard lineage but
// carries `rerunCause='clarify-answer'`, and a cause-keyed classifier drops
// the resumed session from history AND memberRuns — the member looks idle
// while its resumed run executes):
//   __wg_leader__  (rerunCause≠wg-gate)      → leader-round
//   __wg_member__ + shardKey `msg:*`         → message-turn (msg:${memberId}:${maxMsgId})
//   __wg_member__ + shardKey ∈ assignment id → assignment
// `wg-gate` stays a cause-based EXCLUSION (the completion-gate holder run is
// not a leader thinking round — aligns with workgroupRunner.ts:361).

import type {
  WorkgroupMemberCurrentRun,
  WorkgroupRunEntry,
  WorkgroupRunKind,
} from '@agent-workflow/shared'
import { WG_LEADER_NODE_ID, WG_MEMBER_NODE_ID } from './workgroupLaunch'

/** Minimal node_run shape the derivation reads (subset of the DB row). The
 *  RFC-182 columns are optional so RFC-179-era callers/fixtures stay valid —
 *  absent ⇒ the entry carries nulls (ordering falls back to id ULIDs). */
export interface HostRunLite {
  id: string
  nodeId: string
  shardKey: string | null
  status: string
  rerunCause: string | null
  startedAt?: number | null
  finishedAt?: number | null
  /** RFC-181 C closure column — feeds the `note` derivation only. Structured
   *  by design: RFC-145 forbids machine reads of errorMessage, and BOTH
   *  suppression paths (runNode envelope-time rejection + the hook's
   *  late-toggle correction) stamp failure_code='clarify-forbidden'. */
  failureCode?: string | null
  /** Immutable per-attempt agent identity (stamped at mint) — the fc
   *  attribution fallback when the card's mutable assignee is gone. */
  agentOverrideName?: string | null
}
export interface AssignmentLite {
  id: string
  /** CURRENT assignee — mutable in free-collab (failed→open recycling nulls
   *  it and a re-claim rewrites it), so historical attribution must not lean
   *  on it alone (impl-gate P2; see the agentOverrideName fallback). */
  assigneeMemberId: string | null
}
export interface MessageLite {
  id: string
  mentionMemberIds: readonly string[]
}
export interface MemberLite {
  id: string
  memberType: 'agent' | 'human'
  /** RFC-182 — frozen onto history entries; optional for RFC-179-era fixtures. */
  displayName?: string
  /** RFC-182 impl-gate P2 — feeds the fc attribution fallback (see below). */
  agentName?: string | null
}

// message-turn shardKey format: `msg:${memberId}:${maxMsgId}` (workgroupRunner.ts:1251).
// memberId is a colon-free ULID; maxMsgId is a ULID or '0'. A drift in this
// format is locked by the shardKey-prefix contract test (design §8.2).
const MESSAGE_TURN_SHARD_RE = /^msg:([^:]+):(.*)$/

function runKindOf(run: HostRunLite, assignmentIds: ReadonlySet<string>): WorkgroupRunKind | null {
  if (run.nodeId === WG_LEADER_NODE_ID) {
    // wg-gate is the completion-gate holder run, not a leader thinking round.
    return run.rerunCause === 'wg-gate' ? null : 'leader-round'
  }
  if (run.nodeId === WG_MEMBER_NODE_ID && run.shardKey !== null) {
    if (MESSAGE_TURN_SHARD_RE.test(run.shardKey)) return 'message-turn'
    if (assignmentIds.has(run.shardKey)) return 'assignment'
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
  assignmentIds: ReadonlySet<string>,
  uniqueAgentMember: ReadonlyMap<string, string | null>,
): ClassifiedRun | null {
  const kind = runKindOf(run, assignmentIds)
  if (kind === null) return null
  if (kind === 'leader-round') {
    if (leaderMemberId === null) return null
    return { run, kind, memberId: leaderMemberId, maxMsgId: null }
  }
  if (kind === 'assignment') {
    // Impl-gate P2 — the card's assignee is MUTABLE in free-collab (a failed
    // card recycles with assignee=null and may be re-claimed by someone
    // else), so a historical attempt attributes through the card only while
    // that is intact, then falls back to the run's IMMUTABLE mint-time agent
    // identity — resolvable when exactly one member runs that agent
    // (ambiguous rosters drop the entry rather than mislabel it).
    const viaCard = run.shardKey ? (assignmentToMember.get(run.shardKey) ?? null) : null
    const viaAgent =
      run.agentOverrideName != null ? (uniqueAgentMember.get(run.agentOverrideName) ?? null) : null
    const memberId = viaCard ?? viaAgent
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
function isBetter(candidate: WorkgroupRunEntry, incumbent: WorkgroupRunEntry): boolean {
  const cRun = candidate.status === 'running'
  const iRun = incumbent.status === 'running'
  if (cRun !== iRun) return cRun
  return candidate.nodeRunId > incumbent.nodeRunId
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

/** RFC-181 C closure → display note, keyed ONLY on the structured
 *  failure_code column (RFC-145 ratchet: errorMessage is human breadcrumbs,
 *  never a machine routing key). The wire carries just the enum (D11). */
function noteOf(run: HostRunLite): WorkgroupRunEntry['note'] {
  return run.failureCode === 'clarify-forbidden' ? 'clarify-suppressed' : null
}

/**
 * RFC-182 G5 — the room's full execution history: every classified host turn,
 * ascending by nodeRunId (= mint order). Entries for removed members keep the
 * memberId with `displayName: null` (tombstone label in the UI).
 */
export function deriveWorkgroupRunHistory(
  members: readonly MemberLite[],
  leaderMemberId: string | null,
  hostRuns: readonly HostRunLite[],
  assignments: readonly AssignmentLite[],
  messages: readonly MessageLite[],
): WorkgroupRunEntry[] {
  const assignmentToMember = new Map<string, string | null>(
    assignments.map((a) => [a.id, a.assigneeMemberId]),
  )
  const assignmentIds = new Set(assignments.map((a) => a.id))
  const nameOf = new Map(members.map((m) => [m.id, m.displayName ?? null]))
  // agentName → memberId when exactly ONE agent member runs that agent;
  // ambiguous names map to null (drop-not-mislabel, impl-gate P2).
  const uniqueAgentMember = new Map<string, string | null>()
  for (const m of members) {
    if (m.memberType !== 'agent' || m.agentName == null) continue
    uniqueAgentMember.set(m.agentName, uniqueAgentMember.has(m.agentName) ? null : m.id)
  }

  const classified: ClassifiedRun[] = []
  for (const run of hostRuns) {
    const cr = classify(run, leaderMemberId, assignmentToMember, assignmentIds, uniqueAgentMember)
    if (cr !== null) classified.push(cr)
  }
  classified.sort((a, b) => (a.run.id < b.run.id ? -1 : a.run.id > b.run.id ? 1 : 0))

  let leaderOrdinal = 0
  return classified.map((cr) => {
    const round = cr.kind === 'leader-round' ? ++leaderOrdinal : null
    return {
      nodeRunId: cr.run.id,
      memberId: cr.memberId,
      displayName: nameOf.get(cr.memberId) ?? null,
      kind: cr.kind,
      status: cr.run.status,
      round,
      startedAt: cr.run.startedAt ?? null,
      finishedAt: cr.run.finishedAt ?? null,
      triggerMessageId:
        cr.kind === 'message-turn'
          ? resolveTriggerMessageId(cr.memberId, cr.maxMsgId, messages)
          : null,
      assignmentId: cr.kind === 'assignment' ? cr.run.shardKey : null,
      note: noteOf(cr.run),
    }
  })
}

/**
 * Map every member to its current session run (RFC-179 §2.1) — since RFC-182
 * a pure PROJECTION of `deriveWorkgroupRunHistory` (running wins; else newest
 * by id), so history and currentRun can never drift. Agent members with no
 * host run — and all human members (no agent run) — map to `null`.
 */
export function deriveMemberCurrentRuns(
  members: readonly MemberLite[],
  leaderMemberId: string | null,
  hostRuns: readonly HostRunLite[],
  assignments: readonly AssignmentLite[],
  messages: readonly MessageLite[],
): Record<string, WorkgroupMemberCurrentRun | null> {
  const history = deriveWorkgroupRunHistory(
    members,
    leaderMemberId,
    hostRuns,
    assignments,
    messages,
  )
  const winners = new Map<string, WorkgroupRunEntry>()
  for (const entry of history) {
    const incumbent = winners.get(entry.memberId)
    if (incumbent === undefined || isBetter(entry, incumbent)) winners.set(entry.memberId, entry)
  }

  const out: Record<string, WorkgroupMemberCurrentRun | null> = {}
  for (const member of members) {
    // Human members never own an agent run; be defensive even if one leaked.
    const entry = member.memberType === 'agent' ? winners.get(member.id) : undefined
    out[member.id] =
      entry === undefined
        ? null
        : {
            nodeRunId: entry.nodeRunId,
            status: entry.status,
            kind: entry.kind,
            triggerMessageId: entry.triggerMessageId,
          }
  }
  return out
}

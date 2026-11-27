// RFC-616 §3.3 — which member a workgroup host run belongs to.
//
// One rule, two consumers: the task room's run history (resource-catalog) and
// the process metrics' per-member statistics (task-execution facts). It used to
// live inside the room projection; the two contexts may not import each other,
// so the pure rule lives here and both read it.
//
// The rule never uses an assignment's current assignee: that field is mutable
// (a card can be handed to someone else), while a run's attribution is history.

import { parseBatchShardKey, parseMsgShardKey } from './schemas/workgroup'
import type { WorkgroupRunKind } from './schemas/workgroupRuntime'
import {
  WORKGROUP_TURN_LEADER_NODE_ID,
  WORKGROUP_TURN_MEMBER_NODE_ID,
} from './workgroupHostIdentity'

/** The fields of a host run the rule reads. */
export interface WorkgroupHostRunIdentity {
  readonly nodeId: string
  readonly shardKey: string | null
  readonly rerunCause: string | null
  /** Canonical agent id the run executed with; display names never drive attribution. */
  readonly agentOverrideId?: string | null
}

export interface WorkgroupHostRunAttribution {
  readonly kind: WorkgroupRunKind
  readonly memberId: string
  /** Message turns freeze the newest message they saw. */
  readonly maxMsgId: string | null
}

/** The roster facts the rule reads. */
export interface WorkgroupHostRunRoster {
  readonly leaderMemberId: string | null
  readonly assignmentIds: ReadonlySet<string>
  /** agent id → the one member using it, or null when several members share it. */
  readonly uniqueAgentMemberById: ReadonlyMap<string, string | null>
}

/**
 * agent id → member id for agents used by exactly one member; an agent shared
 * by several members maps to null (its single-card runs cannot be attributed).
 */
export function uniqueAgentMembersOf(
  members: readonly {
    readonly id: string
    readonly memberType: 'agent' | 'human'
    readonly agentId?: string | null
  }[],
): Map<string, string | null> {
  const unique = new Map<string, string | null>()
  for (const member of members) {
    if (member.memberType !== 'agent' || member.agentId == null) continue
    unique.set(member.agentId, unique.has(member.agentId) ? null : member.id)
  }
  return unique
}

/** What kind of turn a host run is; null for rows that are not a member's turn. */
export function workgroupHostRunKindOf(
  run: WorkgroupHostRunIdentity,
  assignmentIds: ReadonlySet<string>,
): WorkgroupRunKind | null {
  if (run.nodeId === WORKGROUP_TURN_LEADER_NODE_ID) {
    // wg-gate is the completion-gate holder run, not a leader thinking round.
    return run.rerunCause === 'wg-gate' ? null : 'leader-round'
  }
  if (run.nodeId === WORKGROUP_TURN_MEMBER_NODE_ID && run.shardKey !== null) {
    if (parseMsgShardKey(run.shardKey) !== null) return 'message-turn'
    if (assignmentIds.has(run.shardKey)) return 'assignment'
    // Batch rows freeze the member identity in their shard key.
    if (parseBatchShardKey(run.shardKey) !== null) return 'assignment'
  }
  return null
}

/** The member a host run belongs to; null when it is not a turn or cannot be attributed. */
export function attributeWorkgroupHostRun(
  run: WorkgroupHostRunIdentity,
  roster: WorkgroupHostRunRoster,
): WorkgroupHostRunAttribution | null {
  const kind = workgroupHostRunKindOf(run, roster.assignmentIds)
  if (kind === null) return null
  if (kind === 'leader-round') {
    if (roster.leaderMemberId === null) return null
    return { kind, memberId: roster.leaderMemberId, maxMsgId: null }
  }
  if (kind === 'assignment') {
    const viaBatch = parseBatchShardKey(run.shardKey)?.memberId ?? null
    const viaAgent =
      run.agentOverrideId != null
        ? (roster.uniqueAgentMemberById.get(run.agentOverrideId) ?? null)
        : null
    const memberId = viaBatch ?? viaAgent
    if (memberId === null) return null
    return { kind, memberId, maxMsgId: null }
  }

  const parsed = run.shardKey === null ? null : parseMsgShardKey(run.shardKey)
  if (parsed === null || parsed.memberId.length === 0) return null
  return { kind, memberId: parsed.memberId, maxMsgId: parsed.maxMessageId }
}

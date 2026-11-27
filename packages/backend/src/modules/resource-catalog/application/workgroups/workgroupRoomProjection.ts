// Provider-neutral workgroup room projection.
//
// These helpers deliberately consume closed, data-only snapshots. SQLite and
// PostgreSQL room adapters therefore share one history/current-run/budget
// grammar without either provider importing the other's infrastructure.

import {
  attributeWorkgroupHostRun,
  uniqueAgentMembersOf,
  WORKGROUP_TURN_LEADER_NODE_ID,
  WORKGROUP_TURN_MEMBER_NODE_ID,
  type WorkgroupHostRunRoster,
  type WorkgroupMemberCurrentRun,
  type WorkgroupMode,
  type WorkgroupRunEntry,
  type WorkgroupRunKind,
} from '@agent-workflow/shared'

/**
 * RFC-229 — authoritative direct parent for a message turn. The turn's shard
 * freezes maxMsgId, so fresh and adopted continuations resolve identically.
 *
 * RFC-411: moved here from the turn context (now task-execution); the room projection is its only caller.
 */
export function resolveMessageTurnTriggerId(
  memberId: string,
  maxMsgId: string | null,
  messages: readonly {
    id: string
    authorMemberId: string | null
    mentionMemberIds: readonly string[]
  }[],
): string | null {
  if (maxMsgId === null || maxMsgId.length === 0 || maxMsgId === '0') return null
  let best: string | null = null
  for (const message of messages) {
    if (message.id > maxMsgId) continue
    if (message.authorMemberId === memberId) continue
    if (!message.mentionMemberIds.includes(memberId)) continue
    if (best === null || message.id > best) best = message.id
  }
  return best
}

/**
 * RFC-570: the run-selection facts this projection reads off a host run — its own shape. Task Execution computes the
 * selection and hands rows carrying its full projection; these two fields are all the room and budget grammar uses.
 */
export interface WorkgroupRoomRunSelection {
  readonly sequence: number
  readonly legacyGroupCurrent: boolean
}

/** Minimal host-run snapshot consumed by the room projection. */
export interface WorkgroupRoomHostRun {
  readonly selection: WorkgroupRoomRunSelection
  readonly seq: number
  readonly id: string
  readonly nodeId: string
  readonly shardKey: string | null
  readonly status: string
  readonly rerunCause: string | null
  readonly startedAt?: number | null
  readonly finishedAt?: number | null
  /** Structured failure code; human error text never drives projection. */
  readonly failureCode?: string | null
  /** Display-only snapshot. Attribution always uses agentOverrideId. */
  readonly agentOverrideName?: string | null
  readonly agentOverrideId?: string | null
  /** Authoritative round ordinal. Historical/unadopted rows may omit it. */
  readonly wgRound?: number | null
}

export interface WorkgroupRoomAssignment {
  readonly id: string
  /** Mutable current assignee; historical attribution never depends on it. */
  readonly assigneeMemberId: string | null
}

export interface WorkgroupRoomMessage {
  readonly id: string
  readonly mentionMemberIds: readonly string[]
  readonly authorMemberId: string | null
  /** Historical fixtures may omit the round. */
  readonly round?: number
}

export interface WorkgroupRoomMember {
  readonly id: string
  readonly memberType: 'agent' | 'human'
  readonly displayName?: string
  readonly agentName?: string | null
  /** Canonical agent id frozen at launch. */
  readonly agentId?: string | null
}

// Compatibility aliases retained for existing callers of legacy room.ts.
export type HostRunLite = WorkgroupRoomHostRun
export type AssignmentLite = WorkgroupRoomAssignment
export type MessageLite = WorkgroupRoomMessage
export type MemberLite = WorkgroupRoomMember

export interface StoredWorkgroupTemplateMetadata {
  readonly key: string
  readonly params: Readonly<Record<string, unknown>>
}

/**
 * Rolling-wire decoder. Unknown future keys remain representable so clients
 * can fall back to the durable body text.
 */
export function parseStoredTemplateMetadata(
  key: string | null,
  paramsJson: string | null,
): StoredWorkgroupTemplateMetadata | null {
  if (key === null || paramsJson === null || !/^[A-Za-z0-9._-]{1,64}$/.test(key)) return null
  try {
    const params = JSON.parse(paramsJson) as unknown
    if (params === null || typeof params !== 'object' || Array.isArray(params)) return null
    return { key, params: params as Record<string, unknown> }
  } catch {
    return null
  }
}

interface ClassifiedRun {
  readonly run: WorkgroupRoomHostRun
  readonly kind: WorkgroupRunKind
  readonly memberId: string
  readonly maxMsgId: string | null
}

// RFC-616: the attribution rule itself lives in shared (`workgroupHostRun.ts`) so process metrics
// read the same one; this projection only pairs the result with its run snapshot.
function classify(run: WorkgroupRoomHostRun, roster: WorkgroupHostRunRoster): ClassifiedRun | null {
  const attribution = attributeWorkgroupHostRun(run, roster)
  return attribution === null ? null : { run, ...attribution }
}

function isBetter(
  candidate: WorkgroupRunEntry,
  incumbent: WorkgroupRunEntry,
  hostRuns: readonly WorkgroupRoomHostRun[],
): boolean {
  const candidateRunning = candidate.status === 'running'
  const incumbentRunning = incumbent.status === 'running'
  return candidateRunning !== incumbentRunning
    ? candidateRunning
    : hostRuns.find((run) => run.id === candidate.nodeRunId)!.selection.sequence >
        hostRuns.find((run) => run.id === incumbent.nodeRunId)!.selection.sequence
}

function noteOf(run: WorkgroupRoomHostRun): WorkgroupRunEntry['note'] {
  return run.failureCode === 'clarify-forbidden' ? 'clarify-suppressed' : null
}

/**
 * Full execution history, ascending by node-run mint order. Removed members retain a
 * tombstone memberId with displayName=null.
 */
export function deriveWorkgroupRunHistory(
  members: readonly WorkgroupRoomMember[],
  leaderMemberId: string | null,
  hostRuns: readonly WorkgroupRoomHostRun[],
  assignments: readonly WorkgroupRoomAssignment[],
  messages: readonly WorkgroupRoomMessage[],
  opts: { readonly openClarifySourceRunIds?: ReadonlySet<string> } = {},
): WorkgroupRunEntry[] {
  const assignmentIds = new Set(assignments.map((assignment) => assignment.id))
  const nameOf = new Map(members.map((member) => [member.id, member.displayName ?? null]))
  const roster: WorkgroupHostRunRoster = {
    leaderMemberId,
    assignmentIds,
    uniqueAgentMemberById: uniqueAgentMembersOf(members),
  }

  const classified: ClassifiedRun[] = []
  for (const run of hostRuns) {
    const entry = classify(run, roster)
    if (entry !== null) classified.push(entry)
  }
  classified.sort((left, right) => left.run.selection.sequence - right.run.selection.sequence)

  const leaderRoundOfLegacy = (runId: string): number => {
    let maxRound = 0
    for (const message of messages) {
      if (message.id < runId && (message.round ?? 0) > maxRound) maxRound = message.round ?? 0
    }
    return maxRound + 1
  }
  const open = opts.openClarifySourceRunIds

  return classified.map((entry) => {
    const round =
      entry.kind === 'leader-round'
        ? (entry.run.wgRound ?? leaderRoundOfLegacy(entry.run.id))
        : null
    return {
      nodeRunId: entry.run.id,
      memberId: entry.memberId,
      displayName: nameOf.get(entry.memberId) ?? null,
      kind: entry.kind,
      status: open?.has(entry.run.id) === true ? 'awaiting_human' : entry.run.status,
      round,
      startedAt: entry.run.startedAt ?? null,
      finishedAt: entry.run.finishedAt ?? null,
      triggerMessageId:
        entry.kind === 'message-turn'
          ? resolveMessageTurnTriggerId(entry.memberId, entry.maxMsgId, messages)
          : null,
      assignmentId: entry.kind === 'assignment' ? entry.run.shardKey : null,
      note: noteOf(entry.run),
    }
  })
}

/** Current session run per member, projected from the same full history. */
export function deriveMemberCurrentRuns(
  members: readonly WorkgroupRoomMember[],
  leaderMemberId: string | null,
  hostRuns: readonly WorkgroupRoomHostRun[],
  assignments: readonly WorkgroupRoomAssignment[],
  messages: readonly WorkgroupRoomMessage[],
  opts: { readonly openClarifySourceRunIds?: ReadonlySet<string> } = {},
): Record<string, WorkgroupMemberCurrentRun | null> {
  const history = deriveWorkgroupRunHistory(
    members,
    leaderMemberId,
    hostRuns,
    assignments,
    messages,
    opts,
  )
  const winners = new Map<string, WorkgroupRunEntry>()
  for (const entry of history) {
    const incumbent = winners.get(entry.memberId)
    if (incumbent === undefined || isBetter(entry, incumbent, hostRuns))
      winners.set(entry.memberId, entry)
  }

  const current: Record<string, WorkgroupMemberCurrentRun | null> = {}
  for (const member of members) {
    const entry = member.memberType === 'agent' ? winners.get(member.id) : undefined
    current[member.id] =
      entry === undefined
        ? null
        : {
            nodeRunId: entry.nodeRunId,
            status: entry.status,
            kind: entry.kind,
            triggerMessageId: entry.triggerMessageId,
          }
  }
  return current
}

/** Minimal host-ledger row consumed by the round-budget projection. */
export interface RoundLedgerRow {
  readonly selection: WorkgroupRoomRunSelection
  readonly seq: number
  readonly id: string
  readonly nodeId: string
  readonly shardKey: string | null
  readonly status: string
  readonly rerunCause: string | null
  readonly wgRound: number | null
}

export type RoundedWorkgroupMode = 'leader_worker' | 'free_collab'

export function roundedModeOf(mode: WorkgroupMode): RoundedWorkgroupMode | null {
  return mode === 'leader_worker' || mode === 'free_collab' ? mode : null
}

const CLARIFY_CONTINUATION_CAUSES = new Set(['clarify-answer', 'cross-clarify-questioner-rerun'])

function supersededKilledClarifyIds(rows: readonly RoundLedgerRow[]): Set<string> {
  const superseded = new Set<string>()
  for (const row of rows) {
    if (row.status !== 'interrupted' || !CLARIFY_CONTINUATION_CAUSES.has(row.rerunCause ?? '')) {
      continue
    }
    if (!row.selection.legacyGroupCurrent) superseded.add(row.id)
  }
  return superseded
}

/** Used round budget, shared by room projections and the turn engine. */
export function deriveBudgetUsed(
  mode: RoundedWorkgroupMode,
  rows: readonly RoundLedgerRow[],
): number {
  const superseded = supersededKilledClarifyIds(rows)
  if (mode === 'leader_worker') {
    let maxRound = 0
    let unstampedQualifying = 0
    for (const row of rows) {
      if (row.nodeId !== WORKGROUP_TURN_LEADER_NODE_ID || row.status === 'canceled') continue
      if (superseded.has(row.id)) continue
      if (row.wgRound !== null) {
        if (row.wgRound > maxRound) maxRound = row.wgRound
      } else if (row.rerunCause !== 'wg-gate' && row.rerunCause !== 'wg-protocol-retry') {
        unstampedQualifying++
      }
    }
    return maxRound + unstampedQualifying
  }

  return rows.filter(
    (row) =>
      row.nodeId === WORKGROUP_TURN_MEMBER_NODE_ID &&
      row.status !== 'canceled' &&
      row.status !== 'interrupted' &&
      row.rerunCause !== 'wg-protocol-retry' &&
      !superseded.has(row.id),
  ).length
}

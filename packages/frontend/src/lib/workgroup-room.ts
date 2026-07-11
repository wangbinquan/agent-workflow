// RFC-164 PR-4 — pure helpers for the workgroup task chat room. Mirrors
// lib/workgroup-form: everything that can be a data oracle (timeline
// grouping, dispatch-card joins, @-mention completion, status → chip kind)
// lives here so the vitest matrix runs without rendering WorkgroupRoom.
//
// The wire shapes below mirror GET /api/workgroup-tasks/:taskId/room
// (packages/backend/src/routes/workgroupTasks.ts) — the endpoint serializes
// the shared WorkgroupMessage / WorkgroupAssignment rows minus their
// server-only columns, so the frontend types are `Omit<>`s of the shared
// schemas rather than hand-copied field lists.

import type {
  DwState,
  TaskStatus,
  WorkgroupAssignment,
  WorkgroupAssignmentStatus,
  WorkgroupMessage,
  WorkgroupRuntimeConfig,
  WorkgroupRuntimeMember,
  WorkgroupSwitches,
} from '@agent-workflow/shared'
import type { StatusChipKind } from '@/components/StatusChip'

// ---------------------------------------------------------------------------
// Wire shapes
// ---------------------------------------------------------------------------

/** Message row as the room endpoint returns it (no taskId echo). */
export type WorkgroupRoomMessage = Omit<WorkgroupMessage, 'taskId'>

/** Assignment row as the room endpoint returns it (server-only columns cut). */
export type WorkgroupRoomAssignment = Omit<
  WorkgroupAssignment,
  'taskId' | 'createdByRunId' | 'dedupKey'
>

export interface WorkgroupRoomGate {
  declaredDone: boolean
  awaitingConfirmation: boolean
  rejected: boolean
  summary: string | null
}

export interface WorkgroupRoomResponse {
  taskId: string
  taskStatus: TaskStatus
  config: WorkgroupRuntimeConfig
  gate: WorkgroupRoomGate
  /** RFC-167 — dynamic-workflow state slot (phase / generatedDef / rejection
   *  bookkeeping); null for turn-engine tasks. Drives the orchestration tab. */
  dw: DwState | null
  messages: WorkgroupRoomMessage[]
  assignments: WorkgroupRoomAssignment[]
}

/**
 * Single source for the room's react-query key — the component's useQuery,
 * the send/cancel invalidations AND useTaskSync's wg.* WS rules all build the
 * key here so they can never drift apart.
 */
export function workgroupRoomKey(taskId: string | null): readonly [string, string | null] {
  return ['workgroup-room', taskId] as const
}

// ---------------------------------------------------------------------------
// Timeline (messages ascending + round separators)
// ---------------------------------------------------------------------------

export type RoomTimelineEntry =
  | { type: 'round'; round: number }
  | { type: 'message'; message: WorkgroupRoomMessage }

/**
 * Interleave round separators into the ascending message stream: a separator
 * lands wherever `round` changes between consecutive messages. Round-0 rows
 * (pre-engine prelude — e.g. a human speaking before the first leader turn)
 * get no leading separator; the first round-N (N>0) message earns one.
 * Message ids are ULIDs, so ascending id == ascending time (the endpoint
 * already orders by id; sort defensively anyway).
 */
export function buildRoomTimeline(messages: readonly WorkgroupRoomMessage[]): RoomTimelineEntry[] {
  const sorted = [...messages].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const out: RoomTimelineEntry[] = []
  let prevRound: number | null = null
  for (const m of sorted) {
    const isTransition = prevRound === null ? m.round > 0 : m.round !== prevRound
    if (isTransition) out.push({ type: 'round', round: m.round })
    out.push({ type: 'message', message: m })
    prevRound = m.round
  }
  return out
}

// ---------------------------------------------------------------------------
// Members
// ---------------------------------------------------------------------------

/** Roster lookup keyed by frozen member id. */
export function memberIndex(
  config: Pick<WorkgroupRuntimeConfig, 'members'>,
): Map<string, WorkgroupRuntimeMember> {
  return new Map(config.members.map((m) => [m.id, m]))
}

/**
 * "Working" = the member currently owns at least one live card
 * (running / dispatched — 用户拍板: dispatched counts as busy, the run is
 * about to start or the human owes a delivery). Everything else is idle.
 */
export function memberIsWorking(
  memberId: string,
  assignments: readonly Pick<WorkgroupRoomAssignment, 'assigneeMemberId' | 'status'>[],
): boolean {
  return assignments.some(
    (a) => a.assigneeMemberId === memberId && (a.status === 'running' || a.status === 'dispatched'),
  )
}

// ---------------------------------------------------------------------------
// Dispatch cards
// ---------------------------------------------------------------------------

/**
 * Assignments to render as cards under a `kind==='dispatch'` message.
 *
 * Two producer shapes exist (backend routes/workgroupTasks.ts + workgroupRunner):
 *   - engine dispatches (leader / self_claim) write ONE message per
 *     assignment with `message.assignmentId` set — the direct id link wins.
 *   - a human "@a @b …" POST creates N assignments but a SINGLE message whose
 *     assignmentId only carries the FIRST card. The remaining cards join on
 *     the same-instant tuple (source='human', identical createdAt — the route
 *     reuses one `Date.now()` — and assignee ∈ the message's mentions).
 */
export function assignmentsForMessage(
  message: WorkgroupRoomMessage,
  assignments: readonly WorkgroupRoomAssignment[],
): WorkgroupRoomAssignment[] {
  if (message.kind !== 'dispatch') return []
  const out = new Map<string, WorkgroupRoomAssignment>()
  for (const a of assignments) {
    const direct = message.assignmentId !== null && a.id === message.assignmentId
    const humanSibling =
      message.authorKind === 'human' &&
      a.source === 'human' &&
      a.createdAt === message.createdAt &&
      a.assigneeMemberId !== null &&
      message.mentionMemberIds.includes(a.assigneeMemberId)
    if (direct || humanSibling) out.set(a.id, a)
  }
  return [...out.values()]
}

/** Only queued cards can be canceled (backend CAS: open|dispatched → canceled). */
export function isAssignmentCancelable(status: WorkgroupAssignmentStatus): boolean {
  return status === 'open' || status === 'dispatched'
}

/**
 * Body of the result/delivery message a finished card points at (via
 * `resultMessageId`), for the collapsible result block. Null while the card
 * has no result yet (or the message got lost — render nothing, not a crash).
 */
export function resultBodyFor(
  assignment: Pick<WorkgroupRoomAssignment, 'resultMessageId'>,
  messages: readonly WorkgroupRoomMessage[],
): string | null {
  if (assignment.resultMessageId === null) return null
  return messages.find((m) => m.id === assignment.resultMessageId)?.bodyMd ?? null
}

/**
 * Assignment status → StatusChip semantic color. Same vocabulary as
 * NODE_RUN_STATUS_KIND (lib/noderun-status.ts): queued states are neutral,
 * in-flight is info, human-blocking is warn, terminal good/bad are
 * success/danger.
 */
export const WORKGROUP_ASSIGNMENT_STATUS_KIND: Record<WorkgroupAssignmentStatus, StatusChipKind> = {
  open: 'neutral',
  dispatched: 'neutral',
  running: 'info',
  awaiting_human: 'warn',
  delivered: 'info',
  done: 'success',
  failed: 'danger',
  canceled: 'neutral',
}

export function assignmentStatusToKind(status: WorkgroupAssignmentStatus): StatusChipKind {
  return WORKGROUP_ASSIGNMENT_STATUS_KIND[status]
}

// ---------------------------------------------------------------------------
// Composer
// ---------------------------------------------------------------------------

/**
 * The messages endpoint 409s terminal tasks (done/failed/canceled) — mirror
 * that gate client-side so the composer disables instead of round-tripping.
 * `awaiting_human` / `awaiting_review` / running / pending / interrupted all
 * accept messages (a blackboard post is exactly how a parked task re-wakes).
 */
export function canPostRoomMessage(status: TaskStatus): boolean {
  return status !== 'done' && status !== 'failed' && status !== 'canceled'
}

export interface MentionContext {
  /** Index of the '@' being completed. */
  start: number
  /** Text typed after the '@' so far (may be ''). */
  query: string
}

/**
 * The "@token" the caret is currently inside, or null when the caret is not
 * completing a mention. Token charset mirrors the backend mention parser
 * (`/@([^\s@,]+)/` in routes/workgroupTasks.ts): whitespace / '@' / ','
 * terminate a token, so a caret past any of those is NOT completing.
 */
export function mentionQueryAt(text: string, caret: number): MentionContext | null {
  const upto = text.slice(0, Math.max(0, Math.min(caret, text.length)))
  const at = upto.lastIndexOf('@')
  if (at === -1) return null
  const query = upto.slice(at + 1)
  if (/[\s@,]/.test(query)) return null
  return { start: at, query }
}

/** Roster candidates for a mention query (case-insensitive prefix first, then substring). */
export function mentionCandidates(
  config: Pick<WorkgroupRuntimeConfig, 'members'>,
  query: string,
  limit = 8,
): WorkgroupRuntimeMember[] {
  const q = query.toLowerCase()
  const prefix: WorkgroupRuntimeMember[] = []
  const substr: WorkgroupRuntimeMember[] = []
  for (const m of config.members) {
    const dn = m.displayName.toLowerCase()
    if (dn.startsWith(q)) prefix.push(m)
    else if (q.length > 0 && dn.includes(q)) substr.push(m)
  }
  return [...prefix, ...substr].slice(0, limit)
}

/**
 * Commit a completion: replace the in-progress "@query" (from `ctx.start` to
 * `caret`) with "@displayName " and report the new caret position.
 */
export function applyMention(
  text: string,
  caret: number,
  ctx: MentionContext,
  displayName: string,
): { text: string; caret: number } {
  const before = text.slice(0, ctx.start)
  const after = text.slice(Math.max(ctx.start, Math.min(caret, text.length)))
  const inserted = `@${displayName} `
  return { text: before + inserted + after, caret: before.length + inserted.length }
}

// ---------------------------------------------------------------------------
// PR-5/6 — human delivery, completion gate, fc task list, mid-run config
// ---------------------------------------------------------------------------

/** GET /api/workgroup-tasks/pending-count (inbox third source). */
export interface WorkgroupPendingCount {
  deliveries: number
  gates: number
  total: number
}

/**
 * A card renders in the "human to-do" form (highlight + deliver actions) when
 * its assignee is a HUMAN member and the card sits in `dispatched` (the only
 * status the deliver endpoint's CAS accepts — dispatched→delivered).
 */
export function isHumanDeliveryCard(
  assignment: Pick<WorkgroupRoomAssignment, 'assigneeMemberId' | 'status'>,
  members: ReadonlyMap<string, Pick<WorkgroupRuntimeMember, 'memberType'>>,
): boolean {
  if (assignment.status !== 'dispatched' || assignment.assigneeMemberId === null) return false
  return members.get(assignment.assigneeMemberId)?.memberType === 'human'
}

/** The two delivery shapes (拍板 #16) the deliver endpoint accepts. */
export type WorkgroupDeliverInput =
  | { kind: 'quick'; body: string }
  | { kind: 'form'; summary: string; detail: string }

/**
 * POST body for /assignments/:id/deliver. Quick reply → `{body}`; form →
 * `{summary}` (+ `detail` only when non-blank, so the wire stays minimal and
 * the backend's `summary + \n\n + detail` normalization never sees '').
 */
export function buildDeliverBody(input: WorkgroupDeliverInput): Record<string, unknown> {
  if (input.kind === 'quick') return { body: input.body.trim() }
  const out: Record<string, unknown> = { summary: input.summary.trim() }
  if (input.detail.trim().length > 0) out.detail = input.detail
  return out
}

/**
 * free_collab task-list panel grouping (design §7.3 观测面):
 *   open   — unclaimed, still cancelable;
 *   active — claimed and in flight (dispatched | running | awaiting_human);
 *   done   — consumed results.
 * delivered / failed / canceled rows stay off the panel by design — the
 * dispatch cards in the stream carry those endings.
 */
export interface FcAssignmentGroups {
  open: WorkgroupRoomAssignment[]
  active: WorkgroupRoomAssignment[]
  done: WorkgroupRoomAssignment[]
}

export function groupFcAssignments(
  assignments: readonly WorkgroupRoomAssignment[],
): FcAssignmentGroups {
  const groups: FcAssignmentGroups = { open: [], active: [], done: [] }
  for (const a of assignments) {
    if (a.status === 'open') groups.open.push(a)
    else if (a.status === 'dispatched' || a.status === 'running' || a.status === 'awaiting_human') {
      groups.active.push(a)
    } else if (a.status === 'done') groups.done.push(a)
  }
  return groups
}

// ---------------------------------------------------------------------------
// Mid-run config patch (PUT /api/workgroup-tasks/:taskId/config, design §8.4)
// ---------------------------------------------------------------------------

/** Staged member addition (the wire shape of ConfigPatchSchema.addMembers[i]). */
export interface WorkgroupConfigMemberAdd {
  memberType: 'agent' | 'human'
  agentName?: string
  userId?: string
  displayName: string
  roleDesc: string
}

export interface WorkgroupTaskConfigDraft {
  switches: WorkgroupSwitches
  /** undefined = field cleared → treated as "unchanged". */
  maxRounds: number | undefined
  completionGate: boolean
  addMembers: WorkgroupConfigMemberAdd[]
  removeMemberIds: string[]
}

/** Dialog seed — mirrors the CURRENT task copy so diffing starts clean. */
export function workgroupTaskConfigDraftFrom(
  config: Pick<WorkgroupRuntimeConfig, 'switches' | 'maxRounds' | 'completionGate'>,
): WorkgroupTaskConfigDraft {
  return {
    switches: { ...config.switches },
    maxRounds: config.maxRounds,
    completionGate: config.completionGate,
    addMembers: [],
    removeMemberIds: [],
  }
}

/**
 * Compose the PUT body carrying ONLY the fields that actually changed
 * against the task's current config copy. Returns null when nothing changed
 * (the dialog disables submit — the backend would 422 `workgroup-config-empty`).
 * `switches` is all-or-nothing on the wire (the schema wants the full
 * triple), included iff any one of the three flipped.
 */
export function buildWorkgroupConfigPatch(
  config: Pick<WorkgroupRuntimeConfig, 'switches' | 'maxRounds' | 'completionGate'>,
  draft: WorkgroupTaskConfigDraft,
): Record<string, unknown> | null {
  const out: Record<string, unknown> = {}
  const s = draft.switches
  if (
    s.shareOutputs !== config.switches.shareOutputs ||
    s.directMessages !== config.switches.directMessages ||
    s.blackboard !== config.switches.blackboard
  ) {
    out.switches = { ...s }
  }
  if (draft.maxRounds !== undefined && draft.maxRounds !== config.maxRounds) {
    out.maxRounds = draft.maxRounds
  }
  if (draft.completionGate !== config.completionGate) out.completionGate = draft.completionGate
  if (draft.addMembers.length > 0) {
    out.addMembers = draft.addMembers.map((m) =>
      m.memberType === 'agent'
        ? {
            memberType: 'agent',
            agentName: m.agentName ?? '',
            displayName: m.displayName,
            roleDesc: m.roleDesc,
          }
        : {
            memberType: 'human',
            userId: m.userId ?? '',
            displayName: m.displayName,
            roleDesc: m.roleDesc,
          },
    )
  }
  if (draft.removeMemberIds.length > 0) out.removeMemberIds = [...draft.removeMemberIds]
  return Object.keys(out).length > 0 ? out : null
}

/** Valid maxRounds for the mid-run patch (mirrors ConfigPatchSchema: 1..500 int). */
export function isValidTaskMaxRounds(n: number | undefined): boolean {
  return n === undefined || (Number.isInteger(n) && n >= 1 && n <= 500)
}

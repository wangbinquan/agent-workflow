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
  WorkgroupMemberCurrentRun,
  WorkgroupMessage,
  WorkgroupRunEntry,
  WorkgroupRuntimeConfig,
  WorkgroupRuntimeMember,
  WorkgroupSwitches,
} from '@agent-workflow/shared'
import { WORKGROUP_MAX_ROUNDS_LIMIT } from '@agent-workflow/shared'
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
  /** RFC-179 — { [memberId]: current session run | null }. Drives 点成员看 session
   *  + 被 @ 执行中指示. Read-only runtime view; never enters a prompt (design §11). */
  memberRuns: Record<string, WorkgroupMemberCurrentRun | null>
  /** RFC-182 — the room's FULL execution history (ascending by nodeRunId =
   *  mint order); `memberRuns` is its projection. Feeds the turn cards, the
   *  执行记录 rail and the drawer's member-scoped run list. */
  runHistory: WorkgroupRunEntry[]
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
  | { type: 'turn'; entry: WorkgroupRunEntry }

/**
 * Interleave round separators into the ascending message stream: a separator
 * lands wherever `round` changes between consecutive messages. Round-0 rows
 * (pre-engine prelude — e.g. a human speaking before the first leader turn)
 * get no leading separator; the first round-N (N>0) message earns one.
 * Message ids are ULIDs, so ascending id == ascending time (the endpoint
 * already orders by id; sort defensively anyway).
 *
 * RFC-182 — `standaloneTurns` (leader rounds + degraded message-turns, see
 * `standaloneTurnEntries`) are woven in as `{type:'turn'}` rows:
 *   - leader entries are ROUND-AWARE (design-gate P2): a leader run is minted
 *     BEFORE its own round-N output lands, so pure ULID interleaving would put
 *     the round-1 card above the round-1 divider / under the previous round.
 *     They land right AFTER their round's divider (or at the tail when the
 *     divider hasn't materialized yet — the "leader thinking right now" case).
 *   - round-null entries interleave by ULID (nodeRunId vs message id).
 */
export function buildRoomTimeline(
  messages: readonly WorkgroupRoomMessage[],
  standaloneTurns: readonly WorkgroupRunEntry[] = [],
): RoomTimelineEntry[] {
  const sorted = [...messages].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const base: RoomTimelineEntry[] = []
  let prevRound: number | null = null
  for (const m of sorted) {
    const isTransition = prevRound === null ? m.round > 0 : m.round !== prevRound
    if (isTransition) base.push({ type: 'round', round: m.round })
    base.push({ type: 'message', message: m })
    prevRound = m.round
  }
  if (standaloneTurns.length === 0) return base

  const turns = [...standaloneTurns].sort((a, b) =>
    a.nodeRunId < b.nodeRunId ? -1 : a.nodeRunId > b.nodeRunId ? 1 : 0,
  )
  const out: RoomTimelineEntry[] = []
  const tail: WorkgroupRunEntry[] = []
  const byUlid = turns.filter((t) => t.round === null)
  const byRound = new Map<number, WorkgroupRunEntry[]>()
  for (const t of turns) {
    if (t.round === null) continue
    const arr = byRound.get(t.round) ?? []
    arr.push(t)
    byRound.set(t.round, arr)
  }
  let ulidIdx = 0
  for (const e of base) {
    if (e.type === 'message') {
      while (ulidIdx < byUlid.length && (byUlid[ulidIdx]?.nodeRunId ?? '') < e.message.id) {
        const t = byUlid[ulidIdx]
        if (t !== undefined) out.push({ type: 'turn', entry: t })
        ulidIdx++
      }
    }
    out.push(e)
    if (e.type === 'round') {
      for (const t of byRound.get(e.round) ?? []) out.push({ type: 'turn', entry: t })
      byRound.delete(e.round)
    }
  }
  while (ulidIdx < byUlid.length) {
    const t = byUlid[ulidIdx]
    if (t !== undefined) out.push({ type: 'turn', entry: t })
    ulidIdx++
  }
  // Rounds whose divider hasn't materialized yet (live leader thinking) — tail,
  // ascending by round then mint order.
  for (const round of [...byRound.keys()].sort((a, b) => a - b)) {
    for (const t of byRound.get(round) ?? []) tail.push(t)
  }
  for (const t of tail) out.push({ type: 'turn', entry: t })
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

// ---------------------------------------------------------------------------
// RFC-182 D5 — roster presence（四态单源）。取代 RFC-164 的 memberIsWorking
// （只读 assignments——leader 轮 / 被 @ 轮执行时永远「空闲」，与同屏的执行中
// pill 自相矛盾，用户抱怨 #2 的根因；f55ede4b 只修了刷新时延没修数据源）。
// ---------------------------------------------------------------------------

export type WorkgroupMemberPresence = 'working' | 'awaiting' | 'queued' | 'idle'

/**
 * currentRun 状态优先（RFC-182 设计门 P1）：派发轮在 run 等信号量前 assignment
 * 已被 CAS 成 running——「排队中」场景恰是 run=pending + assignment=running，
 * assignment 优先会把 queued 误报成 working。assignment 只在 currentRun 为空
 * 或终态时兜底（dispatched=已派发未 mint 窗口 / awaiting_human=人工交付等待）。
 */
export function deriveMemberPresence(
  memberId: string,
  assignments: readonly Pick<WorkgroupRoomAssignment, 'assigneeMemberId' | 'status'>[],
  currentRun: WorkgroupMemberCurrentRun | null | undefined,
): WorkgroupMemberPresence {
  const run = currentRun ?? null
  if (run !== null) {
    if (run.status === 'running') return 'working'
    if (run.status === 'awaiting_human') return 'awaiting'
    if (run.status === 'pending') return 'queued'
  }
  let queued = false
  let awaiting = false
  for (const a of assignments) {
    if (a.assigneeMemberId !== memberId) continue
    if (a.status === 'running') return 'working'
    if (a.status === 'awaiting_human') awaiting = true
    else if (a.status === 'dispatched') queued = true
  }
  if (awaiting) return 'awaiting'
  if (queued) return 'queued'
  return 'idle'
}

// ---------------------------------------------------------------------------
// RFC-179 §2.3 / RFC-182 — executing indicators + turn cards. memberRuns /
// runHistory come from the room aggregate. Pure + table-tested.
// ---------------------------------------------------------------------------

type RoomMemberLite = Pick<WorkgroupRuntimeMember, 'id' | 'displayName'>

/** A member is executing iff its current session run is live. */
export function memberExecuting(currentRun: WorkgroupMemberCurrentRun | null | undefined): boolean {
  return currentRun?.status === 'running'
}

/**
 * RFC-182 D1/D4 — turn cards attached under their triggering @-mention
 * message (message-turn entries only; assignment runs keep their
 * DispatchCard — a second card would be duplicate noise).
 */
export function turnCardsForMessage(
  runHistory: readonly WorkgroupRunEntry[],
  messageId: string,
): WorkgroupRunEntry[] {
  return runHistory.filter((e) => e.kind === 'message-turn' && e.triggerMessageId === messageId)
}

/**
 * RFC-182 — standalone timeline turn entries: every leader round (they have
 * no triggering message; anchored round-aware by buildRoomTimeline) plus
 * message-turns whose trigger derivation failed (degraded → ULID order, the
 * card is never lost). Assignment runs are excluded (DispatchCard owns them).
 */
export function standaloneTurnEntries(
  runHistory: readonly WorkgroupRunEntry[],
): WorkgroupRunEntry[] {
  return runHistory.filter(
    (e) => e.kind === 'leader-round' || (e.kind === 'message-turn' && e.triggerMessageId === null),
  )
}

/**
 * Render① — message id → displayNames of members whose live message-turn was
 * woken by that @-mention (currentRun.triggerMessageId). Drives the per-message
 *「执行中」pill on the triggering message.
 */
export function mentionExecutingPills(
  members: readonly RoomMemberLite[],
  memberRuns: Record<string, WorkgroupMemberCurrentRun | null>,
): Map<string, { displayName: string; nodeRunId: string }[]> {
  const map = new Map<string, { displayName: string; nodeRunId: string }[]>()
  for (const m of members) {
    const run = memberRuns[m.id] ?? null
    if (
      run !== null &&
      run.status === 'running' &&
      run.kind === 'message-turn' &&
      run.triggerMessageId !== null
    ) {
      const arr = map.get(run.triggerMessageId) ?? []
      // RFC-182 D9/G2 — carry the run id so the pill itself opens the session.
      arr.push({ displayName: m.displayName, nodeRunId: run.nodeRunId })
      map.set(run.triggerMessageId, arr)
    }
  }
  return map
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
// RFC-174 — composer keyboard oracle
// ---------------------------------------------------------------------------

/**
 * The action the composer's onKeyDown should take for a key event. Pure — the
 * component maps it to preventDefault + state/mutation calls. Precedent:
 * lib/review/multiDocHotkeys.ts (key→action as a unit-testable pure fn).
 */
export type ComposerKeyAction =
  | { type: 'send' }
  | { type: 'mention-move'; index: number }
  | { type: 'mention-commit'; index: number }
  | { type: 'mention-close' }
  | { type: 'default' }

export interface ComposerKeyState {
  key: string
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
  /** e.nativeEvent.isComposing || keyCode === 229 — IME still composing. */
  isComposing: boolean
  /** Whether the @-mention dropdown is currently open (component-derived). */
  mentionOpen: boolean
  candidateCount: number
  /** Already clamped to [0, candidateCount) by the caller. */
  activeIndex: number
}

/**
 * Map a composer keydown to its action. Precedence (first match wins):
 *   1. IME composing → default: the input method owns every key, so a
 *      Chinese/Japanese candidate-confirm Enter can never send or commit.
 *   2. Dropdown open → the mention UI owns its keys. Arrows move (no modifiers),
 *      Enter/Tab commit, Escape closes. Cmd/Ctrl+Enter here COMMITS the
 *      highlighted candidate rather than sending, so a half-typed "@query" is
 *      never fired off (AC4).
 *   3. Dropdown closed → the send chord: Enter + exactly Cmd/Ctrl (no Shift/Alt).
 *   4. Everything else → default (plain Enter = newline).
 *
 * Modifier discipline mirrors multiDocHotkeyAction: navigation / Tab / Escape
 * only fire with NO modifiers, so Shift+Arrow (selection), Ctrl+Tab (tab
 * switch), Shift+Tab (focus-back) and Cmd+Arrow (line ends) stay native.
 */
export function resolveComposerKey(s: ComposerKeyState): ComposerKeyAction {
  if (s.isComposing) return { type: 'default' }
  const noMods = !s.metaKey && !s.ctrlKey && !s.altKey && !s.shiftKey
  if (s.mentionOpen && s.candidateCount > 0) {
    if (s.key === 'ArrowDown' && noMods) {
      return { type: 'mention-move', index: (s.activeIndex + 1) % s.candidateCount }
    }
    if (s.key === 'ArrowUp' && noMods) {
      return {
        type: 'mention-move',
        index: (s.activeIndex - 1 + s.candidateCount) % s.candidateCount,
      }
    }
    if (s.key === 'Escape' && noMods) return { type: 'mention-close' }
    if (s.key === 'Tab' && noMods) return { type: 'mention-commit', index: s.activeIndex }
    // plain Enter or the send chord (Cmd/Ctrl+Enter) commit; Shift/Alt+Enter → newline.
    if (s.key === 'Enter' && !s.shiftKey && !s.altKey) {
      return { type: 'mention-commit', index: s.activeIndex }
    }
    return { type: 'default' }
  }
  if (s.key === 'Enter' && (s.metaKey || s.ctrlKey) && !s.shiftKey && !s.altKey) {
    return { type: 'send' }
  }
  return { type: 'default' }
}

/**
 * Label for the send chord's modifier key, platform-aware: mac → '⌘', else
 * (incl. SSR / test env / non-mac) → 'Ctrl'. Interpolated into the visible
 * composer shortcut hint.
 */
export function sendChordModLabel(): '⌘' | 'Ctrl' {
  if (typeof navigator === 'undefined') return 'Ctrl'
  const probe = `${navigator.platform ?? ''} ${navigator.userAgent ?? ''}`
  return /Mac|iPhone|iPad/.test(probe) ? '⌘' : 'Ctrl'
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
  /** RFC-181 A — mid-run autonomous toggle (symmetric on/off; false→true also
   *  dismisses in-flight clarify parks server-side, A2). */
  autonomous: boolean
  addMembers: WorkgroupConfigMemberAdd[]
  removeMemberIds: string[]
}

/** Dialog seed — mirrors the CURRENT task copy so diffing starts clean. */
export function workgroupTaskConfigDraftFrom(
  config: Pick<WorkgroupRuntimeConfig, 'switches' | 'maxRounds' | 'completionGate' | 'autonomous'>,
): WorkgroupTaskConfigDraft {
  return {
    switches: { ...config.switches },
    maxRounds: config.maxRounds,
    completionGate: config.completionGate,
    autonomous: config.autonomous ?? false,
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
  config: Pick<WorkgroupRuntimeConfig, 'switches' | 'maxRounds' | 'completionGate' | 'autonomous'>,
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
  if (draft.autonomous !== (config.autonomous ?? false)) out.autonomous = draft.autonomous
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

/** Valid maxRounds for the mid-run patch (mirrors ConfigPatchSchema: 1..LIMIT int). */
export function isValidTaskMaxRounds(n: number | undefined): boolean {
  return n === undefined || (Number.isInteger(n) && n >= 1 && n <= WORKGROUP_MAX_ROUNDS_LIMIT)
}

// ---------------------------------------------------------------------------
// RFC-182 P1-2 — room timestamp formatting（跨天房间不丢日期）
// ---------------------------------------------------------------------------

/**
 * Same-day → `HH:mm:ss`; different day (vs `now`) → `M/D HH:mm`. Pure so the
 * vitest matrix pins both branches (the component passes `Date.now()`).
 */
export function formatRoomTimestamp(ts: number, now: number): string {
  const d = new Date(ts)
  const n = new Date(now)
  const sameDay =
    d.getFullYear() === n.getFullYear() &&
    d.getMonth() === n.getMonth() &&
    d.getDate() === n.getDate()
  const two = (x: number): string => String(x).padStart(2, '0')
  if (sameDay) return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`
  return `${d.getMonth() + 1}/${d.getDate()} ${two(d.getHours())}:${two(d.getMinutes())}`
}

/**
 * RFC-182 — live/settled turn-card duration: running cards tick against
 * `now`; settled cards freeze at finishedAt−startedAt; missing startedAt → null
 * (the card renders an em-dash).
 */
export function turnDurationMs(entry: WorkgroupRunEntry, now: number): number | null {
  if (entry.startedAt === null) return null
  const end = entry.finishedAt ?? now
  return Math.max(0, end - entry.startedAt)
}

/** Compact `mm:ss` / `h:mm:ss` duration label for turn cards / run log rows. */
export function formatTurnDuration(ms: number): string {
  const totalSec = Math.floor(ms / 1000)
  const h = Math.floor(totalSec / 3600)
  const m = Math.floor((totalSec % 3600) / 60)
  const s = totalSec % 60
  const two = (x: number): string => String(x).padStart(2, '0')
  return h > 0 ? `${h}:${two(m)}:${two(s)}` : `${two(m)}:${two(s)}`
}

// RFC-164 PR-3 — the workgroup round engine (design §4).
//
// runTask branches HERE for tasks with workgroup_id (never into
// runScope/deriveFrontier). The engine is completion-driven orchestration
// over durable rows only:
//
//   loop: re-read tables → deriveWakeSet (pure) → drive wake items through
//   hooks.runHostNode → persist envelope effects (assignments / messages /
//   cursors / gate) → race in-flight turns → …until decideWorkgroupOutcome
//   picks a terminal.
//
// EVERYTHING mechanical (frozen runtime, iso worktree + merge-back, spawn,
// clarify session creation, broadcasts) lives behind `WorkgroupEngineHooks`,
// implemented by the scheduler (buildWorkgroupHooks) — the engine never
// imports scheduler.ts (module-cycle ban; binary-build memory) and tests
// drive it with fake hooks (no subprocesses).
//
// Restart safety (design §4.3): no in-memory state survives — wake judgments
// are cursor-based (workgroup_member_cursors) and pending host-node rows
// minted before a crash (incl. clarify-answer reruns) are ADOPTED on the next
// pass instead of re-minted.

import {
  FOLLOWUP_POLICY,
  normalizeWgTaskTitle,
  parseWgAssignmentsPort,
  parseWgDecisionPort,
  parseWgMessagesPort,
  parseWgResultPort,
  parseWgTasksAddPort,
  renderAgentCapabilityCard,
  resolveClarifyEnabled,
  resolveCompletionGate,
  resolveWorkgroupSwitches,
  WG_PORT_ASSIGNMENTS,
  WG_PORT_DECISION,
  WG_PORT_MESSAGES,
  WG_PORT_RESULT,
  WG_PORT_TASKS_ADD,
  WorkgroupRuntimeConfigSchema,
  type Agent,
  type EnvelopeFollowupReason,
  type FailureCode,
  type WgMessageItem,
  type WorkgroupAssignment,
  type WorkgroupMessage,
  type WorkgroupRuntimeConfig,
} from '@agent-workflow/shared'
import { and, asc, eq, inArray } from 'drizzle-orm'
import { ulid } from 'ulid'
import type { DbClient } from '@/db/client'
import { dbTxSync } from '@/db/txSync'
import {
  nodeRuns,
  tasks,
  workgroupAssignments,
  workgroupMemberCursors,
  workgroupMessages,
} from '@/db/schema'
import { getAgent } from '@/services/agent'
import { CLARIFY_FORBIDDEN_PREFIX } from '@/services/envelope'
import { mintNodeRun } from '@/services/nodeRunMint'
import { setNodeRunStatus } from '@/services/lifecycle'
import { advanceMemberCursor, casAssignmentStatus } from '@/services/workgroupLifecycle'
import {
  maxMessageId,
  memberById,
  memberDisplayName,
  renderCharterBlock,
  renderGoalBlock,
  renderLeaderLedger,
  renderMessagesBlock,
  renderRosterBlock,
  renderWgProtocolBlock,
  rosterDisplayNames,
  selectMemberSlices,
  wgHostRolePorts,
} from '@/services/workgroupContext'
import {
  decideWorkgroupOutcome,
  deriveWakeSet,
  WG_NUDGE_BODY,
  type WakeInput,
  type WakeItem,
} from '@/services/workgroupWake'
import { WG_LEADER_NODE_ID, WG_MEMBER_NODE_ID } from '@/services/workgroupLaunch'
import { taskBroadcaster, TASK_CHANNEL } from '@/ws/broadcaster'
import type { Logger } from '@/util/log'

// ---------------------------------------------------------------------------
// public contract (scheduler-facing)
// ---------------------------------------------------------------------------

export interface WorkgroupHostRunRequest {
  nodeRunId: string
  nodeId: string
  agent: Agent
  /** Fully-composed prompt text (charter/roster/brief/slices). */
  promptTemplate: string
  /** Replaces the agent-outputs protocol block (design §5). Workgroup turns
   *  always pass one; the RFC-167 orchestrator run omits it so the STANDARD
   *  <workflow-output> protocol for its declared ports applies. */
  workgroupProtocolBlock?: string
  /** RFC-167 (Codex impl-gate P1): drop the run's iso-worktree delta instead
   *  of merging it back — the orchestrator GENERATION run only produces an
   *  envelope; its worktree writes must never reach canonical (validation +
   *  the human confirm gate happen after the run). Workgroup turns leave this
   *  unset (their writes are the work product). */
  discardWrites?: boolean
  /** RFC-181 C — resolveClarifyEnabled(config.autonomous) at dispatch time.
   *  false ⇒ the hook runs the node with the 'stopped' clarify directive, so a
   *  voluntary <workflow-clarify> is REJECTED inside runNode (persisted
   *  failed + clarify-forbidden, no session, no park) and the runner branches
   *  below re-prompt / drop-and-continue. Undefined (dynamic orchestrator)
   *  keeps the legacy no-channel behavior. The hook additionally re-reads the
   *  task's CURRENT autonomous right before opening a session (mid-run toggle
   *  race — design-gate P1-①). */
  clarifyEnabled?: boolean
  /** RFC-184: the wg protocol output ports this host role may emit
   *  ({@link wgHostRolePorts}). When set, the hook projects the member agent's
   *  `outputs` to this list and clears `outputKinds` before runNode, so the
   *  runner parses/returns the wg_* ports and NEVER validates the member's own
   *  business output kinds (root cause of the F42SE port-validation-path-empty
   *  failure). Also gates `persistDeclaredOutputs:false` so host runs keep the
   *  "zero node_run_outputs rows" invariant (design.md §2.4). Undefined
   *  (dynamic orchestrator) ⇒ no projection, agent's declared outputs apply. */
  hostOutputPorts?: string[]
}

export interface WorkgroupHostRunResult {
  status: 'done' | 'failed' | 'canceled' | 'awaiting'
  /** Envelope port map (present when status='done'). */
  outputs: Record<string, string>
  /** Set when the agent voluntarily asked back (status='awaiting'). */
  clarifyQuestionCount?: number
  errorMessage?: string
  /** RFC-185 e2e hardening — runNode's structured failure code (RFC-145: the
   *  ONLY machine routing key; errorMessage is human breadcrumbs). Lets the
   *  turn drivers treat envelope-missing as a retryable protocol slip. */
  failureCode?: FailureCode
}

export interface WorkgroupEngineHooks {
  /**
   * Drive ONE host-node run end to end: frozen runtime + iso worktree +
   * runNode + merge-back + node_run status. `status:'awaiting'` means the
   * agent emitted <workflow-clarify> and the hook already created the clarify
   * session (parked awaiting_human).
   */
  runHostNode: (req: WorkgroupHostRunRequest) => Promise<WorkgroupHostRunResult>
  /** node.status WS broadcast (optional in tests). */
  broadcastNodeStatus?: (nodeRunId: string, nodeId: string, status: string) => void
}

export interface WorkgroupEngineArgs {
  db: DbClient
  taskId: string
  log: Logger
  signal?: AbortSignal
  hooks: WorkgroupEngineHooks
  /** INTERNAL (set by the engine loop): registers freshly-minted host rows so
   *  the adoption pass never re-drives them. Tests need not provide it. */
  registerMint?: (nodeRunId: string) => void
}

export interface WorkgroupEngineResult {
  kind: 'ok' | 'failed' | 'canceled' | 'awaiting_review' | 'awaiting_human'
  detail?: { summary: string; message: string; nodeId?: string }
}

/** Per-turn protocol-violation retries before the turn is failed. RFC-186 §2.4:
 *  raised 1→3 to match the normal-node default (scheduler defaultNodeRetries ?? 3)
 *  — a probabilistic model format slip deserves the same budget everywhere. */
const WG_PROTOCOL_RETRIES = 3

/**
 * RFC-186 §2.2 — unify the workgroup turn's retry-vs-fatal decision on the SAME
 * `FOLLOWUP_POLICY` table normal nodes use (`decideEnvelopeFollowup`), replacing
 * the order-sensitive `errorMessage.startsWith(...)` chain + the per-code
 * `failureCode === 'envelope-missing'` special-case (audit §2 P1-5). A failure
 * with a structured `FailureCode` in the table is retryable; an unstructured
 * failure (`failureCode` undefined — iso-setup / injection / subprocess crash /
 * merge-back conflict) is genuinely fatal. `clarify-forbidden` is handled by its
 * OWN branch BEFORE this (workgroup autonomous soft-reject semantics, RFC-181/183)
 * — never routed here as a normal envelope-missing retry.
 */
export function followupForFailure(
  failureCode: FailureCode | undefined,
): { retry: true; reason: EnvelopeFollowupReason } | { retry: false } {
  if (failureCode === undefined) return { retry: false }
  const policy = FOLLOWUP_POLICY[failureCode] as { reason: EnvelopeFollowupReason } | undefined
  return policy ? { retry: true, reason: policy.reason } : { retry: false }
}

/**
 * RFC-186 §2.3 — reason-tailored re-prompt for a workgroup turn. Unlike the
 * normal node, we do NOT reuse `renderEnvelopeFollowupPrompt` verbatim: that
 * renderer REPLACES the whole prompt, which would drop the `workgroupProtocolBlock`
 * (where the wg_* port contract lives) on the fresh retry subprocess. Instead we
 * return a concise `errorNotice` appended to the FULL turn prompt (which still
 * carries the wg protocol block via runHostNode), reason-mapped from the same
 * 6-value `EnvelopeFollowupReason` domain.
 */
export function wgFollowupNotice(reason: EnvelopeFollowupReason): string {
  switch (reason) {
    case 'envelope-missing':
      return (
        '- Your previous reply had NO <workflow-output> envelope. Re-read the\n' +
        '  Workgroup output protocol above and re-emit your FULL reply as ONE\n' +
        '  <workflow-output> envelope with <port name="..."> children (literal\n' +
        '  tag names — never invent your own tags).'
      )
    case 'both-present':
      return (
        '- You emitted BOTH <workflow-output> and <workflow-clarify>. Emit exactly\n' +
        '  ONE — the <workflow-output> envelope with your wg_* ports.'
      )
    case 'clarify-malformed':
      return (
        '- Your <workflow-clarify> reply was malformed. Re-emit a VALID\n' +
        '  <workflow-clarify> envelope (see the clarify format above) OR, if nothing\n' +
        '  needs a human, proceed with a <workflow-output> envelope.'
      )
    case 'envelope-port-malformed':
      return (
        '- A <port> tag in your envelope was unclosed or corrupted. Re-emit ONE\n' +
        '  clean <workflow-output> with each port properly closed by </port>.'
      )
    case 'port-validation':
      return (
        '- A port in your envelope failed validation. Re-emit a <workflow-output>\n' +
        '  whose port bodies are valid JSON matching the protocol above.'
      )
    case 'clarify-required':
      return (
        '- This turn requires a <workflow-clarify> envelope. Re-emit your reply as\n' +
        '  a single valid <workflow-clarify> envelope.'
      )
  }
}

/**
 * RFC-186 PR-2 (audit §4 F1 / §5 F1) — the reconcile action for a `running`
 * assignment found on engine (re)entry, from its LATEST worker host-run status.
 * A daemon restart reaps a mid-run worker `node_run` to `interrupted` but leaves
 * the assignment `running`; adoption only re-drives `pending` rows, so the
 * assignment is never re-driven AND blocks the leader barrier (a `running`
 * assignment counts as in-flight) → the task wedges `awaiting_human` forever.
 */
export function decideAssignmentReconcile(
  latestWorkerRunStatus: string | undefined,
): 'done' | 'redispatch' | 'none' {
  // Interrupted before the worker run was even minted → re-dispatch.
  if (latestWorkerRunStatus === undefined) return 'redispatch'
  // Finished + merged before the crash → the work is durable; just close the card.
  if (latestWorkerRunStatus === 'done') return 'done'
  // A live driver still owns it (fresh engine shouldn't see this) → leave it.
  if (latestWorkerRunStatus === 'pending' || latestWorkerRunStatus === 'running') return 'none'
  // interrupted / failed / canceled mid-run → re-dispatch for a clean re-run.
  return 'redispatch'
}

/** Apply {@link decideAssignmentReconcile} to every `running` assignment ONCE at
 *  engine (re)entry so a resumed task makes progress instead of re-parking. */
async function reconcileRunningAssignments(
  db: DbClient,
  taskId: string,
  state: EngineDbState,
  log: Logger,
): Promise<void> {
  let count = 0
  for (const a of state.assignments) {
    if (a.status !== 'running') continue
    const runs = state.hostRuns.filter((r) => r.nodeId === WG_MEMBER_NODE_ID && r.shardKey === a.id)
    const latest = runs[runs.length - 1]
    const action = decideAssignmentReconcile(latest?.status)
    if (action === 'done') {
      if (await casAssignmentStatus(db, a.id, 'running', 'done')) count++
    } else if (action === 'redispatch') {
      if (await casAssignmentStatus(db, a.id, 'running', 'dispatched')) count++
    }
  }
  if (count > 0) log.info('workgroup reconciled running assignments on resume', { taskId, count })
}

/** RFC-182 D6 — pending visibility: a mint alone broadcasts nothing (the first
 *  frame used to be runNode's `running`), so a turn queued behind the global
 *  semaphore was invisible to the room — presence said "idle" while work was
 *  already committed. One frame per FRESH mint (adopted rows were announced at
 *  their own mint site — taskQuestionDispatch); `node.status` already
 *  invalidates the room key client-side (f55ede4b), zero new WS rules. */
function broadcastPendingMint(taskId: string, nodeRunId: string, nodeId: string): void {
  taskBroadcaster.broadcast(TASK_CHANNEL(taskId), {
    id: -1,
    type: 'node.status',
    nodeRunId,
    nodeId,
    status: 'pending',
  })
}

// ---------------------------------------------------------------------------
// durable state I/O
// ---------------------------------------------------------------------------

interface GateState {
  declaredDone: boolean
  rejected: boolean
  rejectedComment?: string
  awaitingConfirmation: boolean
  /** PR-5: human approved the completion gate — the engine may finish. */
  approved: boolean
  summary?: string
}

interface EngineDbState {
  config: WorkgroupRuntimeConfig
  gate: GateState
  rawConfig: Record<string, unknown>
  assignments: WorkgroupAssignment[]
  messages: WorkgroupMessage[]
  cursors: Map<string, string>
  hostRuns: Array<typeof nodeRuns.$inferSelect>
  /** RFC-166 — pre-rendered capability card per AGENT member (memberId → card).
   *  Injected into the roster block so the leader / peers coordinate against
   *  each member's real declared capability. human members are absent (prompt
   *  isolation — never render a card for a human). */
  agentCards: Map<string, string>
}

/** RFC-166 — capability-card prompt-summary budget inside a workgroup roster.
 *  Smaller than the standalone default (600) because a leader roster may list
 *  many members and every card rides in every leader/peer turn — keep tokens
 *  bounded. The description + port lines are always shown in full; only the
 *  bodyMd prompt summary is clipped to this budget. */
const ROSTER_CARD_PROMPT_BUDGET = 240

/**
 * RFC-166 — preload each AGENT member's capability card once per engine pass.
 * agentName is a soft reference (launch-validated, may dangle if the agent was
 * later deleted); a missing agent simply yields no card (the roster row still
 * renders with displayName + roleDesc). human members are skipped entirely so
 * no user identity can leak into the prompt.
 */
export async function buildRosterAgentCards(
  db: DbClient,
  config: WorkgroupRuntimeConfig,
): Promise<Map<string, string>> {
  const cards = new Map<string, string>()
  // De-dupe DB reads: several members may reference the same agentName.
  const agentByName = new Map<string, Agent | null>()
  for (const m of config.members) {
    if (m.memberType !== 'agent' || m.agentName === null) continue
    let agent = agentByName.get(m.agentName)
    if (agent === undefined) {
      agent = await getAgent(db, m.agentName)
      agentByName.set(m.agentName, agent)
    }
    if (agent === null) continue
    cards.set(m.id, renderAgentCapabilityCard(agent, { promptBudget: ROSTER_CARD_PROMPT_BUDGET }))
  }
  return cards
}

function rowToAssignment(r: typeof workgroupAssignments.$inferSelect): WorkgroupAssignment {
  return {
    id: r.id,
    taskId: r.taskId,
    round: r.round,
    source: r.source,
    createdByRunId: r.createdByRunId,
    createdByUserId: r.createdByUserId,
    assigneeMemberId: r.assigneeMemberId,
    title: r.title,
    briefMd: r.briefMd,
    status: r.status,
    nodeRunId: r.nodeRunId,
    resultMessageId: r.resultMessageId,
    dedupKey: r.dedupKey,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  }
}

function rowToMessage(r: typeof workgroupMessages.$inferSelect): WorkgroupMessage {
  let mentions: string[] = []
  try {
    const parsed = JSON.parse(r.mentionsJson) as unknown
    mentions = Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : []
  } catch {
    mentions = []
  }
  return {
    id: r.id,
    taskId: r.taskId,
    round: r.round,
    authorKind: r.authorKind,
    authorMemberId: r.authorMemberId,
    authorUserId: r.authorUserId,
    kind: r.kind,
    bodyMd: r.bodyMd,
    mentionMemberIds: mentions,
    assignmentId: r.assignmentId,
    createdAt: r.createdAt,
  }
}

async function loadDbState(db: DbClient, taskId: string): Promise<EngineDbState | null> {
  const taskRow = (await db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1))[0]
  if (taskRow === undefined || taskRow.workgroupConfigJson === null) return null
  let rawConfig: Record<string, unknown>
  try {
    rawConfig = JSON.parse(taskRow.workgroupConfigJson) as Record<string, unknown>
  } catch {
    return null
  }
  const parsed = WorkgroupRuntimeConfigSchema.safeParse(rawConfig)
  if (!parsed.success) return null
  const gateRaw = (rawConfig.gate ?? {}) as Partial<GateState>
  const gate: GateState = {
    declaredDone: gateRaw.declaredDone === true,
    rejected: gateRaw.rejected === true,
    awaitingConfirmation: gateRaw.awaitingConfirmation === true,
    approved: gateRaw.approved === true,
    ...(typeof gateRaw.rejectedComment === 'string'
      ? { rejectedComment: gateRaw.rejectedComment }
      : {}),
    ...(typeof gateRaw.summary === 'string' ? { summary: gateRaw.summary } : {}),
  }
  const [assignmentRows, messageRows, cursorRows, hostRuns] = await Promise.all([
    db
      .select()
      .from(workgroupAssignments)
      .where(eq(workgroupAssignments.taskId, taskId))
      .orderBy(asc(workgroupAssignments.id)),
    db
      .select()
      .from(workgroupMessages)
      .where(eq(workgroupMessages.taskId, taskId))
      .orderBy(asc(workgroupMessages.id)),
    db.select().from(workgroupMemberCursors).where(eq(workgroupMemberCursors.taskId, taskId)),
    db
      .select()
      .from(nodeRuns)
      .where(
        and(
          eq(nodeRuns.taskId, taskId),
          inArray(nodeRuns.nodeId, [WG_LEADER_NODE_ID, WG_MEMBER_NODE_ID]),
        ),
      )
      .orderBy(asc(nodeRuns.id)),
  ])
  return {
    config: parsed.data,
    gate,
    rawConfig,
    assignments: assignmentRows.map(rowToAssignment),
    messages: messageRows.map(rowToMessage),
    cursors: new Map(cursorRows.map((c) => [c.memberId, c.lastConsumedMessageId])),
    hostRuns,
    agentCards: await buildRosterAgentCards(db, parsed.data),
  }
}

async function persistGate(
  db: DbClient,
  taskId: string,
  rawConfig: Record<string, unknown>,
  gate: GateState,
): Promise<void> {
  // Codex T6 impl-gate P2 — reload-and-merge inside ONE sync transaction
  // instead of overwriting with the engine's pass-start snapshot: a whole-
  // JSON write from a stale rawConfig would silently drop a concurrent
  // per-task config PATCH (autonomous / fanOut mid-run toggles — RFC-181 A /
  // RFC-185 D4; the race predates fanOut and could lose autonomous too).
  // rawConfig stays as the fallback when the row's JSON is missing or
  // unreadable mid-flight (legacy behavior for that edge).
  dbTxSync(db, (tx) => {
    const row = tx
      .select({ workgroupConfigJson: tasks.workgroupConfigJson })
      .from(tasks)
      .where(eq(tasks.id, taskId))
      .get()
    let base = rawConfig
    if (row?.workgroupConfigJson != null) {
      try {
        base = JSON.parse(row.workgroupConfigJson) as Record<string, unknown>
      } catch {
        // fall back to the engine snapshot
      }
    }
    tx.update(tasks)
      .set({ workgroupConfigJson: JSON.stringify({ ...base, gate }) })
      .where(eq(tasks.id, taskId))
      .run()
  })
}

interface PostMessageArgs {
  round: number
  authorKind: 'member' | 'human' | 'system'
  authorMemberId?: string | null
  kind: WorkgroupMessage['kind']
  bodyMd: string
  mentionMemberIds?: string[]
  assignmentId?: string | null
}

async function postMessage(db: DbClient, taskId: string, m: PostMessageArgs): Promise<string> {
  const id = ulid()
  await db.insert(workgroupMessages).values({
    id,
    taskId,
    round: m.round,
    authorKind: m.authorKind,
    authorMemberId: m.authorMemberId ?? null,
    authorUserId: null,
    kind: m.kind,
    bodyMd: m.bodyMd,
    mentionsJson: JSON.stringify(m.mentionMemberIds ?? []),
    assignmentId: m.assignmentId ?? null,
    createdAt: Date.now(),
  })
  taskBroadcaster.broadcast(TASK_CHANNEL(taskId), {
    id: -1,
    type: 'wg.message.created',
    messageId: id,
    kind: m.kind,
  })
  return id
}

// ---------------------------------------------------------------------------
// round counting (durable — derived from node_runs each pass)
// ---------------------------------------------------------------------------

function countRoundsUsed(state: EngineDbState): number {
  if (state.config.mode === 'leader_worker') {
    return state.hostRuns.filter(
      (r) =>
        r.nodeId === WG_LEADER_NODE_ID && r.status !== 'canceled' && r.rerunCause !== 'wg-gate',
    ).length
  }
  return state.hostRuns.filter((r) => r.nodeId === WG_MEMBER_NODE_ID && r.status !== 'canceled')
    .length
}

function currentRound(state: EngineDbState): number {
  return countRoundsUsed(state)
}

// ---------------------------------------------------------------------------
// prompt composition
// ---------------------------------------------------------------------------

function composeLeaderPrompt(state: EngineDbState): string {
  const { config } = state
  const ledger = state.assignments.map((a) => {
    const resultMsg =
      a.resultMessageId !== null ? state.messages.find((m) => m.id === a.resultMessageId) : null
    return { assignment: a, resultSummary: resultMsg?.bodyMd ?? null }
  })
  const cursor = state.cursors.get(config.leaderMemberId ?? '') ?? ''
  const fresh = state.messages.filter((m) => m.id > cursor)
  const blocks = [
    renderCharterBlock(config),
    // RFC-176: the leader owns goal decomposition — carry it every turn.
    renderGoalBlock(config),
    renderRosterBlock(config, {
      excludeMemberId: config.leaderMemberId ?? undefined,
      agentCards: state.agentCards,
    }),
    renderLeaderLedger(config, ledger),
    renderMessagesBlock(config, 'New activity since your last turn', fresh),
  ]
  if (state.gate.rejected) {
    blocks.push(
      [
        '## Completion gate REJECTED',
        '',
        `A human rejected your completion declaration${state.gate.rejectedComment ? `: ${state.gate.rejectedComment}` : '.'}`,
        'Address the feedback and continue coordinating.',
      ].join('\n'),
    )
  }
  return blocks.filter((b) => b.length > 0).join('\n\n')
}

function composeMemberPrompt(
  state: EngineDbState,
  memberId: string,
  assignment: WorkgroupAssignment | null,
): string {
  const { config } = state
  const slices = selectMemberSlices(config, memberId, {
    assignments: state.assignments,
    messages: state.messages,
    cursorMessageId: state.cursors.get(memberId) ?? '',
  })
  const blocks = [renderCharterBlock(config)]
  // RFC-176: free_collab has no leader to decompose the goal — every member
  // owns it, so all members see it. A leader_worker worker never does: it acts
  // on the leader's assignment brief ('## Your assignment') below.
  if (config.mode === 'free_collab') blocks.push(renderGoalBlock(config))
  blocks.push(
    renderRosterBlock(config, { excludeMemberId: memberId, agentCards: state.agentCards }),
  )
  if (assignment !== null) {
    blocks.push(
      ['## Your assignment', '', `Title: ${assignment.title}`, '', assignment.briefMd].join('\n'),
    )
  } else {
    blocks.push(
      [
        '## Message turn',
        '',
        'You were woken because teammates (or a human) messaged you — respond or',
        'record what matters. Do NOT claim or start任务 work in this turn.',
      ].join('\n'),
    )
  }
  if (slices.peerResults.length > 0) {
    blocks.push(renderMessagesBlock(config, 'Teammate results', slices.peerResults))
  }
  if (slices.mentions.length > 0) {
    blocks.push(renderMessagesBlock(config, 'Messages addressed to you', slices.mentions))
  }
  if (slices.blackboard.length > 0) {
    blocks.push(renderMessagesBlock(config, 'Group blackboard (recent)', slices.blackboard))
  }
  return blocks.filter((b) => b.length > 0).join('\n\n')
}

// ---------------------------------------------------------------------------
// the engine
// ---------------------------------------------------------------------------

export async function runWorkgroupEngine(
  args: WorkgroupEngineArgs,
): Promise<WorkgroupEngineResult> {
  const { db, taskId, log } = args

  // In-flight turns keyed by a stable wake-item key. Values resolve when the
  // turn (incl. envelope effects) has been fully persisted.
  const inflight = new Map<string, Promise<void>>()
  // node_run ids MINTED BY THIS ENGINE INSTANCE. Adoption (below) exists for
  // rows created OUTSIDE the loop — clarify-answer reruns, crash recovery —
  // and must never re-drive a row a live driver just minted (the fake-hook
  // test harness surfaces this instantly; real runNode also has a pending→
  // running gap wide enough to race a fast turn completion).
  const mintedHere = new Set<string>()
  // Fatal turn errors (leader unresolvable / persistent protocol violation)
  // fail the TASK on the next pass instead of hot-looping the same wake item.
  let fatalError: { summary: string; message: string } | null = null
  const reportFatal = (summary: string, message: string): void => {
    if (fatalError === null) fatalError = { summary, message }
  }
  const inflightMeta = {
    leaderRunning: false,
    runningAssignmentIds: new Set<string>(),
    messageTurnMemberIds: new Set<string>(),
  }

  // RFC-176: seed the goal into the room as an opening directive, ONCE, before
  // the first turn — so the leader's initial turn has actionable "new activity"
  // (not just a passive header) and the goal is visible in the room. Idempotent:
  // runTask CAS ⇒ single engine instance, and the empty-room guard means a
  // daemon restart (message already persisted) never re-seeds. leader_worker →
  // directed to the leader (chat + mention ⇒ non-public ⇒ workers never see it);
  // free_collab → public blackboard (every member decomposes it).
  {
    const seed = await loadDbState(db, taskId)
    if (
      seed !== null &&
      seed.config.mode !== 'dynamic_workflow' &&
      countRoundsUsed(seed) === 0 &&
      seed.messages.length === 0 &&
      seed.config.goal.trim().length > 0
    ) {
      const leaderId = seed.config.leaderMemberId
      const directed = seed.config.mode === 'leader_worker' && leaderId !== null
      await postMessage(db, taskId, {
        round: 0,
        authorKind: 'system',
        kind: 'chat',
        bodyMd: seed.config.goal.trim(),
        mentionMemberIds: directed ? [leaderId] : [],
      })
    }
  }

  // RFC-186 PR-2 — ONCE at engine (re)entry, unwedge any `running` assignment
  // whose worker node_run is already terminal (daemon-restart mid-worker-run):
  // adoption is pending-only, so without this the assignment blocks the leader
  // barrier forever and the resumed task just re-parks (audit §4/§5 F1).
  {
    const rec = await loadDbState(db, taskId)
    if (rec !== null) await reconcileRunningAssignments(db, taskId, rec, log)
  }

  for (;;) {
    if (args.signal?.aborted === true) {
      await Promise.allSettled(inflight.values())
      return { kind: 'canceled' }
    }

    args.registerMint = (id: string) => mintedHere.add(id)
    if (fatalError !== null) {
      await Promise.allSettled(inflight.values())
      return { kind: 'failed', detail: fatalError }
    }

    const state = await loadDbState(db, taskId)
    if (state === null) {
      return {
        kind: 'failed',
        detail: {
          summary: 'workgroup config missing or invalid',
          message: 'workgroup_config_json unreadable',
        },
      }
    }

    // Adopt pending host rows minted outside this loop (clarify-answer
    // reruns, crash recovery) so they are driven instead of duplicated.
    const adoptable = state.hostRuns.filter(
      (r) => r.status === 'pending' && !inflight.has(`run:${r.id}`) && !mintedHere.has(r.id),
    )
    for (const row of adoptable) {
      const key = `run:${row.id}`
      inflight.set(
        key,
        driveAdoptedRun(args, state, row)
          .catch((err: unknown) => {
            const message = err instanceof Error ? err.message : String(err)
            args.log.error('adopted workgroup run threw', { rowId: row.id, error: message })
            if (row.nodeId === WG_LEADER_NODE_ID) {
              reportFatal('workgroup leader turn failed', message)
            }
          })
          .finally(() => {
            inflight.delete(key)
            if (row.nodeId === WG_LEADER_NODE_ID) inflightMeta.leaderRunning = false
            else if (row.shardKey !== null && !row.shardKey.startsWith('msg:')) {
              inflightMeta.runningAssignmentIds.delete(row.shardKey)
            }
          }),
      )
      if (row.nodeId === WG_LEADER_NODE_ID) inflightMeta.leaderRunning = true
      else if (row.shardKey !== null && !row.shardKey.startsWith('msg:')) {
        inflightMeta.runningAssignmentIds.add(row.shardKey)
      }
    }

    // A leader-host run parked on a clarify round occupies the leader slot:
    // it resumes via an adopted clarify-answer rerun, never via a fresh wake.
    const leaderParked = state.hostRuns.some(
      (r) => r.nodeId === WG_LEADER_NODE_ID && r.status === 'awaiting_human',
    )
    const wakeInput: WakeInput = {
      config: state.config,
      assignments: state.assignments,
      messages: state.messages,
      cursors: state.cursors,
      inFlight: {
        leaderRunning: inflightMeta.leaderRunning || leaderParked,
        runningAssignmentIds: inflightMeta.runningAssignmentIds,
        messageTurnMemberIds: inflightMeta.messageTurnMemberIds,
      },
      roundsUsed: countRoundsUsed(state),
      gate: {
        declaredDone: state.gate.declaredDone,
        awaitingConfirmation: state.gate.awaitingConfirmation,
        rejected: state.gate.rejected,
      },
    }
    const wake = deriveWakeSet(wakeInput)

    for (const item of wake.items) {
      const key = wakeKey(item)
      if (inflight.has(key)) continue
      markInflight(inflightMeta, item, true)
      inflight.set(
        key,
        driveWakeItem(args, state, item, reportFatal).finally(() => {
          inflight.delete(key)
          markInflight(inflightMeta, item, false)
        }),
      )
    }

    if (inflight.size === 0) {
      const outcome = decideWorkgroupOutcome(wakeInput, wake)
      switch (outcome.kind) {
        case 'running':
          // Nothing driveable yet nothing terminal — should not happen; avoid
          // a hot loop by treating it as a human-parking stall.
          log.warn('workgroup engine: running outcome with empty in-flight set', { taskId })
          return { kind: 'awaiting_human' }
        case 'done': {
          if (state.config.mode === 'free_collab') {
            const doneCards = state.assignments.filter((a) => a.status === 'done')
            const lines = doneCards.map((a) => {
              const result =
                a.resultMessageId !== null
                  ? state.messages.find((m) => m.id === a.resultMessageId)?.bodyMd
                  : null
              return `- ${a.title}${result ? `: ${result}` : ''}`
            })
            await postMessage(db, taskId, {
              round: currentRound(state),
              authorKind: 'system',
              kind: 'decision',
              bodyMd:
                lines.length > 0
                  ? `free-collab converged — ${doneCards.length} task(s) done:\n${lines.join('\n')}`
                  : 'free-collab converged with no completed tasks',
            })
          }
          await cancelLeftovers(db, taskId, state)
          if (state.config.mode === 'leader_worker' && !state.gate.declaredDone) {
            // unreachable by construction (done implies declaredDone in lw)
            log.warn('workgroup engine: lw done without declaration', { taskId })
          }
          if (
            resolveCompletionGate(state.config.autonomous ?? false, state.config.completionGate) &&
            !state.gate.approved &&
            !state.gate.awaitingConfirmation
          ) {
            await openCompletionGate(args, state)
            return {
              kind: 'awaiting_review',
              detail: { summary: 'workgroup completion gate', message: 'wg-gate' },
            }
          }
          return { kind: 'ok' }
        }
        case 'awaiting_gate': {
          if (state.gate.approved) return { kind: 'ok' } // PR-5 confirm approved
          if (!state.gate.awaitingConfirmation) {
            await openCompletionGate(args, state)
          }
          return {
            kind: 'awaiting_review',
            detail: { summary: 'workgroup completion gate', message: 'wg-gate' },
          }
        }
        case 'leader-nudge': {
          // RFC-180: an autonomous idle leader — drop a directed system nudge and
          // loop; the leader wakes on it as new content. countTrailingNudges caps
          // consecutive no-progress nudges (WG_AUTONOMOUS_NUDGE_LIMIT), and the
          // leader must actually run between nudges, so this can't hot-loop.
          const leaderId = state.config.leaderMemberId
          await postMessage(db, taskId, {
            round: currentRound(state),
            authorKind: 'system',
            kind: 'chat',
            bodyMd: WG_NUDGE_BODY,
            mentionMemberIds: leaderId !== null ? [leaderId] : [],
          })
          continue
        }
        case 'awaiting_human':
          return {
            kind: 'awaiting_human',
            detail: {
              summary:
                outcome.reason === 'leader-idle'
                  ? 'workgroup idle — waiting for human input'
                  : 'workgroup waiting on clarify answers / human delivery',
              message: outcome.reason,
            },
          }
        case 'failed': {
          const summary =
            outcome.reason === 'max-rounds'
              ? `workgroup hit max_rounds (${state.config.maxRounds})`
              : 'free_collab deadlock: open tasks but no claimable agent member'
          await postMessage(db, taskId, {
            round: currentRound(state),
            authorKind: 'system',
            kind: 'system',
            bodyMd: summary,
          })
          await cancelLeftovers(db, taskId, state)
          return { kind: 'failed', detail: { summary, message: outcome.reason } }
        }
      }
    }

    await Promise.race(inflight.values())
  }
}

function wakeKey(item: WakeItem): string {
  switch (item.kind) {
    case 'leader':
      return 'leader'
    case 'assignment':
      return `assignment:${item.assignmentId}`
    case 'message_turn':
      return `msg:${item.memberId}`
    case 'fc_initial':
      return `fc-init:${item.memberId}`
    case 'fc_claim':
      return `claim:${item.assignmentId}`
  }
}

function markInflight(
  meta: {
    leaderRunning: boolean
    runningAssignmentIds: Set<string>
    messageTurnMemberIds: Set<string>
  },
  item: WakeItem,
  on: boolean,
): void {
  switch (item.kind) {
    case 'leader':
      meta.leaderRunning = on
      break
    case 'assignment':
    case 'fc_claim':
      if (on) meta.runningAssignmentIds.add(item.assignmentId)
      else meta.runningAssignmentIds.delete(item.assignmentId)
      break
    case 'message_turn':
    case 'fc_initial':
      if (on) meta.messageTurnMemberIds.add(item.memberId)
      else meta.messageTurnMemberIds.delete(item.memberId)
      break
  }
}

async function cancelLeftovers(db: DbClient, taskId: string, state: EngineDbState): Promise<void> {
  for (const a of state.assignments) {
    if (
      a.status === 'open' ||
      a.status === 'dispatched' ||
      a.status === 'awaiting_human' ||
      a.status === 'delivered'
    ) {
      await casAssignmentStatus(db, a.id, a.status, 'canceled')
    }
  }
}

async function openCompletionGate(args: WorkgroupEngineArgs, state: EngineDbState): Promise<void> {
  const { db, taskId } = args
  // The gate holder run satisfies the lifecycle invariant "task
  // awaiting_review ⟹ ∃ awaiting_review node_run" (design §8.2, 设计门
  // Finding-2). Minted directly in awaiting_review — a non-frontier host row.
  const gateRunId = await mintNodeRun(db, {
    taskId,
    nodeId: WG_LEADER_NODE_ID,
    status: 'pending',
    cause: 'wg-gate',
  })
  await setNodeRunStatus({
    db,
    nodeRunId: gateRunId,
    to: 'awaiting_review',
    allowedFrom: ['pending'],
    reason: 'wg-gate-open',
  })
  await postMessage(db, taskId, {
    round: currentRound(state),
    authorKind: 'system',
    kind: 'system',
    bodyMd: `completion gate: waiting for human confirmation${state.gate.summary ? ` — ${state.gate.summary}` : ''}`,
  })
  await persistGate(db, taskId, state.rawConfig, {
    ...state.gate,
    awaitingConfirmation: true,
    rejected: false,
    approved: false,
  })
  taskBroadcaster.broadcast(TASK_CHANNEL(taskId), {
    id: -1,
    type: 'wg.gate.updated',
    awaitingConfirmation: true,
  })
}

// ---------------------------------------------------------------------------
// turn drivers
// ---------------------------------------------------------------------------

async function resolveMemberAgent(
  args: WorkgroupEngineArgs,
  state: EngineDbState,
  memberId: string,
): Promise<Agent | null> {
  const member = memberById(state.config, memberId)
  if (member === null || member.memberType !== 'agent' || member.agentName === null) return null
  return getAgent(args.db, member.agentName)
}

async function driveWakeItem(
  args: WorkgroupEngineArgs,
  state: EngineDbState,
  item: WakeItem,
  reportFatal: (summary: string, message: string) => void,
): Promise<void> {
  const { db, taskId, log } = args
  try {
    switch (item.kind) {
      case 'leader':
        await driveLeaderTurn(args, state)
        return
      case 'assignment': {
        const assignment = state.assignments.find((a) => a.id === item.assignmentId)
        if (assignment === undefined || assignment.assigneeMemberId === null) return
        await driveAssignmentTurn(args, state, assignment)
        return
      }
      case 'fc_claim': {
        const assignment = state.assignments.find((a) => a.id === item.assignmentId)
        if (assignment === undefined) return
        // Platform-side claim (CAS open→dispatched); a lost race just skips.
        const claimed = await casAssignmentStatus(db, assignment.id, 'open', 'dispatched', {
          assigneeMemberId: item.memberId,
        })
        if (!claimed) return
        await driveAssignmentTurn(
          args,
          {
            ...state,
            assignments: state.assignments.map((a) =>
              a.id === assignment.id
                ? { ...a, assigneeMemberId: item.memberId, status: 'dispatched' }
                : a,
            ),
          },
          { ...assignment, assigneeMemberId: item.memberId, status: 'dispatched' },
        )
        return
      }
      case 'message_turn':
      case 'fc_initial':
        await driveMessageTurn(args, state, item.memberId, item.kind === 'fc_initial')
        return
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log.error('workgroup turn threw', { taskId, item: wakeKey(item), error: message })
    await postMessage(db, taskId, {
      round: currentRound(state),
      authorKind: 'system',
      kind: 'system',
      bodyMd: `internal error driving ${wakeKey(item)}: ${message}`,
    })
    // Convergence on throw: a leader failure is unrecoverable by the loop
    // (the same wake condition would re-fire forever) → fail the task; an
    // assignment turn that threw BEFORE reaching its own failure handling
    // (e.g. mint error) must move the row off dispatched/running or the wake
    // pass would re-derive and re-throw it forever (the 2026-07-10 hang).
    if (item.kind === 'leader') {
      reportFatal('workgroup leader turn failed', message)
    } else if (item.kind === 'assignment' || item.kind === 'fc_claim') {
      const failedFromDispatched = await casAssignmentStatus(
        db,
        item.assignmentId,
        'dispatched',
        'failed',
      ).catch(() => false)
      if (!failedFromDispatched) {
        await casAssignmentStatus(db, item.assignmentId, 'running', 'failed').catch(() => false)
      }
    }
  }
}

/** Drive a pending host row that already exists (clarify-answer rerun / crash). */
async function driveAdoptedRun(
  args: WorkgroupEngineArgs,
  state: EngineDbState,
  row: typeof nodeRuns.$inferSelect,
): Promise<void> {
  const { db, log } = args
  if (row.nodeId === WG_LEADER_NODE_ID) {
    await driveLeaderTurn(args, state, row.id)
    return
  }
  const shardKey = row.shardKey
  if (shardKey === null || shardKey.startsWith('msg:')) {
    // adopted message turn — re-drive with the member parsed from the key
    const memberId = shardKey?.split(':')[1]
    if (memberId !== undefined) await driveMessageTurn(args, state, memberId, false, row.id)
    return
  }
  const assignment = state.assignments.find((a) => a.id === shardKey)
  if (assignment === undefined) {
    log.warn('adopted member run without assignment — cancelling row', { rowId: row.id })
    return
  }
  // clarify-answer rerun: assignment parked awaiting_human → back to running.
  if (assignment.status === 'awaiting_human') {
    await casAssignmentStatus(db, assignment.id, 'awaiting_human', 'running', {
      nodeRunId: row.id,
    })
  }
  await driveAssignmentTurn(args, state, { ...assignment, status: 'running' }, row.id)
}

async function driveLeaderTurn(
  args: WorkgroupEngineArgs,
  state: EngineDbState,
  adoptedRunId?: string,
): Promise<void> {
  const { db, taskId, hooks } = args
  const config = state.config
  const leaderId = config.leaderMemberId
  if (leaderId === null) return
  const leaderAgent = await resolveMemberAgent(args, state, leaderId)
  if (leaderAgent === null) {
    await postMessage(db, taskId, {
      round: currentRound(state),
      authorKind: 'system',
      kind: 'system',
      bodyMd: `leader agent unresolvable (${memberDisplayName(config, leaderId)}) — failing task`,
    })
    throw new Error('workgroup leader agent unresolvable')
  }

  let errorNotice: string | null = null
  for (let attempt = 0; attempt <= WG_PROTOCOL_RETRIES; attempt++) {
    let runId = adoptedRunId
    if (runId === undefined || attempt > 0) {
      runId = await mintNodeRun(db, {
        taskId,
        nodeId: WG_LEADER_NODE_ID,
        status: 'pending',
        cause: 'wg-leader-round',
        retryIndex: state.hostRuns.filter((r) => r.nodeId === WG_LEADER_NODE_ID).length + attempt,
      })
      args.registerMint?.(runId)
      broadcastPendingMint(taskId, runId, WG_LEADER_NODE_ID)
    }
    adoptedRunId = undefined

    const prompt =
      composeLeaderPrompt(state) +
      (errorNotice !== null
        ? `\n\n## Protocol errors in your previous reply\n\n${errorNotice}\n\nRe-emit a CORRECT envelope.`
        : '')
    await advanceMemberCursor(db, taskId, leaderId, maxMessageId(state.messages))

    const result = await hooks.runHostNode({
      nodeRunId: runId,
      nodeId: WG_LEADER_NODE_ID,
      agent: leaderAgent,
      promptTemplate: prompt,
      workgroupProtocolBlock: renderWgProtocolBlock('leader', config),
      hostOutputPorts: wgHostRolePorts('leader'),
      clarifyEnabled: resolveClarifyEnabled(config.autonomous ?? false),
    })
    if (result.status === 'canceled') return
    if (result.status === 'awaiting') return // leader asked the human — task parks via outcome pass
    if (result.status === 'failed') {
      const msg = result.errorMessage ?? 'leader run failed'
      // RFC-181 C — the run's <workflow-clarify> was hard-suppressed
      // (autonomous; persisted failed:clarify-forbidden by runNode / the
      // hook's mid-run-toggle correction). Re-prompt the leader to decide by
      // itself; when retries run dry, DROP-AND-CONTINUE (no throw, no park) —
      // the leader slides into idle and the autonomous nudge / round caps
      // take over (design §2.2). Distinct from the malformed
      // `clarify-questions-` family below, whose exhaustion is fatal.
      if (msg.startsWith(CLARIFY_FORBIDDEN_PREFIX)) {
        if (attempt < WG_PROTOCOL_RETRIES) {
          errorNotice =
            '- Ask-back is OFF in this autonomous group. Do NOT emit <workflow-clarify>.\n' +
            '  Proceed with your best judgment and emit wg_decision / wg_assignments as usual.'
          continue
        }
        return
      }
      // RFC-186 §2.2 — every OTHER failure routes through the SAME
      // `FOLLOWUP_POLICY` table normal nodes use. This collapses the old
      // order-sensitive `startsWith('clarify-questions-')` string chain AND the
      // per-code `failureCode === 'envelope-missing'` special-case into one
      // structured decision: a code in the table (envelope-missing /
      // clarify-questions-malformed / envelope-port-malformed / port-validation
      // / both-present / clarify-required) is a RETRYABLE model slip — one FRESH
      // turn with a reason-tailored notice (keeping the wg protocol block) beats
      // fataling the whole multi-agent task on model noise. An unstructured
      // failure (undefined failureCode: iso-setup, injection, subprocess crash,
      // merge-back conflict) is genuinely fatal → throw → reportFatal.
      const fu = followupForFailure(result.failureCode)
      if (fu.retry && attempt < WG_PROTOCOL_RETRIES) {
        errorNotice = wgFollowupNotice(fu.reason)
        continue
      }
      throw new Error(msg)
    }

    const roster = rosterDisplayNames(config)
    const decisionRaw = result.outputs[WG_PORT_DECISION]
    const assignmentsRaw = result.outputs[WG_PORT_ASSIGNMENTS]
    const messagesRaw = result.outputs[WG_PORT_MESSAGES]
    const errors: string[] = []
    const decision = decisionRaw !== undefined ? parseWgDecisionPort(decisionRaw) : null
    if (decision === null) errors.push('missing required port wg_decision')
    else if (!decision.ok) errors.push(...decision.errors.map((e) => `wg_decision: ${e}`))
    const dispatches =
      assignmentsRaw !== undefined
        ? parseWgAssignmentsPort(assignmentsRaw, roster, {
            // RFC-185 D4 (Codex T6 P1) — OFF is enforced here, not just in the
            // prompt: same-member duplicates reject the port whole and re-
            // prompt via the malformed-retry channel.
            allowSameMemberFanOut: config.fanOut === true,
          })
        : { ok: true as const, value: [] }
    if (!dispatches.ok) errors.push(...dispatches.errors.map((e) => `wg_assignments: ${e}`))
    const outMessages =
      messagesRaw !== undefined
        ? parseWgMessagesPort(messagesRaw, roster)
        : { ok: true as const, value: [] }
    if (!outMessages.ok) errors.push(...outMessages.errors.map((e) => `wg_messages: ${e}`))

    if (errors.length > 0) {
      errorNotice = errors.map((e) => `- ${e}`).join('\n')
      if (attempt === WG_PROTOCOL_RETRIES) {
        throw new Error(`leader protocol violation: ${errors.join('; ')}`)
      }
      continue
    }

    const round = currentRound(state) + 1
    // 1. persist leader messages (targets validated; leader may always DM).
    if (outMessages.ok) {
      await persistWgMessages(db, taskId, config, round, leaderId, outMessages.value, {
        allowDirect: true,
        allowBlackboard: true,
      })
    }
    // 2. dispatch assignments (agent members start immediately via next pass;
    //    human members become awaiting-delivery cards — PR-5 unlocks launch).
    if (dispatches.ok) {
      for (const d of dispatches.value) {
        const member = config.members.find((m) => m.displayName === d.member)
        if (member === undefined) continue
        const id = ulid()
        await db.insert(workgroupAssignments).values({
          id,
          taskId,
          round,
          source: 'leader',
          createdByRunId: runId,
          assigneeMemberId: member.id,
          title: d.title,
          briefMd: d.brief,
          status: 'dispatched',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        })
        await postMessage(db, taskId, {
          round,
          authorKind: 'member',
          authorMemberId: leaderId,
          kind: 'dispatch',
          bodyMd: `@${d.member} ${d.title}`,
          mentionMemberIds: [member.id],
          assignmentId: id,
        })
      }
    }
    // 3. deliveries the leader just consumed flip delivered→done (design
    //    §1.4: delivered = 交付已落, done = 下一回合已消费).
    for (const a of state.assignments) {
      if (a.status === 'delivered') {
        await casAssignmentStatus(db, a.id, 'delivered', 'done').catch(() => false)
      }
    }
    // 4. decision.
    if (decision !== null && decision.ok) {
      if (decision.value.action === 'done') {
        await postMessage(db, taskId, {
          round,
          authorKind: 'member',
          authorMemberId: leaderId,
          kind: 'decision',
          bodyMd: decision.value.summary ?? '',
        })
        await persistGate(db, taskId, state.rawConfig, {
          ...state.gate,
          declaredDone: true,
          rejected: false,
          ...(decision.value.summary !== undefined ? { summary: decision.value.summary } : {}),
        })
      } else if (state.gate.rejected) {
        // leader consumed the rejection — clear the flag so it doesn't re-wake.
        await persistGate(db, taskId, state.rawConfig, { ...state.gate, rejected: false })
      }
    }
    return
  }
}

async function driveAssignmentTurn(
  args: WorkgroupEngineArgs,
  state: EngineDbState,
  assignment: WorkgroupAssignment,
  adoptedRunId?: string,
): Promise<void> {
  const { db, taskId, hooks } = args
  const config = state.config
  const memberId = assignment.assigneeMemberId
  if (memberId === null) return
  const agent = await resolveMemberAgent(args, state, memberId)
  if (agent === null) {
    await casAssignmentStatus(db, assignment.id, assignment.status, 'failed').catch(() => false)
    await postMessage(db, taskId, {
      round: assignment.round,
      authorKind: 'system',
      kind: 'system',
      bodyMd: `assignment '${assignment.title}' failed: agent for @${memberDisplayName(config, memberId)} unresolvable`,
      assignmentId: assignment.id,
    })
    return
  }

  let errorNotice: string | null = null
  for (let attempt = 0; attempt <= WG_PROTOCOL_RETRIES; attempt++) {
    let runId = adoptedRunId
    if (runId === undefined || attempt > 0) {
      runId = await mintNodeRun(db, {
        taskId,
        nodeId: WG_MEMBER_NODE_ID,
        status: 'pending',
        cause: 'wg-assignment',
        retryIndex:
          state.hostRuns.filter(
            (r) => r.nodeId === WG_MEMBER_NODE_ID && r.shardKey === assignment.id,
          ).length + attempt,
        overrides: { shardKey: assignment.id, agentOverrideName: agent.name },
      })
      args.registerMint?.(runId)
      broadcastPendingMint(taskId, runId, WG_MEMBER_NODE_ID)
    }
    adoptedRunId = undefined

    if (assignment.status === 'dispatched') {
      await casAssignmentStatus(db, assignment.id, 'dispatched', 'running', { nodeRunId: runId })
      assignment = { ...assignment, status: 'running', nodeRunId: runId }
    } else {
      await db
        .update(workgroupAssignments)
        .set({ nodeRunId: runId, updatedAt: Date.now() })
        .where(eq(workgroupAssignments.id, assignment.id))
    }

    const prompt =
      composeMemberPrompt(state, memberId, assignment) +
      (errorNotice !== null
        ? `\n\n## Protocol errors in your previous reply\n\n${errorNotice}\n\nRe-emit a CORRECT envelope.`
        : '')
    await advanceMemberCursor(db, taskId, memberId, maxMessageId(state.messages))

    const result = await hooks.runHostNode({
      nodeRunId: runId,
      nodeId: WG_MEMBER_NODE_ID,
      agent,
      promptTemplate: prompt,
      workgroupProtocolBlock: renderWgProtocolBlock(
        config.mode === 'free_collab' ? 'fc_member' : 'worker',
        config,
      ),
      hostOutputPorts: wgHostRolePorts(config.mode === 'free_collab' ? 'fc_member' : 'worker'),
      clarifyEnabled: resolveClarifyEnabled(config.autonomous ?? false),
    })
    if (result.status === 'canceled') {
      await casAssignmentStatus(db, assignment.id, 'running', 'canceled').catch(() => false)
      return
    }
    if (result.status === 'awaiting') {
      await casAssignmentStatus(db, assignment.id, 'running', 'awaiting_human')
      return
    }
    if (result.status === 'failed') {
      // RFC-181 C — suppressed ask-back is a RETRYABLE protocol nudge for the
      // member too: re-prompt it to proceed on its own; exhaustion falls
      // through to the normal failed handling (assignment failed floats up on
      // the card — never a park).
      const failMsg = result.errorMessage ?? 'run failed'
      if (failMsg.startsWith(CLARIFY_FORBIDDEN_PREFIX) && attempt < WG_PROTOCOL_RETRIES) {
        errorNotice =
          '- Ask-back is OFF in this autonomous group. Do NOT emit <workflow-clarify>.\n' +
          '  Proceed with your best judgment and emit wg_result as usual.'
        continue
      }
      // RFC-186 §2.2 — same unified FOLLOWUP_POLICY routing as the leader turn:
      // a structured (retryable) failureCode → one fresh reason-tailored retry;
      // unstructured (fatal) or exhausted → assignment failed (floats up on the
      // card, never a park). Collapses the old envelope-missing special-case.
      const fu = followupForFailure(result.failureCode)
      if (fu.retry && attempt < WG_PROTOCOL_RETRIES) {
        errorNotice = wgFollowupNotice(fu.reason)
        continue
      }
      await casAssignmentStatus(db, assignment.id, 'running', 'failed')
      await postMessage(db, taskId, {
        round: assignment.round,
        authorKind: 'system',
        kind: 'system',
        bodyMd: `assignment '${assignment.title}' failed: ${result.errorMessage ?? 'run failed'}`,
        assignmentId: assignment.id,
      })
      if (config.mode === 'free_collab') {
        // bounded re-open (retry budget) — count LIVE, not the turn-start
        // snapshot, or every failure sees a stale low count and reopens
        // past the cap.
        const priorRuns = (
          await db
            .select({ id: nodeRuns.id })
            .from(nodeRuns)
            .where(and(eq(nodeRuns.taskId, taskId), eq(nodeRuns.shardKey, assignment.id)))
        ).length
        if (priorRuns < 3) {
          await casAssignmentStatus(db, assignment.id, 'failed', 'open', {
            assigneeMemberId: null,
            nodeRunId: null,
          })
        }
      }
      return
    }

    // done — require wg_result.
    const roster = rosterDisplayNames(config)
    const resultRaw = result.outputs[WG_PORT_RESULT]
    const parsedResult = resultRaw !== undefined ? parseWgResultPort(resultRaw) : null
    const errors: string[] = []
    if (parsedResult === null) errors.push('missing required port wg_result')
    else if (!parsedResult.ok) errors.push(...parsedResult.errors.map((e) => `wg_result: ${e}`))
    const messagesRaw = result.outputs[WG_PORT_MESSAGES]
    const outMessages =
      messagesRaw !== undefined
        ? parseWgMessagesPort(messagesRaw, roster)
        : { ok: true as const, value: [] }
    if (!outMessages.ok) errors.push(...outMessages.errors.map((e) => `wg_messages: ${e}`))

    if (errors.length > 0) {
      errorNotice = errors.map((e) => `- ${e}`).join('\n')
      if (attempt === WG_PROTOCOL_RETRIES) {
        await casAssignmentStatus(db, assignment.id, 'running', 'failed')
        await postMessage(db, taskId, {
          round: assignment.round,
          authorKind: 'system',
          kind: 'system',
          bodyMd: `assignment '${assignment.title}' failed: protocol violation (${errors.join('; ')})`,
          assignmentId: assignment.id,
        })
        return
      }
      continue
    }

    const switches = resolveWorkgroupSwitches(config.mode, config.switches)
    if (outMessages.ok && outMessages.value.length > 0) {
      await persistWgMessages(db, taskId, config, assignment.round, memberId, outMessages.value, {
        allowDirect: switches.directMessages,
        allowBlackboard: switches.blackboard,
      })
    }
    await consumeTasksAdd(db, taskId, state, memberId, result.outputs[WG_PORT_TASKS_ADD])
    const resultMessageId = await postMessage(db, taskId, {
      round: assignment.round,
      authorKind: 'member',
      authorMemberId: memberId,
      kind: 'result',
      bodyMd: parsedResult !== null && parsedResult.ok ? parsedResult.value.summary : '',
      assignmentId: assignment.id,
    })
    await casAssignmentStatus(db, assignment.id, 'running', 'done', { resultMessageId })
    return
  }
}

async function driveMessageTurn(
  args: WorkgroupEngineArgs,
  state: EngineDbState,
  memberId: string,
  isFcInitial: boolean,
  adoptedRunId?: string,
): Promise<void> {
  const { db, taskId, hooks } = args
  const config = state.config
  const agent = await resolveMemberAgent(args, state, memberId)
  if (agent === null) return

  let runId = adoptedRunId
  if (runId === undefined) {
    runId = await mintNodeRun(db, {
      taskId,
      nodeId: WG_MEMBER_NODE_ID,
      status: 'pending',
      cause: 'wg-message-turn',
      retryIndex: state.hostRuns.filter((r) => r.nodeId === WG_MEMBER_NODE_ID).length,
      overrides: {
        shardKey: `msg:${memberId}:${maxMessageId(state.messages) || '0'}`,
        agentOverrideName: agent.name,
      },
    })
    args.registerMint?.(runId)
    broadcastPendingMint(taskId, runId, WG_MEMBER_NODE_ID)
  }

  const fcAddendum = isFcInitial
    ? [
        '## Initial planning turn',
        '',
        'The shared task list is empty. Break the group goal into concrete',
        'tasks (wg_tasks_add) — check the blackboard first to avoid duplicating',
        'what teammates already proposed. You may also record findings via',
        'wg_result.',
      ].join('\n')
    : null
  const prompt =
    composeMemberPrompt(state, memberId, null) + (fcAddendum !== null ? `\n\n${fcAddendum}` : '')
  await advanceMemberCursor(db, taskId, memberId, maxMessageId(state.messages))

  const role = config.mode === 'free_collab' ? ('fc_member' as const) : ('worker' as const)
  const result = await hooks.runHostNode({
    nodeRunId: runId,
    nodeId: WG_MEMBER_NODE_ID,
    agent,
    promptTemplate: prompt,
    workgroupProtocolBlock: renderWgProtocolBlock(role, config),
    hostOutputPorts: wgHostRolePorts(role),
    clarifyEnabled: resolveClarifyEnabled(config.autonomous ?? false),
  })
  // RFC-186 §2.2 (audit §2 P1-7) — a failed message turn used to `return`
  // silently: the @-mentioned member appeared to ignore the message, the room
  // showed nothing, and debugging was blind. Surface the failure as a system
  // note so the black hole is visible. (A bounded RETRY loop for message turns
  // — mirroring leader/assignment — is deferred: this path is off the
  // dispatch-to-done critical line; the visibility fix addresses the real harm.)
  if (result.status !== 'done') {
    if (result.status === 'failed') {
      await postMessage(db, taskId, {
        round: currentRound(state),
        authorKind: 'system',
        kind: 'system',
        bodyMd: `message turn for ${memberDisplayName(config, memberId)} failed: ${result.errorMessage ?? 'run failed'}`,
      })
    }
    return
  }

  const roster = rosterDisplayNames(config)
  const switches = resolveWorkgroupSwitches(config.mode, config.switches)
  const messagesRaw = result.outputs[WG_PORT_MESSAGES]
  const outMessages =
    messagesRaw !== undefined
      ? parseWgMessagesPort(messagesRaw, roster)
      : { ok: true as const, value: [] }
  if (outMessages.ok && outMessages.value.length > 0) {
    await persistWgMessages(db, taskId, config, currentRound(state), memberId, outMessages.value, {
      allowDirect: switches.directMessages,
      allowBlackboard: switches.blackboard,
    })
  }
  const resultRaw = result.outputs[WG_PORT_RESULT]
  if (resultRaw !== undefined) {
    const parsed = parseWgResultPort(resultRaw)
    if (parsed.ok) {
      await postMessage(db, taskId, {
        round: currentRound(state),
        authorKind: 'member',
        authorMemberId: memberId,
        kind: 'chat',
        bodyMd: parsed.value.summary,
      })
    }
  }
  await consumeTasksAdd(db, taskId, state, memberId, result.outputs[WG_PORT_TASKS_ADD])
}

// Per-task serialization for tasks_add consumption: two member turns
// finishing in the same tick would otherwise interleave their dedup read
// and insert (TOCTOU). One engine instance per task is guaranteed by the
// runTask CAS claim, so an in-process chain fully closes the race.
const tasksAddChains = new Map<string, Promise<unknown>>()
function serializeTasksAdd<T>(taskId: string, fn: () => Promise<T>): Promise<T> {
  const prev = tasksAddChains.get(taskId) ?? Promise.resolve()
  const next = prev.then(fn, fn)
  tasksAddChains.set(
    taskId,
    next.catch(() => undefined),
  )
  return next
}

/**
 * PR-6 (design §7.3) — consume a member's wg_tasks_add: normalized-title
 * dedup against every non-canceled card; dropped duplicates get a system
 * note instead of failing the run. Returns how many landed. Serialized
 * per task (see serializeTasksAdd).
 */
async function consumeTasksAdd(
  db: DbClient,
  taskId: string,
  state: EngineDbState,
  authorMemberId: string,
  raw: string | undefined,
): Promise<number> {
  if (raw === undefined || state.config.mode !== 'free_collab') return 0
  return serializeTasksAdd(taskId, () =>
    consumeTasksAddInner(db, taskId, state, authorMemberId, raw),
  )
}

async function consumeTasksAddInner(
  db: DbClient,
  taskId: string,
  state: EngineDbState,
  authorMemberId: string,
  raw: string,
): Promise<number> {
  const parsed = parseWgTasksAddPort(raw)
  if (!parsed.ok) {
    await postMessage(db, taskId, {
      round: currentRound(state),
      authorKind: 'system',
      kind: 'system',
      bodyMd: `wg_tasks_add from @${memberDisplayName(state.config, authorMemberId)} rejected: ${parsed.errors.join('; ')}`,
    })
    return 0
  }
  // LIVE read (not the turn-start snapshot): concurrent initial turns must
  // see each other's just-landed cards or the dedup guard is a no-op
  // (fc-debug 2026-07-10: dup card claimed 4×). A same-instant insert race
  // remains theoretically possible and is documented as v1 residual.
  const liveRows = await db
    .select({ dedupKey: workgroupAssignments.dedupKey, status: workgroupAssignments.status })
    .from(workgroupAssignments)
    .where(eq(workgroupAssignments.taskId, taskId))
  const existing = new Set(
    liveRows
      .filter((a) => a.status !== 'canceled' && a.dedupKey !== null)
      .map((a) => a.dedupKey as string),
  )
  let added = 0
  let dropped = 0
  for (const item of parsed.value) {
    const key = normalizeWgTaskTitle(item.title)
    if (existing.has(key)) {
      dropped++
      continue
    }
    existing.add(key)
    const id = ulid()
    await db.insert(workgroupAssignments).values({
      id,
      taskId,
      round: currentRound(state),
      source: 'self_claim',
      assigneeMemberId: null,
      title: item.title,
      briefMd: item.brief,
      status: 'open',
      dedupKey: key,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
    await postMessage(db, taskId, {
      round: currentRound(state),
      authorKind: 'member',
      authorMemberId,
      kind: 'dispatch',
      bodyMd: `+ task: ${item.title}`,
      assignmentId: id,
    })
    added++
  }
  if (dropped > 0) {
    await postMessage(db, taskId, {
      round: currentRound(state),
      authorKind: 'system',
      kind: 'system',
      bodyMd: `${dropped} duplicate task(s) from @${memberDisplayName(state.config, authorMemberId)} dropped (title dedup)`,
    })
  }
  return added
}

async function persistWgMessages(
  db: DbClient,
  taskId: string,
  config: WorkgroupRuntimeConfig,
  round: number,
  authorMemberId: string,
  items: readonly WgMessageItem[],
  allow: { allowDirect: boolean; allowBlackboard: boolean },
): Promise<void> {
  let dropped = 0
  for (const item of items) {
    if (item.to === null) {
      if (!allow.allowBlackboard && !allow.allowDirect) {
        dropped++
        continue
      }
      await postMessage(db, taskId, {
        round,
        authorKind: 'member',
        authorMemberId,
        kind: 'chat',
        bodyMd: item.body,
      })
      continue
    }
    if (!allow.allowDirect) {
      dropped++
      continue
    }
    const target = config.members.find((m) => m.displayName === item.to)
    if (target === undefined) {
      dropped++
      continue
    }
    await postMessage(db, taskId, {
      round,
      authorKind: 'member',
      authorMemberId,
      kind: 'chat',
      bodyMd: `@${item.to} ${item.body}`,
      mentionMemberIds: [target.id],
    })
  }
  if (dropped > 0) {
    await postMessage(db, taskId, {
      round,
      authorKind: 'system',
      kind: 'system',
      bodyMd: `${dropped} message(s) from @${memberDisplayName(config, authorMemberId)} dropped (visibility switches)`,
    })
  }
}

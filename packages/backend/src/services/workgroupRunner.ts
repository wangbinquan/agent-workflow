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
  DEFAULT_PROTOCOL_RETRY_BUDGET,
  FOLLOWUP_POLICY,
  fenceUntrusted,
  normalizeWgTaskTitle,
  parseWgAssignmentsPort,
  parseWgDecisionPort,
  parseWgMessagesPort,
  parseWgResultPort,
  parseWgTasksAddPort,
  perCardInputDescriptionBudget,
  renderAgentCapabilityCard,
  workgroupHasHumanMember,
  resolveCompletionGate,
  resolveWorkgroupSwitches,
  sanitizeInlineField,
  WG_PORT_ASSIGNMENTS,
  WG_PORT_DECISION,
  WG_PORT_MESSAGES,
  WG_PORT_RESULT,
  WG_PORT_TASKS_ADD,
  WorkgroupRuntimeConfigSchema,
  type Agent,
  type EnvelopeFollowupReason,
  type FailureCode,
  type RerunCause,
  type WgMessageItem,
  type WorkgroupAssignment,
  type WorkgroupMessage,
  type WorkgroupRuntimeConfig,
} from '@agent-workflow/shared'
import { and, asc, eq, inArray, isNull } from 'drizzle-orm'
import { monotonicFactory, ulid } from 'ulid'
import { KeyedSerialQueue } from '@/util/keyedSerialQueue'
import type { DbClient } from '@/db/client'
import { dbTxSync } from '@/db/txSync'
import {
  clarifySessions,
  nodeRuns,
  tasks,
  workgroupAssignments,
  workgroupMemberCursors,
  workgroupMessages,
} from '@/db/schema'
import { getAgent } from '@/services/agent'
import { isClarifyRerunCause, loadRunEnvelopeNonce, mintNodeRun } from '@/services/nodeRunMint'
import { setNodeRunStatus } from '@/services/lifecycle'
import { buildRoomMessageRow } from '@/services/workgroupMessages'
import {
  deriveRoundsUsed,
  resolveMessageRound,
  roundedModeOf,
  type RoundedWorkgroupMode,
} from '@/services/workgroupRounds'
import {
  advanceMemberCursor,
  casAssignmentStatus,
  dismissOpenClarifyParksForAutonomous,
  resolveWgClarifyAllowed,
} from '@/services/workgroupLifecycle'
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
  hasSalvageableWork,
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
  /** RFC-187 §4 — files changed in the canonical worktree vs its base commit
   *  (incl. untracked). Provided by scheduler (git); absent in pure-engine tests
   *  (the zero-delta warn is then skipped). */
  getCanonicalFilesChanged?: () => Promise<number>
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

/** Per-turn protocol-violation retries before the turn is failed. RFC-186 §2.4
 *  raised 1→3 to match the normal-node default; now structurally the SAME
 *  shared budget (a probabilistic model format slip deserves the same budget
 *  everywhere — the comment-only alignment is gone). */
const WG_PROTOCOL_RETRIES = DEFAULT_PROTOCOL_RETRY_BUDGET

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

/**
 * RFC-187 T13 / Codex P1-7① — is this host row an answered-clarify continuation that a
 * daemon restart killed BEFORE it ever ran? The answer commits (session→answered) and
 * mints a PENDING continuation row, then `resumeTask` is fire-and-forget; a crash in that
 * window has the boot reaper flip the pending row to `interrupted` while the TASK stays
 * `awaiting_human` (the reaper only reaps pending/running TASKS). auto-resume then only
 * scans `interrupted` tasks and adoption only takes `pending` rows — so the answered
 * continuation was wedged forever with no path back (the human's answer silently lost).
 * `interrupted` is terminal (no transition out), so recovery = re-mint, exactly like the
 * DAG's revival of a terminal row.
 */
export function isKilledClarifyContinuation(row: {
  status: string
  rerunCause: string | null
}): boolean {
  return row.status === 'interrupted' && isClarifyRerunCause(row.rerunCause)
}

/**
 * RFC-187 T13 — re-mint every host row {@link isKilledClarifyContinuation} identifies, so
 * the normal pending-adoption drives it (the Q&A is re-derived from the answered session,
 * so the fresh row carries the human's answer). Idempotent: after the re-mint the freshest
 * row for that (nodeId, shardKey) is `pending`, not `interrupted`, so a second pass is a
 * no-op. Only the FRESHEST row per (nodeId, shardKey) is revived — an older interrupted
 * continuation that a later row already superseded must stay history.
 */
async function reviveKilledClarifyContinuations(
  db: DbClient,
  taskId: string,
  state: EngineDbState,
  log: Logger,
): Promise<void> {
  const groups = new Map<string, Array<typeof nodeRuns.$inferSelect>>()
  for (const r of state.hostRuns) {
    const key = `${r.nodeId}\x00${r.shardKey ?? ''}`
    const g = groups.get(key)
    if (g === undefined) groups.set(key, [r])
    else g.push(r)
  }
  let revived = 0
  for (const g of groups.values()) {
    // hostRuns are loaded id-ascending, so the last entry is the freshest.
    const latest = g[g.length - 1]
    if (latest === undefined || !isKilledClarifyContinuation(latest)) continue
    await mintNodeRun(db, {
      taskId,
      nodeId: latest.nodeId,
      status: 'pending',
      // keep the clarify lineage cause: it is what re-injects the answered Q&A.
      cause: latest.rerunCause as RerunCause,
      retryIndex: Math.max(...g.map((r) => r.retryIndex)) + 1,
      iteration: latest.iteration,
      inheritFrom: latest,
      overrides: { startedAt: null, shardKey: latest.shardKey },
    })
    revived++
  }
  if (revived > 0) {
    log.info('workgroup revived clarify continuations killed by a restart', { taskId, revived })
  }
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
  /** RFC-187 F3 — open/closed clarify sessions for the task (source node + status).
   *  Feeds `deriveLeaderClarifyPark`; the SESSION (not the __wg_clarify__ run) is the
   *  authoritative, answerable park signal (Codex P0-1). */
  clarifySessions: Array<{ sourceAgentNodeId: string; status: string }>
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
const ROSTER_INPUT_DESCRIPTION_TOTAL_BUDGET = 2_400
const ROSTER_CARD_INPUT_DESCRIPTION_MAX = 240

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
  const agentMemberCount = config.members.filter((m) => m.memberType === 'agent').length
  const inputDescriptionBudget = perCardInputDescriptionBudget(
    ROSTER_INPUT_DESCRIPTION_TOTAL_BUDGET,
    agentMemberCount,
    ROSTER_CARD_INPUT_DESCRIPTION_MAX,
  )
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
    cards.set(
      m.id,
      renderAgentCapabilityCard(agent, {
        promptBudget: ROSTER_CARD_PROMPT_BUDGET,
        inputDescriptionBudget,
      }),
    )
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
  const [assignmentRows, messageRows, cursorRows, hostRuns, clarifySessionRows] = await Promise.all(
    [
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
      // RFC-187 F3 (Codex design-gate P0-1) — key the leader-clarify park on the
      // clarify SESSION, not the __wg_clarify__ run's shardKey: the run is minted
      // BEFORE the session/round in a non-atomic sequence, so a crash between them
      // leaves an orphan awaiting_human run with nothing to answer — a run-only signal
      // would park that forever. An open session proves the park is both a LEADER
      // clarify (sourceAgentNodeId) AND answerable.
      db
        .select({
          sourceAgentNodeId: clarifySessions.sourceAgentNodeId,
          status: clarifySessions.status,
        })
        .from(clarifySessions)
        .where(eq(clarifySessions.taskId, taskId)),
    ],
  )
  return {
    config: parsed.data,
    gate,
    rawConfig,
    assignments: assignmentRows.map(rowToAssignment),
    messages: messageRows.map(rowToMessage),
    cursors: new Map(cursorRows.map((c) => [c.memberId, c.lastConsumedMessageId])),
    hostRuns,
    clarifySessions: clarifySessionRows,
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
  /**
   * RFC-209 §2.3 —— **省略 = 写入时刻实时解析**（lw 取账本读数、fc 恒 0）。极性是有意的：
   * 默认就是正确行为，漏改点得到的是对的值而不是 round 0 那种硬错。
   * 只有两族显式传值：leader 轮自身产出（用该轮 `wgRound`——这一轮由它定义，账本此刻
   * 还没计入它）与派单卡族（走 {@link postAssignmentMessage}，用 `assignment.round`）。
   */
  round?: number
  authorKind: 'member' | 'human' | 'system'
  authorMemberId?: string | null
  kind: WorkgroupMessage['kind']
  bodyMd: string
  mentionMemberIds?: string[]
  assignmentId?: string | null
}

// RFC-186 Phase 3 (audit §3-4): room slicing / cursor advance assume message ids
// order lexically (workgroupContext.ts), but plain `ulid()` has a random suffix,
// so two posts in the SAME millisecond can order out of insertion order — and at
// a cursor boundary a later-inserted lower-ULID row can be treated as consumed
// and skip a re-wake. A monotonic factory guarantees strictly increasing ids
// within this engine instance (one instance per task, runTask CAS).
const nextMessageId = monotonicFactory()

/** 引擎侧的账本模式。dynamic_workflow 到不了回合引擎（见 countRoundsUsed 注释）。 */
function roundMode(config: WorkgroupRuntimeConfig): RoundedWorkgroupMode {
  return roundedModeOf(config.mode) ?? 'free_collab'
}

async function postMessage(
  db: DbClient,
  taskId: string,
  mode: RoundedWorkgroupMode,
  m: PostMessageArgs,
): Promise<string> {
  // RFC-209 §2.3-2 —— round 必须在 nextMessageId() **之前**解析。在铸 id 与 insert 之间
  // 新增一个 await 会加宽「同毫秒两条消息按 ULID 乱序」的窗口，而上面的 monotonicFactory
  // 正是 RFC-186 §3-4 为消除它才引入的。顺序恒为：解析 round → 铸 id → 插入。
  const round = m.round ?? (await resolveMessageRound(db, taskId, mode))
  const id = nextMessageId()
  await db.insert(workgroupMessages).values(
    buildRoomMessageRow({
      id,
      taskId,
      round,
      authorKind: m.authorKind,
      authorMemberId: m.authorMemberId ?? null,
      authorUserId: null,
      kind: m.kind,
      bodyMd: m.bodyMd,
      mentionMemberIds: m.mentionMemberIds,
      assignmentId: m.assignmentId ?? null,
      createdAt: Date.now(),
    }),
  )
  taskBroadcaster.broadcast(TASK_CHANNEL(taskId), {
    id: -1,
    type: 'wg.message.created',
    messageId: id,
    kind: m.kind,
  })
  return id
}

/**
 * 派单卡族（结果 / 失败 / 交付 / 取消）专用入口：`round` 恒取 `assignment.round`，
 * **不接受省略**。这一族的账本读数在定义上就是错答案——轮 2 派出、轮 7 才收工的长跑
 * worker，其结果消息若标成 round 7 就与它的派单卡脱钩，还会抢在 leader 轮 7 自己的产出
 * 之前插一条「第 7 回合」。所以它不适用 {@link PostMessageArgs.round} 的「省略即兜底」极性
 * （RFC-209 D13）。
 */
async function postAssignmentMessage(
  db: DbClient,
  taskId: string,
  mode: RoundedWorkgroupMode,
  assignment: Pick<WorkgroupAssignment, 'id' | 'round'>,
  m: Omit<PostMessageArgs, 'round' | 'assignmentId'>,
): Promise<string> {
  return postMessage(db, taskId, mode, {
    ...m,
    round: assignment.round,
    assignmentId: assignment.id,
  })
}

// ---------------------------------------------------------------------------
// round counting (durable — derived from node_runs each pass)
// ---------------------------------------------------------------------------

// RFC-209 — 推导本体搬到 services/workgroupRounds.ts（回合账本单一事实源），
// 引擎 / 写入侧 / 房间聚合三方读同一个数。口径未变：lw = max(wg_round) + NULL 尾巴、
// fc = 成员 run 行计数；唯一新增是「已被取代的被杀反问续跑行」排除（RFC-209 T7，
// 修的是同一逻辑回合被数两次）。
function countRoundsUsed(state: EngineDbState): number {
  // 回合引擎只对 lw / fc 分流（deriveWorkgroupDispatch），dynamic_workflow 到不了这里；
  // 万一到了就按 fc 计——与 RFC-209 之前的两分支写法逐值一致，不引入新的静默分支。
  return deriveRoundsUsed(roundedModeOf(state.config.mode) ?? 'free_collab', state.hostRuns)
}

/**
 * RFC-187 §3-7 (Codex impl-gate P1) — is an ADOPTED leader run the grace wrap-up round
 * resuming from its clarify? The wake item carries `reason:'wrap-up'`, but a clarify-answer
 * rerun is adopted (no wake item), so the flag must be re-derived or the continuation
 * silently loses the FINAL directive AND the dispatch-ban — letting the leader answer with
 * `continue + wg_assignments` and dispatch work past the cap that no later round can
 * aggregate. The cap only ever grants ONE grace leader round, so a leader continuation
 * while roundsUsed is already at/past maxRounds (with completed work) IS that round.
 */
export function isLeaderWrapUpContinuation(state: EngineDbState): boolean {
  return (
    state.config.mode === 'leader_worker' &&
    countRoundsUsed(state) >= state.config.maxRounds &&
    hasSalvageableWork(state.assignments)
  )
}

/**
 * RFC-189 — stamp an ADOPTED host row's round in place (rows minted outside the
 * engine — clarify-answer reruns / crash leftovers — carry no ordinal). Plain
 * column update: wg_round is accounting metadata, not a lifecycle column (no
 * CAS surface); `WHERE wg_round IS NULL` keeps re-drives idempotent.
 */
async function stampWgRound(db: DbClient, nodeRunId: string, wgRound: number): Promise<void> {
  await db
    .update(nodeRuns)
    .set({ wgRound })
    .where(and(eq(nodeRuns.id, nodeRunId), isNull(nodeRuns.wgRound)))
}

/**
 * RFC-187 F3 — is the LEADER parked on a clarify? Keyed on an OPEN clarify SESSION whose
 * source is the leader host node (`sourceAgentNodeId === __wg_leader__`). A member clarify
 * has `sourceAgentNodeId === __wg_member__` and parks its assignment `awaiting_human`
 * (caught by the wake's `humanPending`, not here). The SESSION — not the `__wg_clarify__`
 * run — is authoritative (Codex P0-1): the run is minted before the session in a
 * non-atomic sequence, so a crash between them leaves an unanswerable orphan run that a
 * run-only signal would park forever; an open session proves the park is answerable and
 * self-heals a crash-orphan (no session ⇒ the leader is re-driven and re-asks). Without
 * this the engine re-drives a clarify-parked leader every round → orphans N sessions and
 * hits max_rounds (probe B).
 */
export function deriveLeaderClarifyPark(
  clarifySessions: ReadonlyArray<{ sourceAgentNodeId: string; status: string }>,
): boolean {
  return clarifySessions.some(
    (s) => s.status === 'awaiting_human' && s.sourceAgentNodeId === WG_LEADER_NODE_ID,
  )
}

/**
 * RFC-187 §4 — a workgroup that reached `done` with ZERO canonical delta yet had
 * completed assignments is suspect: the outputs were produced but never merged into
 * canonical (probe A: fan-out writers wrote outside their iso → merge-back merged
 * nothing). `doneAssignmentCount` gates on completed work existing at all (RFC-130
 * removed the agent `readonly` field — per-node iso replaced write serialization — so
 * a "producer vs reader" distinction no longer exists; the rare pure-coordination group
 * that finishes with no files just gets a soft, non-blocking advisory).
 */
export function detectZeroDeltaDone(filesChanged: number, doneAssignmentCount: number): boolean {
  return filesChanged === 0 && doneAssignmentCount > 0
}

/**
 * RFC-187 §4 — on `done`, warn (don't block) if completed work left the canonical
 * worktree unchanged: the outputs were produced but never merged. Best-effort — any git
 * failure is swallowed so it can never wedge the done finalization.
 */
async function warnIfZeroDeltaDone(args: WorkgroupEngineArgs, state: EngineDbState): Promise<void> {
  const getFiles = args.hooks.getCanonicalFilesChanged
  if (getFiles === undefined) return
  const doneAssignmentCount = state.assignments.filter((a) => a.status === 'done').length
  if (doneAssignmentCount === 0) return
  let filesChanged: number
  try {
    filesChanged = await getFiles()
  } catch {
    return
  }
  if (!detectZeroDeltaDone(filesChanged, doneAssignmentCount)) return
  await postMessage(args.db, args.taskId, roundMode(state.config), {
    authorKind: 'system',
    kind: 'decision',
    bodyMd:
      `⚠️ ${doneAssignmentCount} assignment(s) completed but the canonical worktree has no changes — ` +
      'outputs may not have merged. Check that each worker wrote inside its own working copy ' +
      '(relative paths), not an absolute path outside it.',
  })
  args.log.warn('workgroup done with zero canonical delta despite completed work', {
    taskId: args.taskId,
    doneAssignmentCount,
  })
}

function currentRound(state: EngineDbState): number {
  return countRoundsUsed(state)
}

// ---------------------------------------------------------------------------
// prompt composition
// ---------------------------------------------------------------------------

function composeLeaderPrompt(state: EngineDbState, envelopeNonce = ''): string {
  const { config } = state
  const ledger = state.assignments.map((a) => {
    const resultMsg =
      a.resultMessageId !== null ? state.messages.find((m) => m.id === a.resultMessageId) : null
    return { assignment: a, resultSummary: resultMsg?.bodyMd ?? null }
  })
  const cursor = state.cursors.get(config.leaderMemberId ?? '') ?? ''
  const fresh = state.messages.filter((m) => m.id > cursor)
  const blocks = [
    renderCharterBlock(config, envelopeNonce),
    // RFC-176: the leader owns goal decomposition — carry it every turn.
    renderGoalBlock(config, envelopeNonce),
    renderRosterBlock(
      config,
      {
        excludeMemberId: config.leaderMemberId ?? undefined,
        agentCards: state.agentCards,
      },
      envelopeNonce,
    ),
    renderLeaderLedger(config, ledger, envelopeNonce),
    renderMessagesBlock(config, 'New activity since your last turn', fresh, envelopeNonce),
  ]
  if (state.gate.rejected) {
    const rejection = state.gate.rejectedComment
      ? `A human rejected your completion declaration:\n${fenceUntrusted(
          'completion-gate-feedback',
          state.gate.rejectedComment,
          envelopeNonce,
        )}`
      : 'A human rejected your completion declaration.'
    blocks.push(
      [
        '## Completion gate REJECTED',
        '',
        rejection,
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
  envelopeNonce = '',
): string {
  const { config } = state
  const slices = selectMemberSlices(config, memberId, {
    assignments: state.assignments,
    messages: state.messages,
    cursorMessageId: state.cursors.get(memberId) ?? '',
  })
  const blocks = [renderCharterBlock(config, envelopeNonce)]
  // RFC-176: free_collab has no leader to decompose the goal — every member
  // owns it, so all members see it. A leader_worker worker never does: it acts
  // on the leader's assignment brief ('## Your assignment') below.
  if (config.mode === 'free_collab') blocks.push(renderGoalBlock(config, envelopeNonce))
  blocks.push(
    renderRosterBlock(
      config,
      { excludeMemberId: memberId, agentCards: state.agentCards },
      envelopeNonce,
    ),
  )
  if (assignment !== null) {
    const title =
      envelopeNonce.length > 0 ? sanitizeInlineField(assignment.title) : assignment.title
    blocks.push(
      [
        '## Your assignment',
        '',
        `Title: ${title}`,
        '',
        fenceUntrusted('assignment-brief', assignment.briefMd, envelopeNonce),
      ].join('\n'),
    )
  } else {
    blocks.push(
      [
        '## Message turn',
        '',
        'You were woken because teammates (or a human) messaged you — respond or',
        'record what matters. Do NOT claim or start task work in this turn.',
      ].join('\n'),
    )
  }
  if (slices.peerResults.length > 0) {
    blocks.push(renderMessagesBlock(config, 'Teammate results', slices.peerResults, envelopeNonce))
  }
  if (slices.mentions.length > 0) {
    blocks.push(
      renderMessagesBlock(config, 'Messages addressed to you', slices.mentions, envelopeNonce),
    )
  }
  if (slices.blackboard.length > 0) {
    blocks.push(
      renderMessagesBlock(config, 'Group blackboard (recent)', slices.blackboard, envelopeNonce),
    )
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
      await postMessage(db, taskId, roundMode(seed.config), {
        // RFC-209 — 前奏：开场目标先于任何回合，显式 0（countRoundsUsed(seed)===0 已由上面的守卫保证同值）。
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
    if (rec !== null) {
      await reconcileRunningAssignments(db, taskId, rec, log)
      // RFC-187 T13 (Codex P1-7①) — and revive any answered-clarify continuation the
      // restart killed while it was still pending; the loop's next loadDbState picks the
      // fresh pending row up through the normal adoption.
      await reviveKilledClarifyContinuations(db, taskId, rec, log)
      // RFC-187 T13 (Codex P1-7②) — an autonomous group must never sit on an open clarify,
      // but RFC-181 A2's dismissal runs OUTSIDE the config-PATCH transaction: a crash
      // between "autonomous=true committed" and "dismiss" leaves exactly that combination,
      // and (with F3) the engine would then park the task awaiting_human for an answer
      // autonomous mode promises never to ask for. Re-assert the invariant at entry instead
      // of assuming it impossible. No-op in the overwhelming common case (no open session).
      if (
        !workgroupHasHumanMember(rec.config.members) &&
        rec.config.mode !== 'dynamic_workflow' &&
        rec.clarifySessions.some((s) => s.status === 'awaiting_human')
      ) {
        const dismissed = await dismissOpenClarifyParksForAutonomous(db, taskId, rec.config.mode)
        if (dismissed.dismissedSessions > 0) {
          log.info('workgroup dismissed open clarify parks on autonomous re-entry', {
            taskId,
            dismissed: dismissed.dismissedSessions,
          })
        }
      }
    }
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

    // RFC-187 F3 — a leader-host run parked on a clarify resumes via an adopted
    // clarify-answer rerun, never a fresh wake. Derived from the `__wg_clarify__`
    // rows (the old check on `hostRuns` for `__wg_leader__`+awaiting_human was dead:
    // leader runs go `done` and clarify parks land on `__wg_clarify__`, which
    // `hostRuns` didn't even load). Kept OUT of `leaderRunning` so the outcome is a
    // proper `leader-clarify` park, not a generic `running`.
    const leaderClarifyParked = deriveLeaderClarifyPark(state.clarifySessions)
    const wakeInput: WakeInput = {
      config: state.config,
      assignments: state.assignments,
      messages: state.messages,
      cursors: state.cursors,
      inFlight: {
        leaderRunning: inflightMeta.leaderRunning,
        runningAssignmentIds: inflightMeta.runningAssignmentIds,
        messageTurnMemberIds: inflightMeta.messageTurnMemberIds,
      },
      leaderClarifyParked,
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
            await postMessage(db, taskId, roundMode(state.config), {
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
            resolveCompletionGate(state.config.members, state.config.completionGate) &&
            !state.gate.approved &&
            !state.gate.awaitingConfirmation
          ) {
            await openCompletionGate(args, state)
            return {
              kind: 'awaiting_review',
              detail: { summary: 'workgroup completion gate', message: 'wg-gate' },
            }
          }
          // RFC-187 §4 — the task is truly completing (done, no gate): flag a
          // zero-canonical-delta done so a silent empty deliverable isn't mistaken
          // for success.
          await warnIfZeroDeltaDone(args, state)
          return { kind: 'ok' }
        }
        case 'awaiting_gate': {
          if (state.gate.approved) {
            await warnIfZeroDeltaDone(args, state)
            return { kind: 'ok' } // PR-5 confirm approved
          }
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
          await postMessage(db, taskId, roundMode(state.config), {
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
              // RFC-187 F8 — distinct summary per reason so telemetry/room don't
              // mislabel a leader blocked on a clarify as an idle leader.
              summary:
                outcome.reason === 'leader-idle'
                  ? 'workgroup idle — waiting for human input'
                  : outcome.reason === 'leader-clarify'
                    ? 'workgroup leader is waiting on a human answer to its clarify'
                    : outcome.reason === 'max-rounds-wrapup'
                      ? 'workgroup hit max_rounds with completed work — review the deliverable'
                      : 'workgroup waiting on clarify answers / human delivery',
              message: outcome.reason,
            },
          }
        case 'failed': {
          const summary =
            outcome.reason === 'max-rounds'
              ? `workgroup hit max_rounds (${state.config.maxRounds})`
              : 'free_collab deadlock: open tasks but no claimable agent member'
          await postMessage(db, taskId, roundMode(state.config), {
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
  // RFC-209 §2.4 — 读一次账本，holder 的 wgRound 与下面那条门消息的 round 共用。
  // 此前两者相隔 9 行、中间夹着两个 await 却各读各的，注释又断言它们同轮——正是本 RFC
  // 要消灭的那类漂移（对抗门 P2）。
  const gateRound = currentRound(state)
  // The gate holder run satisfies the lifecycle invariant "task
  // awaiting_review ⟹ ∃ awaiting_review node_run" (design §8.2, 设计门
  // Finding-2). Minted directly in awaiting_review — a non-frontier host row.
  const gateRunId = await mintNodeRun(db, {
    taskId,
    nodeId: WG_LEADER_NODE_ID,
    status: 'pending',
    cause: 'wg-gate',
    // RFC-189 — the gate holder belongs to the CURRENT round (display only;
    // wg-gate rows never advance the round budget, ≤ max by construction).
    overrides: { wgRound: gateRound },
  })
  await setNodeRunStatus({
    db,
    nodeRunId: gateRunId,
    to: 'awaiting_review',
    allowedFrom: ['pending'],
    reason: 'wg-gate-open',
  })
  await postMessage(db, taskId, roundMode(state.config), {
    round: gateRound,
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
        await driveLeaderTurn(args, state, undefined, item.reason === 'wrap-up')
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
    await postMessage(db, taskId, roundMode(state.config), {
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
    // RFC-187 §3-7 (Codex impl-gate P1) — a wrap-up round that asked a human resumes
    // HERE (clarify-answer rerun), and the wake item's `reason:'wrap-up'` is gone. Without
    // re-deriving it the continuation loses the FINAL directive AND the dispatch-ban, so a
    // leader answering with `continue + wg_assignments` dispatches work past the cap that
    // no later round can aggregate. A leader continuation at/past the cap IS a wrap-up by
    // construction (the cap only ever grants the one grace round), so re-derive from state.
    await driveLeaderTurn(args, state, row.id, isLeaderWrapUpContinuation(state))
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
  let drivenStatus = assignment.status
  if (assignment.status === 'awaiting_human') {
    await casAssignmentStatus(db, assignment.id, 'awaiting_human', 'running', {
      nodeRunId: row.id,
    })
    drivenStatus = 'running'
  }
  // RFC-186 Phase 3 (audit §3-5 / F5): pass the assignment's TRUE status rather
  // than force 'running'. A crash between mintNodeRun and the dispatched→running
  // CAS leaves the row `dispatched`; forcing 'running' here made driveAssignmentTurn
  // skip its own dispatched→running CAS, so the DB stayed `dispatched`, the closing
  // running→done CAS matched 0 rows, and the assignment re-ran (duplicate). With the
  // real status, driveAssignmentTurn CASes dispatched→running itself.
  await driveAssignmentTurn(args, state, { ...assignment, status: drivenStatus }, row.id)
}

async function driveLeaderTurn(
  args: WorkgroupEngineArgs,
  state: EngineDbState,
  adoptedRunId?: string,
  // RFC-187 §3-7 (Codex P0-3) — the single grace wrap-up round past the round cap:
  // inject a directive to aggregate + declare done, and drop any new dispatch (no
  // rounds remain to run it).
  wrapUp = false,
): Promise<void> {
  const { db, taskId, hooks } = args
  const config = state.config
  const leaderId = config.leaderMemberId
  if (leaderId === null) return
  const leaderAgent = await resolveMemberAgent(args, state, leaderId)
  if (leaderAgent === null) {
    await postMessage(db, taskId, roundMode(state.config), {
      authorKind: 'system',
      kind: 'system',
      bodyMd: `leader agent unresolvable (${memberDisplayName(config, leaderId)}) — failing task`,
    })
    throw new Error('workgroup leader agent unresolvable')
  }

  // RFC-189 — this turn's ROUND ordinal, shared by every attempt row (protocol
  // retries are the same logical round). A fresh turn is round N+1; an ADOPTED
  // row (clarify-answer rerun / crash recovery, minted outside without a stamp)
  // is already inside countRoundsUsed's NULL-qualifying tail, so its round is
  // the CURRENT count — stamped in place before driving.
  const adoptedRow =
    adoptedRunId !== undefined ? state.hostRuns.find((r) => r.id === adoptedRunId) : undefined
  const wgRound =
    adoptedRow !== undefined
      ? (adoptedRow.wgRound ?? countRoundsUsed(state))
      : countRoundsUsed(state) + 1
  if (adoptedRow !== undefined && adoptedRow.wgRound === null) {
    await stampWgRound(db, adoptedRow.id, wgRound)
  }
  // Codex 实现门 P2-1 — retries of an ADOPTED turn continue from the adopted
  // row's stored index (a clarify-answer continuation carries the standard
  // dispatch's lineage max+1; a crash-adopted protocol retry carries its own
  // attempt) so a follow-up retry can never re-mint a duplicate
  // (node, shard, retry_index). Fresh turns start at 0 — plain attempt.
  const retryBase = adoptedRow?.retryIndex ?? 0

  let errorNotice: string | null = null
  for (let attempt = 0; attempt <= WG_PROTOCOL_RETRIES; attempt++) {
    let runId = adoptedRunId
    if (runId === undefined || attempt > 0) {
      runId = await mintNodeRun(db, {
        taskId,
        nodeId: WG_LEADER_NODE_ID,
        status: 'pending',
        // RFC-187 §3-3 — a protocol retry (attempt>0) is the SAME logical round;
        // tag it so round accounting excludes it and it doesn't inflate max_rounds.
        // RFC-189 — retryIndex is the plain ATTEMPT ordinal now (the round lives
        // in wg_round); the old "prior-row count + attempt" overload is gone.
        cause: attempt > 0 ? 'wg-protocol-retry' : 'wg-leader-round',
        retryIndex: retryBase + attempt,
        overrides: { wgRound },
      })
      args.registerMint?.(runId)
      broadcastPendingMint(taskId, runId, WG_LEADER_NODE_ID)
    }
    adoptedRunId = undefined
    const envelopeNonce = await loadRunEnvelopeNonce(db, runId)

    const prompt =
      composeLeaderPrompt(state, envelopeNonce) +
      (wrapUp
        ? '\n\n## FINAL round — the round cap has been reached\n\nThis is your LAST turn. Do NOT dispatch new work (there are no rounds left to run it). ' +
          'Aggregate the completed results and emit `wg_decision` with action `done`. Any `wg_assignments` you emit now will be ignored.'
        : '') +
      (errorNotice !== null
        ? `\n\n## Protocol errors in your previous reply\n\n${fenceUntrusted(
            'protocol-error',
            errorNotice,
            envelopeNonce,
          )}\n\nRe-emit a CORRECT envelope.`
        : '')

    // RFC-207 §3.7.2 — resolve ONCE and feed BOTH the protocol block (whether to
    // invite an ask-back) and `clarifyEnabled` (whether to accept one). Deriving
    // it separately in each place is how a prompt ends up inviting a question the
    // envelope gate then rejects.
    const leaderClarifyAllowed = await resolveWgClarifyAllowed(
      db,
      taskId,
      config.members,
      config.clarifyBudget,
      WG_LEADER_NODE_ID,
      null,
    )
    const result = await hooks.runHostNode({
      nodeRunId: runId,
      nodeId: WG_LEADER_NODE_ID,
      agent: leaderAgent,
      promptTemplate: prompt,
      workgroupProtocolBlock: renderWgProtocolBlock(
        'leader',
        config,
        envelopeNonce,
        leaderClarifyAllowed,
      ),
      hostOutputPorts: wgHostRolePorts('leader'),
      clarifyEnabled: leaderClarifyAllowed,
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
      // Routed on the structured failureCode (RFC-145 ratchet) — both producer
      // paths (runNode envelope-time reject AND the hook's late-suppress
      // correction) carry it; errorMessage stays human-only.
      if (result.failureCode === 'clarify-forbidden') {
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
    let dispatches =
      assignmentsRaw !== undefined
        ? parseWgAssignmentsPort(assignmentsRaw, roster, {
            // RFC-185 D4 (Codex T6 P1) — OFF is enforced here, not just in the
            // prompt: same-member duplicates reject the port whole and re-
            // prompt via the malformed-retry channel.
            allowSameMemberFanOut: config.fanOut === true,
          })
        : { ok: true as const, value: [] }
    if (!dispatches.ok) errors.push(...dispatches.errors.map((e) => `wg_assignments: ${e}`))
    // RFC-187 §3-7 (Codex P0-3): the grace wrap-up round cannot dispatch new work —
    // there are no rounds left to aggregate it. DROP any new assignments (don't error,
    // so the leader's wg_decision — ideally `done` — still lands and the deliverable-
    // in-hand task finishes) and note it in the room.
    let wrapUpDroppedDispatch = false
    if (wrapUp && dispatches.ok && dispatches.value.length > 0) {
      wrapUpDroppedDispatch = true
      dispatches = { ok: true as const, value: [] }
    }
    const outMessages =
      messagesRaw !== undefined
        ? parseWgMessagesPort(messagesRaw, roster)
        : { ok: true as const, value: [] }
    if (!outMessages.ok) errors.push(...outMessages.errors.map((e) => `wg_messages: ${e}`))
    // RFC-186 Phase 3 (audit §3-6): `done` co-emitted with NEW assignments is
    // contradictory — the freshly dispatched work would run but its results would
    // never be aggregated (the leader is suppressed once declaredDone), and the
    // task reports done with that work silently discarded. Reject as a protocol
    // violation so the leader re-decides: dispatch OR declare done, not both.
    if (
      decision !== null &&
      decision.ok &&
      decision.value.action === 'done' &&
      dispatches.ok &&
      dispatches.value.length > 0
    ) {
      errors.push(
        'wg_decision: action "done" cannot be emitted together with new wg_assignments — dispatch OR declare done, not both',
      )
    }

    if (errors.length > 0) {
      errorNotice = errors.map((e) => `- ${e}`).join('\n')
      if (attempt === WG_PROTOCOL_RETRIES) {
        throw new Error(`leader protocol violation: ${errors.join('; ')}`)
      }
      continue
    }

    // Codex 实现门 P2-2 — the turn's EFFECTS (messages / dispatched assignments,
    // whose round workers inherit) share the SAME authoritative round as the
    // run row's stamp. Fresh turn: wgRound == currentRound+1 (byte-identical to
    // the old expression); ADOPTED turn: wgRound == currentRound (the adopted
    // row already sits in the ledger) — the old +1 split one turn across two
    // round labels (run stamped N, effects N+1).
    const round = wgRound
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
        await postMessage(db, taskId, roundMode(config), {
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
    // RFC-187 §3-7 — surface the dropped wrap-up dispatch (see the drop above).
    if (wrapUpDroppedDispatch) {
      await postMessage(db, taskId, roundMode(config), {
        round,
        authorKind: 'system',
        kind: 'system',
        bodyMd:
          'Round cap reached — new assignments in this final wrap-up round were ignored. ' +
          'Aggregating the completed work.',
      })
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
        await postMessage(db, taskId, roundMode(config), {
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
    // RFC-186 T5 (audit §5 F6): advance the leader cursor to the turn-start max
    // ONLY here, AFTER this turn's effects (messages / assignments / deliveries /
    // decision / gate) are durably persisted. If a daemon restart kills the turn
    // mid-flight (before this point), the cursor stays put so the resumed engine
    // re-derives the turn instead of silently skipping it (was: advanced BEFORE
    // runHostNode). `maxMessageId(state.messages)` is the turn-start snapshot, so
    // the value is identical to the old pre-turn advance — only the timing moved.
    await advanceMemberCursor(db, taskId, leaderId, maxMessageId(state.messages))
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
    await postAssignmentMessage(db, taskId, roundMode(config), assignment, {
      authorKind: 'system',
      kind: 'system',
      bodyMd: `assignment '${assignment.title}' failed: agent for @${memberDisplayName(config, memberId)} unresolvable`,
    })
    return
  }

  // RFC-189 — a member run belongs to the round that DISPATCHED its assignment
  // (lw display grouping; never budget). fc rows stay NULL — the fc round
  // budget is a row COUNT by design (design.md §1 修订), not an ordinal.
  const memberWgRound = config.mode === 'leader_worker' ? assignment.round : null
  const adoptedMemberRow =
    adoptedRunId !== undefined ? state.hostRuns.find((r) => r.id === adoptedRunId) : undefined
  if (
    adoptedMemberRow !== undefined &&
    adoptedMemberRow.wgRound === null &&
    memberWgRound !== null
  ) {
    await stampWgRound(db, adoptedMemberRow.id, memberWgRound)
  }
  // Codex 实现门 P2-1（member 侧同形）— adopted 续跑的重试从其存量 index 续排，
  // 防 (node, shard, retry_index) 重复铸行。
  const retryBase = adoptedMemberRow?.retryIndex ?? 0

  let errorNotice: string | null = null
  for (let attempt = 0; attempt <= WG_PROTOCOL_RETRIES; attempt++) {
    let runId = adoptedRunId
    if (runId === undefined || attempt > 0) {
      runId = await mintNodeRun(db, {
        taskId,
        nodeId: WG_MEMBER_NODE_ID,
        status: 'pending',
        // RFC-187 §3-3 — protocol retry (attempt>0) = same logical round; excluded
        // from round accounting (matters for fc, which counts member runs as rounds).
        // RFC-189 — retryIndex = plain attempt ordinal (round lives in wg_round).
        cause: attempt > 0 ? 'wg-protocol-retry' : 'wg-assignment',
        retryIndex: retryBase + attempt,
        overrides: {
          shardKey: assignment.id,
          agentOverrideName: agent.name,
          wgRound: memberWgRound,
        },
      })
      args.registerMint?.(runId)
      broadcastPendingMint(taskId, runId, WG_MEMBER_NODE_ID)
    }
    adoptedRunId = undefined
    const envelopeNonce = await loadRunEnvelopeNonce(db, runId)

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
      composeMemberPrompt(state, memberId, assignment, envelopeNonce) +
      (errorNotice !== null
        ? `\n\n## Protocol errors in your previous reply\n\n${fenceUntrusted(
            'protocol-error',
            errorNotice,
            envelopeNonce,
          )}\n\nRe-emit a CORRECT envelope.`
        : '')

    // RFC-207 §3.7.2 — resolve ONCE and feed BOTH the protocol block (whether to
    // invite an ask-back) and `clarifyEnabled` (whether to accept one). Deriving
    // it separately in each place is how a prompt ends up inviting a question the
    // envelope gate then rejects.
    const assignmentClarifyAllowed = await resolveWgClarifyAllowed(
      db,
      taskId,
      config.members,
      config.clarifyBudget,
      WG_MEMBER_NODE_ID,
      assignment.id,
    )
    const result = await hooks.runHostNode({
      nodeRunId: runId,
      nodeId: WG_MEMBER_NODE_ID,
      agent,
      promptTemplate: prompt,
      workgroupProtocolBlock: renderWgProtocolBlock(
        config.mode === 'free_collab' ? 'fc_member' : 'worker',
        config,
        envelopeNonce,
        assignmentClarifyAllowed,
      ),
      hostOutputPorts: wgHostRolePorts(config.mode === 'free_collab' ? 'fc_member' : 'worker'),
      clarifyEnabled: assignmentClarifyAllowed,
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
      // the card — never a park). Structured failureCode routing (RFC-145).
      if (result.failureCode === 'clarify-forbidden' && attempt < WG_PROTOCOL_RETRIES) {
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
      await postAssignmentMessage(db, taskId, roundMode(config), assignment, {
        authorKind: 'system',
        kind: 'system',
        bodyMd: `assignment '${assignment.title}' failed: ${result.errorMessage ?? 'run failed'}`,
      })
      if (config.mode === 'free_collab') {
        // bounded re-open (retry budget) — count LIVE, not the turn-start
        // snapshot, or every failure sees a stale low count and reopens
        // past the cap. Budget = shared DEFAULT_PROTOCOL_RETRY_BUDGET, read
        // here as TOTAL runs for the assignment (not retries-after-first).
        const priorRuns = (
          await db
            .select({ id: nodeRuns.id })
            .from(nodeRuns)
            .where(and(eq(nodeRuns.taskId, taskId), eq(nodeRuns.shardKey, assignment.id)))
        ).length
        if (priorRuns < DEFAULT_PROTOCOL_RETRY_BUDGET) {
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
        await postAssignmentMessage(db, taskId, roundMode(config), assignment, {
          authorKind: 'system',
          kind: 'system',
          bodyMd: `assignment '${assignment.title}' failed: protocol violation (${errors.join('; ')})`,
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
    const resultMessageId = await postAssignmentMessage(db, taskId, roundMode(config), assignment, {
      authorKind: 'member',
      authorMemberId: memberId,
      kind: 'result',
      bodyMd: parsedResult !== null && parsedResult.ok ? parsedResult.value.summary : '',
    })
    await casAssignmentStatus(db, assignment.id, 'running', 'done', { resultMessageId })
    // RFC-186 T5 (audit §5 F6): advance the worker cursor AFTER the assignment's
    // effects (result message / done / tasks_add) persist — a mid-turn crash
    // leaves it un-advanced so the resumed engine doesn't skip consumed content.
    await advanceMemberCursor(db, taskId, memberId, maxMessageId(state.messages))
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
      // RFC-189 — single-shot turn (no attempt loop) ⇒ plain attempt 0; the
      // lw round it belongs to rides wg_round (fc: NULL — count-based budget,
      // where each message turn IS one budget row and needs no ordinal).
      retryIndex: 0,
      overrides: {
        shardKey: `msg:${memberId}:${maxMessageId(state.messages) || '0'}`,
        agentOverrideName: agent.name,
        wgRound: config.mode === 'leader_worker' ? currentRound(state) : null,
      },
    })
    args.registerMint?.(runId)
    broadcastPendingMint(taskId, runId, WG_MEMBER_NODE_ID)
  } else if (config.mode === 'leader_worker') {
    // Codex 实现门 P2-4 — an ADOPTED msg continuation (clarify-answer rerun on
    // a msg:* shard, minted outside without a stamp) gets its round in place;
    // display-only in lw (message turns never advance the ledger), idempotent
    // via the IS NULL guard.
    await stampWgRound(db, runId, currentRound(state))
  }
  const envelopeNonce = await loadRunEnvelopeNonce(db, runId)

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
    composeMemberPrompt(state, memberId, null, envelopeNonce) +
    (fcAddendum !== null ? `\n\n${fcAddendum}` : '')

  const role = config.mode === 'free_collab' ? ('fc_member' as const) : ('worker' as const)
  // RFC-207 §3.7.2 — resolve ONCE and feed BOTH the protocol block (whether to
  // invite an ask-back) and `clarifyEnabled` (whether to accept one). Deriving
  // it separately in each place is how a prompt ends up inviting a question the
  // envelope gate then rejects.
  // The shard key of a message turn embeds the member; only that part is used to
  // identify the asker, so the message id is irrelevant here (RFC-207 §3.6.3).
  const msgClarifyAllowed = await resolveWgClarifyAllowed(
    db,
    taskId,
    config.members,
    config.clarifyBudget,
    WG_MEMBER_NODE_ID,
    `msg:${memberId}:0`,
  )
  const result = await hooks.runHostNode({
    nodeRunId: runId,
    nodeId: WG_MEMBER_NODE_ID,
    agent,
    promptTemplate: prompt,
    workgroupProtocolBlock: renderWgProtocolBlock(role, config, envelopeNonce, msgClarifyAllowed),
    hostOutputPorts: wgHostRolePorts(role),
    clarifyEnabled: msgClarifyAllowed,
  })
  // RFC-186 T5 (audit §5 F6): advance the member cursor AFTER the hook RETURNS
  // (done OR failed — both consume the @-mention so it can't re-loop), but never
  // BEFORE the hook. A mid-turn daemon crash (hook never returns) leaves it
  // un-advanced so the resumed engine re-derives the turn instead of skipping it.
  // (Message turns are cursor-driven, unlike the status-driven leader/assignment
  // turns whose advance sits after their durable effects.)
  await advanceMemberCursor(db, taskId, memberId, maxMessageId(state.messages))
  // RFC-186 §2.2 (audit §2 P1-7) — a failed message turn used to `return`
  // silently: the @-mentioned member appeared to ignore the message, the room
  // showed nothing, and debugging was blind. Surface the failure as a system
  // note so the black hole is visible. (A bounded RETRY loop for message turns
  // — mirroring leader/assignment — is deferred: this path is off the
  // dispatch-to-done critical line; the visibility fix addresses the real harm.)
  if (result.status !== 'done') {
    if (result.status === 'failed') {
      await postMessage(db, taskId, roundMode(config), {
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
  // RFC-209 —— 解析一次，本轮产出的所有消息共用（此前读的是**过期快照**：这个 turn 可能是
  // 好几个引擎 pass 之前启动的，它的 `state` 早就不是当前值了，fc 首轮因此永远写 round 0）。
  const turnRound = await resolveMessageRound(db, taskId, roundMode(config))
  if (outMessages.ok && outMessages.value.length > 0) {
    await persistWgMessages(db, taskId, config, turnRound, memberId, outMessages.value, {
      allowDirect: switches.directMessages,
      allowBlackboard: switches.blackboard,
    })
  }
  const resultRaw = result.outputs[WG_PORT_RESULT]
  if (resultRaw !== undefined) {
    const parsed = parseWgResultPort(resultRaw)
    if (parsed.ok) {
      await postMessage(db, taskId, roundMode(config), {
        round: turnRound,
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
const tasksAddQueue = new KeyedSerialQueue<string>()
function serializeTasksAdd<T>(taskId: string, fn: () => Promise<T>): Promise<T> {
  return tasksAddQueue.run(taskId, fn)
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
    await postMessage(db, taskId, roundMode(state.config), {
      authorKind: 'system',
      kind: 'system',
      bodyMd: `wg_tasks_add from @${memberDisplayName(state.config, authorMemberId)} rejected: ${parsed.errors.join('; ')}`,
    })
    return 0
  }
  // RFC-209 — 解析一次，本次消费产出的所有卡与消息共用（同一批产出必须同回合号）。
  const cardRound = await resolveMessageRound(db, taskId, roundMode(state.config))
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
      // RFC-209 — 卡的回合号取写入时刻的解析值（`consumeTasksAdd` 只在 fc 下进来，
      // 故恒 0：自由协作没有回合语义，此前这里写的是**过期快照**里的成员 run 累计数）。
      round: cardRound,
      source: 'self_claim',
      assigneeMemberId: null,
      title: item.title,
      briefMd: item.brief,
      status: 'open',
      dedupKey: key,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
    await postMessage(db, taskId, roundMode(state.config), {
      authorKind: 'member',
      authorMemberId,
      kind: 'dispatch',
      bodyMd: `+ task: ${item.title}`,
      assignmentId: id,
    })
    added++
  }
  if (dropped > 0) {
    await postMessage(db, taskId, roundMode(state.config), {
      authorKind: 'system',
      kind: 'system',
      bodyMd: `${dropped} duplicate task(s) from @${memberDisplayName(state.config, authorMemberId)} dropped (title dedup)`,
    })
  }
  return added
}

/**
 * RFC-209 §2.3-1 —— `round` 在这里**必填**（它是中间位参，`round?: number` 后跟必填参数
 * 是 TS1016）。同一轮产出的 N 条消息必须共享同一个回合号，所以由调用方解析一次传进来，
 * 而不是逐条走 `postMessage` 的省略路径（那会变成每条一次 SELECT，且可能拿到不同的值）。
 */
async function persistWgMessages(
  db: DbClient,
  taskId: string,
  config: WorkgroupRuntimeConfig,
  round: number,
  authorMemberId: string,
  items: readonly WgMessageItem[],
  allow: { allowDirect: boolean; allowBlackboard: boolean },
): Promise<void> {
  const mode = roundMode(config)
  let dropped = 0
  for (const item of items) {
    if (item.to === null) {
      if (!allow.allowBlackboard && !allow.allowDirect) {
        dropped++
        continue
      }
      await postMessage(db, taskId, mode, {
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
    await postMessage(db, taskId, mode, {
      round,
      authorKind: 'member',
      authorMemberId,
      kind: 'chat',
      bodyMd: `@${item.to} ${item.body}`,
      mentionMemberIds: [target.id],
    })
  }
  if (dropped > 0) {
    await postMessage(db, taskId, mode, {
      round,
      authorKind: 'system',
      kind: 'system',
      bodyMd: `${dropped} message(s) from @${memberDisplayName(config, authorMemberId)} dropped (visibility switches)`,
    })
  }
}

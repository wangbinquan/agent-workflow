// RFC-217 T2 — the SINGLE codec + CAS for `workgroup_task_state` (design §2).
//
// Everything that used to hide in tasks.workgroup_config_json's untyped
// `$.gate` / `$.dw` / `$.wgPause` slots lives here now. Three write styles
// (engine tx-merge / route full-blob overwrite / json_set) collapsed into:
//   - gate:  casGateStatus — transition-table CAS, the workgroupLifecycle.ts
//            pattern (blind writes are a bug, not a style choice)
//   - pause: setPauseReason — single writer (the engine)
//   - dw:    setDwState — complete DwState checkpoint, zod-validated; the
//            confirm/reject phase flip MUST ride the resume ownership CAS via
//            resumeDynamicWorkflowExecution's onClaim transaction (design-gate
//            P1: a standalone phase write strands awaiting-review tasks)
//
// G3 grep-locks (rfc217-architecture-locks.test.ts) keep gate-field literals
// and retired-slot accesses out of every other module.

import {
  DwStateSchema,
  perCardInputDescriptionBudget,
  renderAgentCapabilityCard,
  WorkgroupRuntimeConfigSchema,
  type Agent,
  type DwState,
  type WorkgroupAssignment,
  type WorkgroupMessage,
  type WorkgroupRuntimeConfig,
} from '@agent-workflow/shared'
import { and, asc, eq, inArray } from 'drizzle-orm'
import type { DbClient } from '@/db/client'
import { dbTxSync, type DbTxSync } from '@/db/txSync'
import {
  clarifyRounds,
  nodeRuns,
  workgroupAssignments,
  workgroupMemberCursors,
  workgroupMessages,
  workgroupTaskState,
  tasks,
} from '@/db/schema'
import { getAgentById } from '@/services/agent'
import { WG_LEADER_NODE_ID, WG_MEMBER_NODE_ID } from '@/services/workgroup/constants'

export type WorkgroupGateStatus =
  | 'idle'
  | 'declared'
  | 'awaiting_confirmation'
  | 'approved'
  | 'rejected'

export interface WorkgroupTaskState {
  gateStatus: WorkgroupGateStatus
  gateSummary: string | null
  gateRejectedComment: string | null
  pauseReason: string | null
  dwState: DwState | null
}

/**
 * Wire-frozen legacy gate shape — the room aggregate and the engine's wake
 * input still speak booleans; they are DERIVED, never stored.
 */
export interface WorkgroupGateView {
  declaredDone: boolean
  awaitingConfirmation: boolean
  approved: boolean
  rejected: boolean
  rejectedComment?: string
  summary?: string
}

/**
 * Gate state machine (design §2.2). `declared` captures the historical
 * two-write window between the leader's declare and the holder run opening;
 * `rejected → idle` is the consumption edge (leader keeps working instead of
 * re-declaring — runner.ts's old `rejected: false` write).
 */
export const WORKGROUP_GATE_TRANSITIONS: Record<
  WorkgroupGateStatus,
  readonly WorkgroupGateStatus[]
> = {
  idle: ['declared'],
  declared: ['awaiting_confirmation'],
  awaiting_confirmation: ['approved', 'rejected'],
  rejected: ['declared', 'idle'],
  approved: [],
}

export class WorkgroupGateTransitionError extends Error {
  constructor(from: WorkgroupGateStatus, to: WorkgroupGateStatus) {
    super(`illegal workgroup gate transition ${from} → ${to}`)
    this.name = 'WorkgroupGateTransitionError'
  }
}

export function assertGateTransition(
  from: readonly WorkgroupGateStatus[],
  to: WorkgroupGateStatus,
): void {
  for (const f of from) {
    if (!WORKGROUP_GATE_TRANSITIONS[f].includes(to)) throw new WorkgroupGateTransitionError(f, to)
  }
}

export function gateViewOf(state: WorkgroupTaskState): WorkgroupGateView {
  const s = state.gateStatus
  return {
    declaredDone: s === 'declared' || s === 'awaiting_confirmation' || s === 'approved',
    awaitingConfirmation: s === 'awaiting_confirmation',
    approved: s === 'approved',
    rejected: s === 'rejected',
    ...(state.gateRejectedComment !== null ? { rejectedComment: state.gateRejectedComment } : {}),
    ...(state.gateSummary !== null ? { summary: state.gateSummary } : {}),
  }
}

const DEFAULT_STATE: WorkgroupTaskState = {
  gateStatus: 'idle',
  gateSummary: null,
  gateRejectedComment: null,
  pauseReason: null,
  dwState: null,
}

function rowToState(row: typeof workgroupTaskState.$inferSelect | undefined): WorkgroupTaskState {
  if (row === undefined) return { ...DEFAULT_STATE }
  let dw: DwState | null = null
  if (row.dwStateJson !== null) {
    try {
      const parsed = DwStateSchema.safeParse(JSON.parse(row.dwStateJson))
      dw = parsed.success ? parsed.data : null
    } catch {
      dw = null
    }
  }
  return {
    gateStatus: row.gateStatus,
    gateSummary: row.gateSummary,
    gateRejectedComment: row.gateRejectedComment,
    pauseReason: row.pauseReason,
    dwState: dw,
  }
}

export async function loadWorkgroupTaskState(
  db: DbClient,
  taskId: string,
): Promise<WorkgroupTaskState> {
  const row = (
    await db.select().from(workgroupTaskState).where(eq(workgroupTaskState.taskId, taskId)).limit(1)
  )[0]
  return rowToState(row)
}

export function loadWorkgroupTaskStateTx(tx: DbTxSync, taskId: string): WorkgroupTaskState {
  const row = tx
    .select()
    .from(workgroupTaskState)
    .where(eq(workgroupTaskState.taskId, taskId))
    .get()
  return rowToState(row ?? undefined)
}

/**
 * Engine-entry hardening: INSERT OR IGNORE a default row. Production tasks
 * always get their row from startTaskImpl (same tx as the task INSERT) or
 * migration 0106's backfill — this is a no-op there; it exists so a resumed
 * engine can never CAS against a missing row (and so DB-level tests that
 * bypass startTask keep exercising the real gate machine).
 */
export async function ensureWorkgroupTaskStateRow(db: DbClient, taskId: string): Promise<void> {
  await db
    .insert(workgroupTaskState)
    .values({ taskId, gateStatus: 'idle', updatedAt: Date.now() })
    .onConflictDoNothing()
}

/** startTask companion — same transaction as the tasks INSERT. */
export function insertWorkgroupTaskStateTx(tx: DbTxSync, taskId: string, dw: DwState | null): void {
  tx.insert(workgroupTaskState)
    .values({
      taskId,
      gateStatus: 'idle',
      dwStateJson: dw === null ? null : JSON.stringify(DwStateSchema.parse(dw)),
      updatedAt: Date.now(),
    })
    .run()
}

export interface GateCasArgs {
  from: readonly WorkgroupGateStatus[]
  to: WorkgroupGateStatus
  /** to='declared': stored as gate_summary (previous summary/comment cleared). */
  summary?: string
  /** to='rejected': stored as gate_rejected_comment. */
  rejectedComment?: string
}

function gatePatch(args: GateCasArgs): Partial<typeof workgroupTaskState.$inferInsert> {
  switch (args.to) {
    case 'declared':
      return { gateSummary: args.summary ?? null, gateRejectedComment: null }
    case 'rejected':
      return { gateRejectedComment: args.rejectedComment ?? '' }
    case 'idle':
      // consumption edge — the rejection was surfaced to the leader already
      return { gateSummary: null, gateRejectedComment: null }
    case 'awaiting_confirmation':
    case 'approved':
      return {}
  }
}

export function casGateStatusTx(tx: DbTxSync, taskId: string, args: GateCasArgs): boolean {
  assertGateTransition(args.from, args.to)
  const updated = tx
    .update(workgroupTaskState)
    .set({ gateStatus: args.to, updatedAt: Date.now(), ...gatePatch(args) })
    .where(
      and(
        eq(workgroupTaskState.taskId, taskId),
        inArray(workgroupTaskState.gateStatus, [...args.from]),
      ),
    )
    .returning({ taskId: workgroupTaskState.taskId })
    .all()
  return updated.length > 0
}

export async function casGateStatus(
  db: DbClient,
  taskId: string,
  args: GateCasArgs,
): Promise<boolean> {
  return dbTxSync(db, (tx) => casGateStatusTx(tx, taskId, args))
}

export async function setPauseReason(
  db: DbClient,
  taskId: string,
  reason: string | null,
): Promise<void> {
  await db
    .update(workgroupTaskState)
    .set({ pauseReason: reason, updatedAt: Date.now() })
    .where(eq(workgroupTaskState.taskId, taskId))
}

export function setDwStateTx(tx: DbTxSync, taskId: string, dw: DwState): void {
  tx.update(workgroupTaskState)
    .set({ dwStateJson: JSON.stringify(DwStateSchema.parse(dw)), updatedAt: Date.now() })
    .where(eq(workgroupTaskState.taskId, taskId))
    .run()
}

export async function setDwState(db: DbClient, taskId: string, dw: DwState): Promise<void> {
  await db
    .update(workgroupTaskState)
    .set({ dwStateJson: JSON.stringify(DwStateSchema.parse(dw)), updatedAt: Date.now() })
    .where(eq(workgroupTaskState.taskId, taskId))
}

// ---------------------------------------------------------------------------
// RFC-217 T3 — engine durable-state I/O (moved from runner.ts): the pass-start
// snapshot every wake derivation / driver reads.
// ---------------------------------------------------------------------------

export interface EngineDbState {
  config: WorkgroupRuntimeConfig
  gate: WorkgroupGateView
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
 * agentId is the frozen identity. A missing/id-less agent simply yields no card
 * (the roster row still renders with displayName + roleDesc). human members are
 * skipped entirely so no user identity can leak into the prompt.
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
  // De-dupe DB reads: several members may reference the same agent. RFC-223
  // (PR-3a): resolve by the CANONICAL agentId frozen at launch (rename/ABA-safe).
  // The R4-1 quarantine sentinel and name-only legacy rows resolve to no agent →
  // no card (the roster row still renders with displayName + roleDesc).
  const agentCache = new Map<string, Agent | null>()
  for (const m of config.members) {
    if (m.memberType !== 'agent') continue
    if (typeof m.agentId !== 'string' || m.agentId.length === 0) continue
    const key = m.agentId
    let agent = agentCache.get(key)
    if (agent === undefined) {
      agent = await getAgentById(db, key)
      agentCache.set(key, agent)
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

export function rowToAssignment(r: typeof workgroupAssignments.$inferSelect): WorkgroupAssignment {
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

export function rowToMessage(r: typeof workgroupMessages.$inferSelect): WorkgroupMessage {
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

export async function loadDbState(db: DbClient, taskId: string): Promise<EngineDbState | null> {
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
  // RFC-217 T2 — gate/pause live in workgroup_task_state; the engine consumes
  // the derived legacy view (wire-frozen booleans), CAS writes go by status.
  const taskState = await loadWorkgroupTaskState(db, taskId)
  const gate = gateViewOf(taskState)
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
          sourceAgentNodeId: clarifyRounds.askingNodeId,
          status: clarifyRounds.status,
        })
        .from(clarifyRounds)
        .where(and(eq(clarifyRounds.kind, 'self'), eq(clarifyRounds.taskId, taskId))),
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

// RFC-217 T2 — the SINGLE codec + CAS for `workgroup_task_state` (design §2).
//
// Everything that used to hide in tasks.workgroup_config_json's untyped
// `$.gate` / `$.dw` / `$.wgPause` slots lives here now. Three write styles
// (engine tx-merge / route full-blob overwrite / json_set) collapsed into:
//   - gate:  casGateStatus — transition-table CAS, the workgroupLifecycle.ts
//            pattern (blind writes are a bug, not a style choice)
//   - pause: setPauseReason — single writer (the engine)
//   - dw:    setDwState — complete DwState checkpoint, zod-validated; the
//            confirm/reject phase flip MUST ride the resume admission CAS via
//            resumeDynamicWorkflowExecution's onClaim transaction (design-gate
//            P1: a standalone phase write strands awaiting-review tasks)
//
// G3 grep-locks (rfc217-architecture-locks.test.ts) keep gate-field literals
// and retired-slot accesses out of every other module.

import { insertOne } from '@/platform/persistence/singleInsert'
import { tablesOf, type PersistenceTables } from '@/platform/persistence/sessionTables'
import { first } from '@/platform/persistence/queryHelpers'
import type { PersistenceTx, PersistenceDb } from '@/platform/persistence/persistenceDb'
import {
  DwStateSchema,
  perCardInputDescriptionBudget,
  renderAgentCapabilityCard,
  type Agent,
  type DwState,
  type WorkgroupAssignment,
  type WorkgroupMessage,
  type WorkgroupRuntimeConfig,
} from '@agent-workflow/shared'
import { and, eq, inArray } from 'drizzle-orm'
import type { DbClient } from '@/db/client'
import type { DbTxSync } from '@/db/txSync'
import { getAgentById } from '../agent'
import { parseStoredTemplateMetadata } from '@/modules/resource-catalog/application/workgroups/workgroupRoomProjection'

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
  /** RFC-243 §6.4 — room message id anchoring the task's final result. */
  resultMessageId: string | null
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
  resultMessageId: null,
}

function rowToState(
  row: PersistenceTables['workgroupTaskState']['$inferSelect'] | undefined,
): WorkgroupTaskState {
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
    resultMessageId: row.resultMessageId ?? null,
  }
}

export async function loadWorkgroupTaskState(
  db: PersistenceDb,
  taskId: string,
): Promise<WorkgroupTaskState> {
  const { workgroupTaskState } = tablesOf(db)
  const row = (
    await db.select().from(workgroupTaskState).where(eq(workgroupTaskState.taskId, taskId)).limit(1)
  )[0]
  return rowToState(row)
}

export function loadWorkgroupTaskStateTx(tx: DbTxSync, taskId: string): WorkgroupTaskState {
  const { workgroupTaskState } = tablesOf(tx)
  const row = first(
    tx.select().from(workgroupTaskState).where(eq(workgroupTaskState.taskId, taskId)),
  )
  return rowToState(row ?? undefined)
}

/**
 * Engine-entry hardening: INSERT OR IGNORE a default row. Production tasks
 * always get their row from startTaskImpl (same tx as the task INSERT) or
 * migration 0106's backfill — this is a no-op there; it exists so a resumed
 * engine can never CAS against a missing row (and so DB-level tests that
 * bypass startTask keep exercising the real gate machine).
 */
export async function ensureWorkgroupTaskStateRow(
  db: PersistenceDb,
  taskId: string,
): Promise<void> {
  const { workgroupTaskState } = tablesOf(db)
  await db
    .insert(workgroupTaskState)
    .values({ taskId, gateStatus: 'idle', updatedAt: Date.now() })
    .onConflictDoNothing()
}

/** startTask companion — same transaction as the tasks INSERT. */
export function insertWorkgroupTaskStateTx(tx: DbTxSync, taskId: string, dw: DwState | null): void {
  const { workgroupTaskState } = tablesOf(tx)
  insertOne(tx, workgroupTaskState, {
    taskId,
    gateStatus: 'idle',
    dwStateJson: dw === null ? null : JSON.stringify(DwStateSchema.parse(dw)),
    updatedAt: Date.now(),
  })
}

export interface GateCasArgs {
  from: readonly WorkgroupGateStatus[]
  to: WorkgroupGateStatus
  /** to='declared': stored as gate_summary (previous summary/comment cleared). */
  summary?: string
  /** to='rejected': stored as gate_rejected_comment. */
  rejectedComment?: string
}

function gatePatch(
  args: GateCasArgs,
): Partial<PersistenceTables['workgroupTaskState']['$inferInsert']> {
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

/**
 * RFC-359 W9 —— 门状态 CAS。**事务整个去掉了**，不是换了个事务原语。
 *
 * 体内本来就只有一条语句（`UPDATE … WHERE gate_status IN (…) RETURNING`），单语句在两个引擎上
 * 都是原子的——`from` 集合就是 compare，`RETURNING` 的行数就是 swap 结果。包一层事务既不多给
 * 一分原子性，又把这条路钉死在 bun:sqlite 独有的同步面上（`dbTxSync` 的回调不许 `await`，
 * PostgreSQL 上根本走不了）。同一判据见 `reviewRepairParticipant.ts`（W7 也是直接去掉）。
 *
 * 同步孪生 `casGateStatusTx` 随之删除：它自 RFC-217 起就只被本文件这一处调用（生产零外部调用方，
 * 测试只用异步的 `casGateStatus`），留着等于留一条没人走的 SQLite-only 岔路。
 */
export async function casGateStatus(
  db: PersistenceDb,
  taskId: string,
  args: GateCasArgs,
): Promise<boolean> {
  assertGateTransition(args.from, args.to)
  const { workgroupTaskState } = tablesOf(db)
  const updated = await db
    .update(workgroupTaskState)
    .set({ gateStatus: args.to, updatedAt: Date.now(), ...gatePatch(args) })
    .where(
      and(
        eq(workgroupTaskState.taskId, taskId),
        inArray(workgroupTaskState.gateStatus, [...args.from]),
      ),
    )
    .returning({ taskId: workgroupTaskState.taskId })
  return updated.length > 0
}

// RFC-359：体内只有一条中立的 drizzle UPDATE，`DbClient` 是纯粹多余的收紧。
export async function setPauseReason(
  db: PersistenceDb,
  taskId: string,
  reason: string | null,
): Promise<void> {
  const { workgroupTaskState } = tablesOf(db)
  await db
    .update(workgroupTaskState)
    .set({ pauseReason: reason, updatedAt: Date.now() })
    .where(eq(workgroupTaskState.taskId, taskId))
}

// RFC-359 —— 事务内写数字员工状态。签名从 bun:sqlite 专属的 `DbTxSync` 放宽到中立句柄：
// 唯一的生产调用方是 `services/task.ts` 里 resume 准入 CAS 的 `onClaimTx`，而那笔写事务已经
// 搬到 `databaseSessionFor(db).transaction`。名字保持 `…Tx`（本仓 `…Tx` 表示「吃事务句柄」，
// 中立的 `setNodeRunStatusTx` 同款），facade 符号表因此不动。
export async function setDwStateTx(tx: PersistenceTx, taskId: string, dw: DwState): Promise<void> {
  const { workgroupTaskState } = tablesOf(tx)
  await tx
    .update(workgroupTaskState)
    .set({ dwStateJson: JSON.stringify(DwStateSchema.parse(dw)), updatedAt: Date.now() })
    .where(eq(workgroupTaskState.taskId, taskId))
}

export async function setDwState(db: DbClient, taskId: string, dw: DwState): Promise<void> {
  const { workgroupTaskState } = tablesOf(db)
  await db
    .update(workgroupTaskState)
    .set({ dwStateJson: JSON.stringify(DwStateSchema.parse(dw)), updatedAt: Date.now() })
    .where(eq(workgroupTaskState.taskId, taskId))
}

// ---------------------------------------------------------------------------
// RFC-217 T3 — engine durable-state I/O (moved from runner.ts): the pass-start
// snapshot every wake derivation / driver reads.
// ---------------------------------------------------------------------------

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
 * agentId is the selected resource identity. A missing/id-less agent simply yields no card
 * (the roster row still renders with displayName + roleDesc). human members are
 * skipped entirely so no user identity can leak into the prompt.
 */
export async function buildRosterAgentCards(
  db: PersistenceDb,
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

export function rowToAssignment(
  r: PersistenceTables['workgroupAssignments']['$inferSelect'],
): WorkgroupAssignment {
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

export function rowToMessage(
  r: PersistenceTables['workgroupMessages']['$inferSelect'],
): WorkgroupMessage {
  let mentions: string[] = []
  try {
    const parsed = JSON.parse(r.mentionsJson) as unknown
    mentions = Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : []
  } catch {
    mentions = []
  }
  const template = parseStoredTemplateMetadata(r.templateKey, r.templateParamsJson)
  return {
    id: r.id,
    taskId: r.taskId,
    round: r.round,
    authorKind: r.authorKind,
    authorMemberId: r.authorMemberId,
    authorUserId: r.authorUserId,
    kind: r.kind,
    bodyMd: r.bodyMd,
    templateKey: template?.key ?? null,
    templateParams: template?.params ?? null,
    mentionMemberIds: mentions,
    assignmentId: r.assignmentId,
    triggerMessageId: r.triggerMessageId,
    createdAt: r.createdAt,
  }
}

/**
 * RFC-243 §6.4 — stamp the result anchor. A plain column write (NOT a gate
 * transition): the engine's done path calls it exactly once per convergence;
 * last write wins on the (unreachable) double-done.
 */
export async function stampWorkgroupResultAnchor(
  db: DbClient,
  taskId: string,
  messageId: string,
): Promise<void> {
  const { workgroupTaskState } = tablesOf(db)
  await db
    .update(workgroupTaskState)
    .set({ resultMessageId: messageId, updatedAt: Date.now() })
    .where(eq(workgroupTaskState.taskId, taskId))
}

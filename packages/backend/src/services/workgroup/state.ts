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

import { DwStateSchema, type DwState } from '@agent-workflow/shared'
import { and, eq, inArray } from 'drizzle-orm'
import type { DbClient } from '@/db/client'
import { dbTxSync, type DbTxSync } from '@/db/txSync'
import { workgroupTaskState } from '@/db/schema'

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

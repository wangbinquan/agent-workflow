// RFC-304 — the work item store: apply a decision under CAS, or lose the race.
//
// This is the seam where the pure transition function meets concurrency. The
// discipline copies `services/lifecycle.ts`: decide in a pure function, then
// write with `WHERE id = ? AND status = <the status we decided against>`. A
// write that landed without that guard would apply a decision made against a
// state the row has since left — which for this machine means things like
// superseding a round that already published, or opening a second round for an
// item another handler just queued.
//
// Effects are NOT executed here. The store advances the row and reports which
// effects the caller must now perform, because effects reach outside the
// database (cancel a task, post a comment, start a round) and a store that did
// them would make every one of them un-testable without those systems.

import { and, eq, sql } from 'drizzle-orm'
import type { DbClient } from '@/db/client'
import { codeWorkItems } from '@/db/schema'
import {
  decideCodeWorkItemTransition,
  type CodeWorkItemContext,
  type CodeWorkItemEffect,
  type CodeWorkItemEvent,
  type CodeWorkItemStatus,
} from '@/modules/code-capability/domain/workItemLifecycle'

export interface WorkItemRow {
  id: string
  status: CodeWorkItemStatus
  epoch: number
  pendingGeneration: number | null
  handedOffFingerprint: string | null
  publishingEpoch: number | null
  pendingRevision: string | null
  currentRoundId: string | null
}

export async function readWorkItem(db: DbClient, id: string): Promise<WorkItemRow | null> {
  const [row] = await db.select().from(codeWorkItems).where(eq(codeWorkItems.id, id)).limit(1)
  if (row === undefined) return null
  return {
    id: row.id,
    status: row.status,
    epoch: row.epoch,
    pendingGeneration: row.pendingGeneration,
    handedOffFingerprint: row.handedOffFingerprint,
    publishingEpoch: row.publishingEpoch,
    pendingRevision: row.pendingRevision,
    currentRoundId: row.currentRoundId,
  }
}

export function contextOf(
  row: WorkItemRow,
  hasLiveRound: boolean,
  resumeFromStage: string | null,
): CodeWorkItemContext {
  return {
    status: row.status,
    epoch: row.epoch,
    pendingGeneration: row.pendingGeneration,
    hasLiveRound,
    handedOffFingerprint: row.handedOffFingerprint,
    resumeFromStage,
    publishingEpoch: row.publishingEpoch,
    pendingRevision: row.pendingRevision === null ? null : { epoch: row.epoch },
  }
}

export type ApplyOutcome =
  | {
      outcome: 'applied'
      from: CodeWorkItemStatus
      to: CodeWorkItemStatus
      effects: CodeWorkItemEffect[]
    }
  /** No status change, but effects may still be pending. */
  | { outcome: 'stayed'; status: CodeWorkItemStatus; effects: CodeWorkItemEffect[]; reason: string }
  | { outcome: 'rejected'; reason: string }
  /** Another writer moved the row between our read and our write. */
  | { outcome: 'raced'; expected: CodeWorkItemStatus }
  | { outcome: 'missing' }

export interface ApplyEventArgs {
  db: DbClient
  workItemId: string
  event: CodeWorkItemEvent
  hasLiveRound: boolean
  resumeFromStage?: string | null
  now?: () => number
}

/**
 * Read the item, decide, and write the result under CAS.
 *
 * Losing the CAS returns `raced` rather than throwing or retrying: the caller
 * knows whether this event can simply be re-applied against the new state
 * (usually yes) or whether it has already been served by whoever won.
 */
export async function applyWorkItemEvent(args: ApplyEventArgs): Promise<ApplyOutcome> {
  const now = (args.now ?? Date.now)()
  const row = await readWorkItem(args.db, args.workItemId)
  if (row === null) return { outcome: 'missing' }

  const ctx = contextOf(row, args.hasLiveRound, args.resumeFromStage ?? null)
  const decision = decideCodeWorkItemTransition(ctx, args.event)
  if (decision.outcome === 'rejected') return { outcome: 'rejected', reason: decision.reason }

  // Field updates implied by the effects. Derived here rather than by the
  // caller so a caller that forgets to run an effect still cannot leave the row
  // internally inconsistent (e.g. `awaiting` with no pending generation, which
  // would make guard 2 accept any confirmation).
  const patch: Record<string, unknown> = { updatedAt: now }
  for (const effect of decision.effects) {
    switch (effect.kind) {
      case 'bump-epoch':
        patch.epoch = sql`${codeWorkItems.epoch} + 1`
        break
      case 'record-wait-handle':
        patch.pendingGeneration = effect.pendingGeneration
        break
      case 'clear-wait-handle':
        patch.pendingGeneration = null
        break
      case 'register-pending-revision':
        patch.pendingRevision = JSON.stringify({ at: now })
        break
      case 'consume-pending-revision':
        patch.pendingRevision = null
        break
      case 'post-handoff-summary':
        patch.handedOffFingerprint = effect.failureFingerprint
        break
      default:
        break
    }
  }

  if (decision.outcome === 'stay') {
    // Even a non-transition may need a field write (registering a revision is
    // the whole point of the critical-section arm). CAS on status anyway: if
    // the row moved, this event was decided against a state that no longer
    // holds.
    if (Object.keys(patch).length > 1) {
      const updated = await args.db
        .update(codeWorkItems)
        .set(patch)
        .where(and(eq(codeWorkItems.id, row.id), eq(codeWorkItems.status, row.status)))
        .returning({ id: codeWorkItems.id })
      if (updated.length === 0) return { outcome: 'raced', expected: row.status }
    }
    return {
      outcome: 'stayed',
      status: row.status,
      effects: decision.effects,
      reason: decision.reason,
    }
  }

  patch.status = decision.to
  if (decision.to === 'closed') patch.closedAt = now
  // Leaving `handed_off` clears its campaign fingerprint, or the next hand-off
  // would inherit the previous campaign's identity and its quota with it.
  if (row.status === 'handed_off' && decision.to !== 'handed_off') {
    patch.handedOffFingerprint = null
  }

  const updated = await args.db
    .update(codeWorkItems)
    .set(patch)
    .where(and(eq(codeWorkItems.id, row.id), eq(codeWorkItems.status, row.status)))
    .returning({ id: codeWorkItems.id })
  if (updated.length === 0) return { outcome: 'raced', expected: row.status }

  return { outcome: 'applied', from: row.status, to: decision.to, effects: decision.effects }
}

/**
 * Enter the publish critical section for `epoch`.
 *
 * CAS-guarded on the epoch AND on the section being free: a round whose epoch
 * has already been bumped must NOT be able to enter, and two rounds must not
 * both believe they hold it. Returns false when either check fails, and the
 * caller must then abandon its publish rather than proceed.
 */
export async function enterPublishSection(
  db: DbClient,
  workItemId: string,
  epoch: number,
  now: number = Date.now(),
): Promise<boolean> {
  const updated = await db
    .update(codeWorkItems)
    .set({ publishingEpoch: epoch, updatedAt: now })
    .where(
      and(
        eq(codeWorkItems.id, workItemId),
        eq(codeWorkItems.epoch, epoch),
        sql`${codeWorkItems.publishingEpoch} IS NULL`,
      ),
    )
    .returning({ id: codeWorkItems.id })
  return updated.length > 0
}

/**
 * Leave the critical section.
 *
 * Guarded on the epoch that entered it, so a later round cannot clear a section
 * it does not hold — that would let an event supersede a publish that is still
 * in flight, which is precisely what the section exists to prevent.
 */
export async function leavePublishSection(
  db: DbClient,
  workItemId: string,
  epoch: number,
  now: number = Date.now(),
): Promise<boolean> {
  const updated = await db
    .update(codeWorkItems)
    .set({ publishingEpoch: null, updatedAt: now })
    .where(and(eq(codeWorkItems.id, workItemId), eq(codeWorkItems.publishingEpoch, epoch)))
    .returning({ id: codeWorkItems.id })
  return updated.length > 0
}

/**
 * Clear stale critical-section markers at boot.
 *
 * A daemon that died mid-publish leaves the marker set, and nothing would ever
 * clear it — every subsequent event on that MR would be registered as a pending
 * revision and the item would never advance again. Returns how many were
 * cleared, which the boot log reports.
 */
export async function clearStalePublishSections(
  db: DbClient,
  now: number = Date.now(),
): Promise<number> {
  const cleared = await db
    .update(codeWorkItems)
    .set({ publishingEpoch: null, updatedAt: now })
    .where(sql`${codeWorkItems.publishingEpoch} IS NOT NULL`)
    .returning({ id: codeWorkItems.id })
  return cleared.length
}

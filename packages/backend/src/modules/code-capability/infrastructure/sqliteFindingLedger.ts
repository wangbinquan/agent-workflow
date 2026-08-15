// RFC-304 §2.4 / §6 — the findings ledger, persisted.
//
// `domain/findingReconcile.ts` decides what should happen to each finding; this
// stores the answer. Keeping them apart is what lets the interesting rule — an
// external action fires only on the active→disappeared EDGE — be tested without
// a database, and it is the rule most worth protecting: firing on every
// subsequent round is what produced 78 identical "no longer present" replies on
// one long-lived MR.
//
// ## What the ledger buys
//
// Continuity. Without it, round two reposts everything round one said, and an
// MR that saw ten pushes carries ten copies of each remark. With it, a finding
// that is still there stays as one thread, quietly refreshed.
//
// ## Why the key excludes the work item
//
// A finding belongs to the MR. Keying it to the work item that observed it
// would detach the entire history the day a work item is rebuilt — and the
// rebuilt one would then republish every open finding as brand new.

import { and, eq, isNull } from 'drizzle-orm'
import { ulid } from 'ulid'
import type { DbClient } from '@/db/client'
import { codeFindings } from '@/db/schema'
import type {
  FindingLifecycle,
  LedgerFinding,
} from '@/modules/code-capability/domain/findingReconcile'
import type { FindingLedgerPort } from '@/modules/code-capability/ports/findingLedgerPort'

/** The anchor a ledger row belongs to — the MR, never the work item. */
export interface LedgerAnchor {
  codeHostEndpointId: string
  stableProjectId: string
  anchorKind: 'mr' | 'issue' | 'pipeline'
  anchorId: string
}

function anchorWhere(anchor: LedgerAnchor) {
  return and(
    eq(codeFindings.codeHostEndpointId, anchor.codeHostEndpointId),
    eq(codeFindings.stableProjectId, anchor.stableProjectId),
    eq(codeFindings.anchorKind, anchor.anchorKind),
    eq(codeFindings.anchorId, anchor.anchorId),
  )
}

/**
 * Every ledger row for an anchor, in the shape reconcile consumes.
 *
 * Returns ALL lifecycles, not just active ones: reconcile needs to see the
 * `disappeared` rows to tell "new finding" apart from "one that came back", and
 * those two need different handling — the second must publish under a new
 * generation rather than reuse a thread that was already resolved.
 */
export async function readLedgerForAnchor(
  db: DbClient,
  anchor: LedgerAnchor,
  capability: string,
): Promise<LedgerFinding[]> {
  const rows = await db
    .select({
      fingerprint: codeFindings.fingerprint,
      lifecycle: codeFindings.lifecycle,
      generation: codeFindings.generation,
      externalId: codeFindings.externalId,
    })
    .from(codeFindings)
    .where(and(anchorWhere(anchor), eq(codeFindings.capability, capability)))

  return rows.map((row) => ({
    fingerprint: row.fingerprint,
    lifecycle: row.lifecycle as FindingLifecycle,
    generation: row.generation,
    externalId: row.externalId,
  }))
}

export interface RecordPublishedInput {
  db: DbClient
  anchor: LedgerAnchor
  capability: string
  fingerprint: string
  generation: number
  roundId: string
  now: number
  severity?: string | undefined
  title?: string | undefined
  filePath?: string | undefined
  anchorLine?: number | undefined
  /** The host's thread id, when publishing produced one. */
  externalId?: string | undefined
}

/**
 * Record a finding this round published.
 *
 * Upsert on the identity key so a retried round does not create a second row
 * for the same (finding, generation) — a retry is the same finding said once,
 * and two rows would make the next round see a duplicate that never existed.
 */
export async function recordPublishedFinding(input: RecordPublishedInput): Promise<void> {
  const values = {
    id: ulid(),
    codeHostEndpointId: input.anchor.codeHostEndpointId,
    stableProjectId: input.anchor.stableProjectId,
    anchorKind: input.anchor.anchorKind,
    anchorId: input.anchor.anchorId,
    capability: input.capability,
    fingerprint: input.fingerprint,
    generation: input.generation,
    lifecycle: 'active' as const,
    severity: input.severity ?? null,
    title: input.title ?? null,
    filePath: input.filePath ?? null,
    anchorLine: input.anchorLine ?? null,
    externalId: input.externalId ?? null,
    publishedRoundId: input.roundId,
    createdAt: input.now,
    lastSeenAt: input.now,
  }

  await input.db
    .insert(codeFindings)
    .values(values)
    .onConflictDoUpdate({
      target: [
        codeFindings.codeHostEndpointId,
        codeFindings.stableProjectId,
        codeFindings.anchorKind,
        codeFindings.anchorId,
        codeFindings.fingerprint,
        codeFindings.generation,
      ],
      set: {
        lifecycle: 'active',
        lastSeenAt: input.now,
        // Cleared deliberately: a row being published again is no longer
        // closed, and leaving a stale `closedAt` would make "when did this stop
        // being a problem" answer with a date it was still open.
        closedAt: null,
        ...(input.externalId !== undefined ? { externalId: input.externalId } : {}),
        ...(input.anchorLine !== undefined ? { anchorLine: input.anchorLine } : {}),
      },
    })
}

/**
 * A finding that is still present: refresh it, without touching its thread.
 *
 * `anchorLine` moves because a rebase shifts lines; the thread does NOT get
 * reposted and does NOT get resolved. That combination is the whole point — the
 * problem is still there, so the existing comment should stay exactly as it is.
 */
export async function refreshSeenFinding(input: {
  db: DbClient
  anchor: LedgerAnchor
  capability: string
  fingerprint: string
  anchorLine: number | null
  now: number
}): Promise<void> {
  await input.db
    .update(codeFindings)
    .set({ lastSeenAt: input.now, anchorLine: input.anchorLine })
    .where(
      and(
        anchorWhere(input.anchor),
        eq(codeFindings.capability, input.capability),
        eq(codeFindings.fingerprint, input.fingerprint),
        eq(codeFindings.lifecycle, 'active'),
      ),
    )
}

/**
 * Mark a finding gone — the active→disappeared edge.
 *
 * Only rows currently `active` are moved, which is what makes this idempotent:
 * the provider action that accompanies it (resolve on GitLab, a reply on
 * GitHub) must happen exactly once, and a second round finding nothing to
 * update is how that guarantee is enforced in the data rather than in a caller.
 */
export async function markFindingDisappeared(input: {
  db: DbClient
  anchor: LedgerAnchor
  capability: string
  fingerprint: string
  roundId: string
  now: number
}): Promise<boolean> {
  const before = await input.db
    .select({ id: codeFindings.id })
    .from(codeFindings)
    .where(
      and(
        anchorWhere(input.anchor),
        eq(codeFindings.capability, input.capability),
        eq(codeFindings.fingerprint, input.fingerprint),
        eq(codeFindings.lifecycle, 'active'),
      ),
    )
  if (before.length === 0) return false

  await input.db
    .update(codeFindings)
    .set({
      lifecycle: 'disappeared',
      disappearedRoundId: input.roundId,
      closedAt: input.now,
      lastSeenAt: input.now,
    })
    .where(eq(codeFindings.id, before[0]!.id))
  return true
}

/**
 * The highest generation seen for a fingerprint on this anchor.
 *
 * Used when a disappeared finding returns: the new row must not collide with
 * the old one, and the old one must survive as history — "this keeps coming
 * back" is only answerable if the previous rows are still there.
 */
export async function highestGeneration(
  db: DbClient,
  anchor: LedgerAnchor,
  capability: string,
  fingerprint: string,
): Promise<number> {
  const rows = await db
    .select({ generation: codeFindings.generation })
    .from(codeFindings)
    .where(
      and(
        anchorWhere(anchor),
        eq(codeFindings.capability, capability),
        eq(codeFindings.fingerprint, fingerprint),
      ),
    )
  return rows.reduce((max, row) => (row.generation > max ? row.generation : max), 0)
}

/**
 * Bind the ledger to one round.
 *
 * The round id and capability are fixed here rather than passed per call: they
 * are the same for every write a round makes, and a stage that could choose
 * them could attribute this round's findings to another one — which is exactly
 * the history the ledger exists to keep straight.
 */
export function createSqliteFindingLedger(
  db: DbClient,
  bind: { capability: string; roundId: string; now?: () => number },
): FindingLedgerPort {
  const clock = bind.now ?? (() => Date.now())
  return {
    read: (anchor) => readLedgerForAnchor(db, anchor, bind.capability),
    recordPublished: (args) =>
      recordPublishedFinding({
        db,
        anchor: args.anchor,
        capability: bind.capability,
        fingerprint: args.fingerprint,
        generation: args.generation,
        roundId: bind.roundId,
        now: clock(),
        ...(args.externalId !== null ? { externalId: args.externalId } : {}),
        ...(args.severity !== undefined ? { severity: args.severity } : {}),
        ...(args.title !== undefined ? { title: args.title } : {}),
        ...(args.filePath !== undefined ? { filePath: args.filePath } : {}),
        ...(args.anchorLine !== undefined ? { anchorLine: args.anchorLine } : {}),
      }),
    refreshSeen: (anchor, fingerprint, anchorLine) =>
      refreshSeenFinding({
        db,
        anchor,
        capability: bind.capability,
        fingerprint,
        anchorLine,
        now: clock(),
      }),
    markAdoption: (anchor, fingerprint, signal) =>
      markAdoptionSignal({
        db,
        anchor,
        capability: bind.capability,
        fingerprint,
        signal,
        roundId: bind.roundId,
        now: clock(),
      }),
    readAnchors: (anchor) => readLedgerAnchors(db, anchor, bind.capability),
    markDisappeared: (anchor, fingerprint) =>
      markFindingDisappeared({
        db,
        anchor,
        capability: bind.capability,
        fingerprint,
        roundId: bind.roundId,
        now: clock(),
      }),
  }
}

/**
 * Record an adoption signal, once.
 *
 * Guarded on the column still being null, which is what makes "first
 * observation wins" a property of the data rather than of whichever caller
 * happens to run. Returns whether THIS call set it — the caller uses that to
 * avoid reporting the same adoption every round.
 */
export async function markAdoptionSignal(input: {
  db: DbClient
  anchor: LedgerAnchor
  capability: string
  fingerprint: string
  signal: 'resolved' | 'code-changed'
  roundId: string
  now: number
}): Promise<boolean> {
  const column = input.signal === 'resolved' ? codeFindings.resolvedAt : codeFindings.codeChangedAt
  const updated = await input.db
    .update(codeFindings)
    .set(
      input.signal === 'resolved'
        ? { resolvedAt: input.now, resolvedRoundId: input.roundId }
        : { codeChangedAt: input.now, codeChangedRoundId: input.roundId },
    )
    .where(
      and(
        anchorWhere(input.anchor),
        eq(codeFindings.capability, input.capability),
        eq(codeFindings.fingerprint, input.fingerprint),
        isNull(column),
      ),
    )
    .returning({ id: codeFindings.id })
  return updated.length > 0
}

/** Each finding's last recorded anchor line, for detecting drift. */
export async function readLedgerAnchors(
  db: DbClient,
  anchor: LedgerAnchor,
  capability: string,
): Promise<Array<{ fingerprint: string; anchorLine: number | null }>> {
  return await db
    .select({ fingerprint: codeFindings.fingerprint, anchorLine: codeFindings.anchorLine })
    .from(codeFindings)
    .where(and(anchorWhere(anchor), eq(codeFindings.capability, capability)))
}

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

import { and, eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import type { DbClient } from '@/db/client'
import { codeFindings } from '@/db/schema'
import type {
  FindingLifecycle,
  LedgerFinding,
} from '@/modules/code-capability/domain/findingReconcile'

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

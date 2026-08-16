// RFC-304 T50b — closing a requirement when the merge request it produced lands.
//
// The two halves of this are recorded at completely different moments by
// completely different code paths, which is why the join has to be explicit:
//
//   register — `open-mr` has just created the merge request and knows both the
//              work item and the new MR. This is the only moment both facts are
//              in one place.
//   consume  — a terminal MR event arrives, days later, carrying the MR and
//              nothing else. It asks this index which work item to advance.
//
// Without the index the terminal event has no way back: it would have to scan
// every open work item's `anchor_meta` JSON on every merge in the deployment,
// and a requirement whose MR merged would simply stay open — the code shipped,
// the platform never noticed, and the activity view shows work in progress
// forever.

import { and, eq, isNull } from 'drizzle-orm'
import type { DbClient } from '@/db/client'
import { codeProducedMrs } from '@/db/schema'

/**
 * The key a terminal event can construct from what it carries.
 *
 * Components are encoded before joining, so a project id containing the
 * separator cannot forge another project's key. Cheap here, and the alternative
 * is a cross-project collision that closes the wrong requirement.
 */
export function producedMrKey(input: {
  codeHostEndpointId: string
  stableProjectId: string
  mrIid: string
}): string {
  return [input.codeHostEndpointId, input.stableProjectId, input.mrIid]
    .map((part) => encodeURIComponent(part))
    .join('|')
}

export interface RegisterProducedMrArgs {
  db: DbClient
  codeHostEndpointId: string
  stableProjectId: string
  mrIid: string
  workItemId: string
  roundId?: string
  now?: number
}

/**
 * Record that this work item produced this merge request.
 *
 * `onConflictDoNothing` because a retried `open-mr` stage — a round that
 * created the MR and then failed before settling — must not fail on the second
 * attempt. The first registration is the true one: the MR already exists, and a
 * later round pointing the same MR at a different work item would be a bug
 * worth keeping out rather than overwriting into place.
 */
export async function registerProducedMr(args: RegisterProducedMrArgs): Promise<{ key: string }> {
  const key = producedMrKey(args)
  await args.db
    .insert(codeProducedMrs)
    .values({
      mrKey: key,
      codeHostEndpointId: args.codeHostEndpointId,
      stableProjectId: args.stableProjectId,
      mrIid: args.mrIid,
      workItemId: args.workItemId,
      ...(args.roundId === undefined ? {} : { roundId: args.roundId }),
      createdAt: args.now ?? Date.now(),
    })
    .onConflictDoNothing()
  return { key }
}

export interface ProducedMrRow {
  mrKey: string
  workItemId: string
  roundId: string | null
  closedAt: number | null
}

/** Which work item produced this merge request, if the platform did. */
export async function lookupProducedMr(
  db: DbClient,
  input: { codeHostEndpointId: string; stableProjectId: string; mrIid: string },
): Promise<ProducedMrRow | null> {
  const [row] = await db
    .select()
    .from(codeProducedMrs)
    .where(eq(codeProducedMrs.mrKey, producedMrKey(input)))
    .limit(1)
  if (row === undefined) return null
  return {
    mrKey: row.mrKey,
    workItemId: row.workItemId,
    roundId: row.roundId,
    closedAt: row.closedAt,
  }
}

export type ClaimResult =
  /** This event is the one that closes it; the caller advances the work item. */
  | { claimed: true; workItemId: string }
  /** Not ours, or already handled. */
  | { claimed: false; reason: 'not-produced-here' | 'already-closed' }

/**
 * Claim a terminal MR event, exactly once.
 *
 * The claim is a CAS — `WHERE closed_at IS NULL` — rather than a read followed
 * by a write. A merge produces several deliveries (the merge itself, the
 * pipeline that follows, a close event on some configurations), and each of
 * them wakes this path. Two of them reading "not closed yet" and both advancing
 * the work item would post two "requirement delivered" notices for one merge.
 */
export async function claimTerminalMr(
  db: DbClient,
  input: { codeHostEndpointId: string; stableProjectId: string; mrIid: string; now?: number },
): Promise<ClaimResult> {
  const key = producedMrKey(input)
  const updated = await db
    .update(codeProducedMrs)
    .set({ closedAt: input.now ?? Date.now() })
    .where(and(eq(codeProducedMrs.mrKey, key), isNull(codeProducedMrs.closedAt)))
    .returning({ workItemId: codeProducedMrs.workItemId })

  const row = updated[0]
  if (row !== undefined) return { claimed: true, workItemId: row.workItemId }

  // Nothing updated: either the row is not here (an ordinary merge request the
  // platform did not produce — by far the common case) or somebody already
  // claimed it. The two are worth telling apart, because the second means an
  // event arrived twice and the first means it was never ours.
  const existing = await lookupProducedMr(db, input)
  return {
    claimed: false,
    reason: existing === null ? 'not-produced-here' : 'already-closed',
  }
}

/** Everything a work item has produced, for the state view. */
export async function producedMrsOf(db: DbClient, workItemId: string): Promise<ProducedMrRow[]> {
  const rows = await db
    .select()
    .from(codeProducedMrs)
    .where(eq(codeProducedMrs.workItemId, workItemId))
  return rows.map((row) => ({
    mrKey: row.mrKey,
    workItemId: row.workItemId,
    roundId: row.roundId,
    closedAt: row.closedAt,
  }))
}

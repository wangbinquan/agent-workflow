// RFC-304 §7 T22b — reading back what a batch actually posted.
//
// `planPublishRecovery` (domain/publishIntent.ts) already decides what to do
// given what the remote holds. This module is the other half: turning each
// host's read-back into that input. It is separate because the two hosts store
// a published batch in completely different places, and the mapping is where a
// recovery pass silently goes wrong.
//
// The identifying trick, and the reason recovery works at all: every comment
// this platform posts carries its finding's FINGERPRINT in a marker line. Not
// the batch id — a batch is a platform concept the code host knows nothing
// about, and matching by "comments created around that time by that user" would
// adopt a human's comment as one of ours the first time someone replies quickly.
//
// GitLab  drafts live under the MR's draft_notes until bulk_publish, after
//         which they are ordinary notes/discussions. So recovery has to look in
//         BOTH: a crash before the publish leaves drafts, a crash after leaves
//         notes, and "not in drafts" alone would resend the whole batch onto an
//         MR that already has it.
// GitHub  everything is inside the review's comments — one place, because the
//         submit is one request.

/** The marker appended to every posted body so a read-back can identify it. */
export const FINGERPRINT_MARKER_PREFIX = 'aw-finding:'

/**
 * Append the marker. Kept in an HTML comment so it does not clutter what the
 * author reads, while still surviving the round-trip through both hosts'
 * markdown rendering.
 */
export function withFingerprintMarker(body: string, fingerprint: string): string {
  return `${body}\n\n<!-- ${FINGERPRINT_MARKER_PREFIX}${fingerprint} -->`
}

/**
 * Recover the fingerprint from a body read back from the host.
 *
 * Returns null for anything without a marker — a human's comment, or one from
 * an older platform version. Adopting those would attribute someone else's
 * remark to one of our findings.
 */
export function fingerprintOf(body: string): string | null {
  const match = /<!--\s*aw-finding:([A-Za-z0-9_-]+)\s*-->/.exec(body)
  return match?.[1] ?? null
}

/** One comment as read back from a host, normalized. */
export interface RemoteComment {
  externalId: string
  body: string
}

/**
 * Build the observation `planPublishRecovery` consumes.
 *
 * Only fingerprints belonging to THIS batch are reported: the MR may carry
 * findings from earlier rounds, and treating those as part of the batch would
 * mark entries "already posted" that this batch never sent — leaving them
 * permanently unpublished while the ledger claims success.
 */
export function observeBatch(
  batchFingerprints: readonly string[],
  comments: readonly RemoteComment[],
): { present: Record<string, string> } {
  const wanted = new Set(batchFingerprints)
  const present: Record<string, string> = {}
  for (const comment of comments) {
    const fingerprint = fingerprintOf(comment.body)
    if (fingerprint === null || !wanted.has(fingerprint)) continue
    // First occurrence wins. A duplicate means an earlier recovery already
    // resent one; adopting the newest would orphan the older copy, so the
    // caller settles on the first and the duplicate is reported separately.
    if (present[fingerprint] === undefined) present[fingerprint] = comment.externalId
  }
  return { present }
}

/**
 * Which remote surfaces a host must be read from before deciding.
 *
 * GitLab needs BOTH: a crash before `bulk_publish` leaves drafts, a crash after
 * leaves ordinary notes. Reading only drafts would resend an entire batch onto
 * an MR that already displays it — the duplicate-comment bug this whole
 * mechanism exists to prevent, reintroduced by an incomplete read.
 */
export function readBackSurfaces(provider: 'gitlab' | 'github'): readonly string[] {
  return provider === 'gitlab' ? ['draft_notes', 'notes'] : ['review_comments']
}

/**
 * Duplicates found during read-back, i.e. one fingerprint with several
 * comments.
 *
 * Reported rather than silently deduped: it means a previous recovery resent
 * something that had in fact landed, and the operator should see that the MR
 * now shows the same remark twice — the platform cannot delete a published
 * comment on the author's behalf.
 */
export function duplicateFingerprints(comments: readonly RemoteComment[]): string[] {
  const counts = new Map<string, number>()
  for (const comment of comments) {
    const fingerprint = fingerprintOf(comment.body)
    if (fingerprint === null) continue
    counts.set(fingerprint, (counts.get(fingerprint) ?? 0) + 1)
  }
  return [...counts.entries()]
    .filter(([, n]) => n > 1)
    .map(([fingerprint]) => fingerprint)
    .sort()
}

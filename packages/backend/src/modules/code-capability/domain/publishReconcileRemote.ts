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
 * Like `observeBatch`, but for reading back a publish that JUST happened.
 *
 * The difference is which duplicate wins, and it matters more than it looks.
 * `observeBatch` keeps the FIRST match, which is right for recovery: the oldest
 * comment is the one that was already there, and adopting a newer copy would
 * orphan it.
 *
 * After publishing, the opposite is true. A finding that disappeared and came
 * back is republished under a new generation while its ORIGINAL comment is
 * still on the MR carrying the same fingerprint — the fingerprint is derived
 * from the finding's content, so a recurrence is identical to its first
 * appearance. Keeping the first match would hand the new generation the old,
 * already-resolved thread; `settle-stale` would then resolve a resolved thread
 * and the live one would never be closed.
 *
 * Both hosts return these lists oldest-first (GitLab discussions by creation,
 * GitHub review comments by ascending id), so the last match is the one this
 * publish created.
 */
export function observeJustPublished(
  batchFingerprints: readonly string[],
  comments: readonly RemoteComment[],
): { present: Record<string, string> } {
  const wanted = new Set(batchFingerprints)
  const present: Record<string, string> = {}
  for (const comment of comments) {
    const fingerprint = fingerprintOf(comment.body)
    if (fingerprint === null || !wanted.has(fingerprint)) continue
    // Last write wins — the newest comment carrying this fingerprint.
    present[fingerprint] = comment.externalId
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

/**
 * Read a host's comment list into the shape `observeBatch` consumes.
 *
 * The two hosts differ in a way that matters. GitLab returns DISCUSSIONS — a
 * thread with an id and a list of notes — and the id is the one `thread.resolve`
 * needs, while the fingerprint marker is in the first note's body. GitHub
 * returns flat review comments whose own id is what a reply targets.
 *
 * Reading GitLab's notes as if they were top-level comments would collect note
 * ids, which no action accepts; reading GitHub's list from `/issues/{n}/comments`
 * would return MR-level comments and miss every inline one — recovery would then
 * conclude that a whole batch never landed and repost all of it.
 *
 * Anything unparsable yields an empty list rather than throwing: this feeds a
 * recovery decision, and the caller distinguishes "nothing is there" from "we
 * could not look" by whether the CALL failed, not by whether the body parsed.
 */
export function normalizeRemoteComments(
  provider: 'gitlab' | 'github',
  body: string,
): RemoteComment[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []

  const out: RemoteComment[] = []
  for (const entry of parsed) {
    if (typeof entry !== 'object' || entry === null) continue
    const row = entry as Record<string, unknown>

    if (provider === 'github') {
      const id = row.id
      const text = row.body
      if ((typeof id === 'string' || typeof id === 'number') && typeof text === 'string') {
        out.push({ externalId: String(id), body: text })
      }
      continue
    }

    // GitLab: the discussion id is the thread identity; the marker rides in the
    // first note. Later notes are replies — a human's, or our own settle note —
    // and adopting one of those as the finding's thread would resolve the wrong
    // thing later.
    const id = row.id
    const notes = row.notes
    if (typeof id !== 'string' && typeof id !== 'number') continue
    if (!Array.isArray(notes) || notes.length === 0) continue
    const first = notes[0] as Record<string, unknown> | undefined
    const text = first?.body
    if (typeof text !== 'string') continue
    out.push({ externalId: String(id), body: text })
  }
  return out
}

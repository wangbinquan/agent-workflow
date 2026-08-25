// RFC-326 — string occurrence primitives shared by three consumers that must
// agree byte-for-byte on "which occurrence is the N-th":
//
//   · backend `services/review.ts` — `recomputeOccurrenceIndex` / `canonicalizeAnchor`
//     (the number that lands in `review_comments.occurrence_index`),
//   · backend `modules/collaboration/domain/reviewAnchor.ts` — the simplified-anchor
//     resolver (the number it reports in candidates and stores),
//   · frontend `lib/review/anchor.ts` + `components/prose/rehypeWrapAnchors.ts` —
//     the number the web page uses to find the highlight.
//
// Before this module each side kept its own copy ("mirrors the backend helper so the
// math agrees"), and the third copy (the highlighter) had silently drifted to
// OVERLAPPING counting (`pos = i + 1`) — `aa` in `aaaa` was occurrence 1..3 on the
// page but 1..2 in the database. One implementation, non-overlapping, left to right.
//
// Zero dependencies; pure.

/**
 * Every occurrence of `needle` in `haystack`, as 0-based start offsets in document
 * order. Non-overlapping: after a hit the scan resumes at `hit + needle.length`.
 * An empty needle never matches.
 */
export function findAllOccurrences(haystack: string, needle: string): number[] {
  const out: number[] = []
  forEachOccurrence(haystack, needle, (offset) => {
    out.push(offset)
  })
  return out
}

/**
 * Visitor for `forEachOccurrence`. `index` is the 1-based occurrence number (the
 * same number `ReviewCommentAnchor.occurrenceIndex` carries). Return `false` to stop
 * the scan early; anything else continues.
 */
export type OccurrenceVisitor = (offset: number, index: number) => boolean | void

/**
 * Single-pass, non-overlapping iteration over the occurrences of `needle`. Returns
 * the number of occurrences visited — the exact total when the visitor never
 * stopped the scan.
 *
 * The anchor resolver uses this to do counting, candidate collection and target
 * location in ONE scan: collection may stop storing after a cap, but the scan keeps
 * going so `total` stays exact and a requested occurrence beyond the cap is still
 * found.
 */
export function forEachOccurrence(
  haystack: string,
  needle: string,
  visit: OccurrenceVisitor,
): number {
  if (needle.length === 0) return 0
  let from = 0
  let index = 0
  while (true) {
    const idx = haystack.indexOf(needle, from)
    if (idx < 0) break
    index += 1
    if (visit(idx, index) === false) break
    from = idx + needle.length
  }
  return index
}

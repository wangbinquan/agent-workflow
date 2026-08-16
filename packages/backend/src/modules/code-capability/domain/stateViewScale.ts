// RFC-304 §11.7 (T66) — the state view on a merge request with 80 rounds.
//
// The numbers from §11.4: 27,000 rounds per repository per half-year, ~400,000
// AI attempt rows. A state view that loads a work item's whole history is fine
// on the first day and unusable by the third month — and it degrades on exactly
// the merge requests people care most about, because the long-lived ones are
// the ones with a history worth reading.
//
// Three bounds, and the reason each is where it is:
//
//   rounds       — the current one plus a window. Somebody looking at a work
//                  item wants what just happened; older rounds are reached
//                  deliberately, through the switcher.
//   attempts     — per stage, on demand. They are the widest rows and most
//                  stages are never expanded.
//   virtualise   — past a threshold, render a window rather than every row.
//
// The bounds are stated as constants rather than inlined so a page and a query
// cannot disagree about them — a view that renders 20 while the query returns
// 3 shows a truncated list with no indication it was truncated.

/** Rounds fetched with a work item. */
export const ROUND_WINDOW = 20

/** Attempts fetched for one expanded stage. */
export const ATTEMPT_PAGE = 100

/** Rows past which a list is virtualised instead of fully rendered. */
export const VIRTUALISE_THRESHOLD = 50

export interface WindowRequest {
  /** Total rounds the work item has. */
  total: number
  /** Zero-based index of the first round to return, newest-first. */
  offset?: number
  limit?: number
}

export interface WindowResult {
  offset: number
  limit: number
  /** True when rounds exist beyond this window. */
  hasMore: boolean
  /** How many are not shown — stated so truncation is never silent. */
  hidden: number
}

/**
 * Which slice of a work item's rounds to load.
 *
 * `hidden` is returned even when zero, so a caller that renders it
 * unconditionally cannot accidentally hide the fact that it truncated. The
 * failure this prevents is a list that looks complete and is not — a reader
 * concluding a merge request had 20 rounds when it had 80.
 */
export function roundWindow(request: WindowRequest): WindowResult {
  const limit = Math.max(1, Math.min(request.limit ?? ROUND_WINDOW, ROUND_WINDOW))
  const offset = Math.max(0, request.offset ?? 0)
  const shown = Math.max(0, Math.min(limit, request.total - offset))
  const hidden = Math.max(0, request.total - offset - shown)
  return { offset, limit, hasMore: hidden > 0, hidden }
}

/** Whether a list of this size should be virtualised. */
export function shouldVirtualise(rowCount: number): boolean {
  return rowCount > VIRTUALISE_THRESHOLD
}

/**
 * The sentence shown when rounds are hidden.
 *
 * Names the number. "Showing recent rounds" is the phrasing that lets a reader
 * believe they are seeing everything; a count cannot be misread that way.
 */
export function describeHidden(hidden: number): string | null {
  if (hidden <= 0) return null
  return hidden === 1
    ? '1 earlier round is not shown.'
    : `${String(hidden)} earlier rounds are not shown.`
}

/**
 * Whether a stage's attempts are worth loading at all.
 *
 * A program stage has none by construction, and asking for them is a round trip
 * whose answer is always empty. Deciding here rather than at the call site
 * keeps the page from having to know which stage kinds can have attempts.
 */
export function stageMayHaveAttempts(stageKind: string): boolean {
  return stageKind === 'ai'
}

// RFC-304 §4.2 / T25b — deciding whether a finding can be attached to a line.
//
// This is the module the design gate split OUT of validation, and the split is
// the whole point:
//
//   "the AI said something WRONG"     → validation failure → retry (R4)
//   "the AI said something ELSEWHERE" → anchoring failure  → NOT retried
//
// A finding whose line is outside this diff's hunks is not malformed. The
// remark may be entirely correct — it just has nowhere to hang. Retrying would
// not improve it (the model would say the same true thing about the same
// unchanged line), and treating it as a validation failure would put a correct
// finding into the same terminal state as garbage. So it is marked `degraded`,
// folded into the overview, and THE STAGE STILL SUCCEEDS (AC-3).
//
// The other half of the rule (AC-4): anchoring is judged against `fetch-diff`'s
// output, NOT against the current worktree. By the time this runs, the worktree
// may have moved on — a hook wrote a file, a fix stage applied a patch — and
// anchoring against it would drift the line numbers of everything the reviewer
// actually looked at.

/** One contiguous changed region, as produced by `fetch-diff`. */
export interface DiffHunk {
  /** Path on the new side; null for a deleted file. */
  newPath: string | null
  /** Path on the old side; null for an added file. */
  oldPath: string | null
  /** First new-side line of the hunk, 1-based; null when the file was deleted. */
  newStart: number | null
  /** How many new-side lines the hunk covers. */
  newLines: number
  /** First old-side line, 1-based; null when the file was added. */
  oldStart: number | null
  oldLines: number
  /**
   * The hunk's body lines, each still carrying its ` `/`+`/`-` marker.
   *
   * Optional because range anchoring (above) does not need them — but placing a
   * comment does. GitLab wants both (path, line) pairs for a CONTEXT line and
   * only one for an added or removed line, and the marker is the only thing
   * that says which a given line is. Without bodies, `resolveAnchoredLine`
   * refuses rather than guessing; guessing "added" for a context line puts the
   * comment on the wrong row every time the hunk has shifted.
   */
  lines?: readonly string[]
}

export interface FindingLocation {
  file: string
  line: number
  /** Which side the finding refers to; defaults to the post-change side. */
  side?: 'new' | 'old'
}

export type AnchorVerdict =
  | { anchored: true; hunk: DiffHunk }
  /**
   * `degraded` is a first-class outcome, not an error: the stage succeeds and
   * the finding rides the overview. `reason` reaches the author, so it says
   * which of the two very different situations this is.
   */
  | { anchored: false; reason: 'file-not-in-diff' | 'line-outside-hunks' }

/**
 * Can this finding be attached to a line of this diff?
 *
 * Pure, and deliberately ignorant of the worktree — see AC-4 above.
 */
export function resolveAnchor(
  location: FindingLocation,
  hunks: readonly DiffHunk[],
): AnchorVerdict {
  const side = location.side ?? 'new'
  const inFile = hunks.filter((h) => (side === 'new' ? h.newPath : h.oldPath) === location.file)
  if (inFile.length === 0) {
    // Distinguished from the next case on purpose: "you commented on a file
    // this MR does not touch" and "you commented on an untouched line of a file
    // it does touch" lead the author to different conclusions about the review.
    return { anchored: false, reason: 'file-not-in-diff' }
  }

  for (const hunk of inFile) {
    const start = side === 'new' ? hunk.newStart : hunk.oldStart
    const count = side === 'new' ? hunk.newLines : hunk.oldLines
    if (start === null) continue
    // Half-open at the end: a hunk starting at 10 with 3 lines covers 10,11,12.
    // Off-by-one here silently drops every finding on a hunk's last line.
    if (location.line >= start && location.line < start + count) {
      return { anchored: true, hunk }
    }
  }
  return { anchored: false, reason: 'line-outside-hunks' }
}

export interface AnchoredFinding<T> {
  finding: T
  verdict: AnchorVerdict
}

/**
 * Partition findings into anchored and degraded.
 *
 * Returns both, never throws, and never drops: a degraded finding still has to
 * reach the overview, and a stage that quietly discarded it would be reporting
 * fewer problems than the review actually found.
 */
export function partitionByAnchor<T>(
  findings: readonly T[],
  locate: (finding: T) => FindingLocation,
  hunks: readonly DiffHunk[],
): { anchored: AnchoredFinding<T>[]; degraded: AnchoredFinding<T>[] } {
  const anchored: AnchoredFinding<T>[] = []
  const degraded: AnchoredFinding<T>[] = []
  for (const finding of findings) {
    const verdict = resolveAnchor(locate(finding), hunks)
    ;(verdict.anchored ? anchored : degraded).push({ finding, verdict })
  }
  return { anchored, degraded }
}

/**
 * A one-line explanation for the overview.
 *
 * Written for the MR author, not for an operator: they need to know the remark
 * is real but unplaceable, so they do not read it as the bot being confused
 * about their code.
 */
export function describeDegradation(location: FindingLocation, verdict: AnchorVerdict): string {
  if (verdict.anchored) return ''
  return verdict.reason === 'file-not-in-diff'
    ? `${location.file} — not changed by this MR, so this could not be placed on a line`
    : `${location.file}:${String(location.line)} — outside this MR's changed lines, so this could not be placed on a line`
}

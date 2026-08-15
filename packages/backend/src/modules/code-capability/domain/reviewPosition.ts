// RFC-304 §7.1 — turning a finding into a line anchor the code host accepts.
//
// Pure, and program-only: there is no judgement here, just each provider's
// required shape. That matters because getting it wrong is invisible until a
// real MR — the API accepts a malformed position and simply drops the comment
// to the MR's overview, which reads to the author as "the bot posted a vague
// remark" rather than "the platform has a bug".
//
// The two providers disagree in a way that is easy to paper over:
//
//   GitLab wants OLD path/line for a deleted line, NEW path/line for an added
//   one, and — for a context line — BOTH, because it cannot otherwise tell
//   which side of the diff you meant.
//   GitHub takes one path plus a `side`, and derives the rest from the review's
//   commit id.
//
// A shared "just send path and line" abstraction would have to pick one of
// those, and would silently mis-anchor every comment of the other kind.

/** Which side of the diff a finding's line lives on. */
export type DiffLineKind = 'added' | 'removed' | 'context'

/** GitLab's `diff_refs`, read from the MR — all three are required. */
export interface GitlabDiffRefs {
  baseSha: string
  startSha: string
  headSha: string
}

/** Where a finding sits, resolved against the diff before this module runs. */
export interface AnchoredLine {
  kind: DiffLineKind
  /** Path on the OLD side; null when the file is newly added. */
  oldPath: string | null
  /** 1-based line on the OLD side; null for an added line. */
  oldLine: number | null
  /** Path on the NEW side; null when the file was deleted. */
  newPath: string | null
  /** 1-based line on the NEW side; null for a removed line. */
  newLine: number | null
}

export type GitlabPosition = {
  position_type: 'text'
  base_sha: string
  start_sha: string
  head_sha: string
  old_path?: string
  old_line?: number
  new_path?: string
  new_line?: number
}

export type GithubPosition = {
  path: string
  line: number
  side: 'LEFT' | 'RIGHT'
  start_line?: number
  start_side?: 'LEFT' | 'RIGHT'
}

export type PositionBuildResult<T> =
  | { ok: true; position: T }
  /**
   * The anchor is unusable for this provider. NOT a validation failure of the
   * AI's output (design §4.2): the remark may be perfectly correct, it just
   * cannot be attached, so the caller folds it into the overview as `degraded`
   * rather than retrying anything.
   */
  | { ok: false; reason: string }

/**
 * GitLab: which pair of (path, line) to send depends on the line's side.
 *
 * A context line needs BOTH pairs. Sending only the new side makes GitLab
 * anchor it as if the line were added, which puts the comment on the wrong row
 * whenever the hunk shifted — and hunks shift constantly.
 */
export function buildGitlabPosition(
  anchor: AnchoredLine,
  refs: GitlabDiffRefs,
): PositionBuildResult<GitlabPosition> {
  const base: GitlabPosition = {
    position_type: 'text',
    base_sha: refs.baseSha,
    start_sha: refs.startSha,
    head_sha: refs.headSha,
  }

  if (anchor.kind === 'added') {
    if (anchor.newPath === null || anchor.newLine === null) {
      return { ok: false, reason: 'an added line needs a new-side path and line' }
    }
    return { ok: true, position: { ...base, new_path: anchor.newPath, new_line: anchor.newLine } }
  }

  if (anchor.kind === 'removed') {
    if (anchor.oldPath === null || anchor.oldLine === null) {
      return { ok: false, reason: 'a removed line needs an old-side path and line' }
    }
    return { ok: true, position: { ...base, old_path: anchor.oldPath, old_line: anchor.oldLine } }
  }

  if (
    anchor.oldPath === null ||
    anchor.oldLine === null ||
    anchor.newPath === null ||
    anchor.newLine === null
  ) {
    return {
      ok: false,
      reason: 'a context line needs BOTH sides; GitLab cannot infer which one was meant',
    }
  }
  return {
    ok: true,
    position: {
      ...base,
      old_path: anchor.oldPath,
      old_line: anchor.oldLine,
      new_path: anchor.newPath,
      new_line: anchor.newLine,
    },
  }
}

/**
 * GitHub: one path, one line, and a side.
 *
 * `RIGHT` is the post-change side and is what an added or context line uses;
 * `LEFT` is the pre-change side, which only a removed line can sit on. The
 * commit id comes from the review request, not from here — which is why a
 * GitHub review is a single request and cannot be half-posted.
 */
export function buildGithubPosition(anchor: AnchoredLine): PositionBuildResult<GithubPosition> {
  if (anchor.kind === 'removed') {
    if (anchor.oldPath === null || anchor.oldLine === null) {
      return { ok: false, reason: 'a removed line needs an old-side path and line' }
    }
    return { ok: true, position: { path: anchor.oldPath, line: anchor.oldLine, side: 'LEFT' } }
  }

  if (anchor.newPath === null || anchor.newLine === null) {
    return {
      ok: false,
      reason: `a ${anchor.kind} line needs a new-side path and line`,
    }
  }
  return { ok: true, position: { path: anchor.newPath, line: anchor.newLine, side: 'RIGHT' } }
}

/**
 * A multi-line range. GitHub expresses it with `start_line`/`start_side`;
 * GitLab has no range form for text positions, so a ranged finding anchors at
 * its END line — the line the remark is actually about — rather than being
 * dropped.
 */
export function withGithubRange(
  position: GithubPosition,
  startLine: number,
  startSide: 'LEFT' | 'RIGHT' = position.side,
): PositionBuildResult<GithubPosition> {
  if (startLine > position.line) {
    return { ok: false, reason: 'a range must start at or before the line it ends on' }
  }
  if (startLine === position.line && startSide === position.side) {
    // A one-line "range" is just a line; sending the redundant fields makes
    // GitHub reject the comment.
    return { ok: true, position }
  }
  return { ok: true, position: { ...position, start_line: startLine, start_side: startSide } }
}

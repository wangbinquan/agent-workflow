// RFC-304 T41/T42 — how a comment-driven fix gets delivered.
//
// Two forms, and the choice between them is the whole point of this module:
//
//   suggestion — the host's native "apply this" button. The reviewer sees the
//                new lines in place, clicks once, done. Costs the platform NO
//                write access to the repository (proposal B/C1) and needs no
//                confirmation round, because applying it is the human's own
//                action.
//   patch      — the change is posted as a diff and waits for a keyword. Slower
//                and noisier, but it is the only form that can express a change
//                the suggestion syntax cannot.
//
// Suggestion is strictly better when it applies, so the interesting question is
// exactly where it stops applying, and that boundary is mechanical rather than
// aesthetic: a host suggestion replaces ONE CONTIGUOUS RANGE OF LINES IN ONE
// FILE. Two files, or one file where the edits sit far apart, cannot be one
// suggestion — not "should not", cannot.
//
// ## Why a span rather than a hunk count
//
// A file can be touched by three separate hunks and still be one suggestion: the
// range simply spans from the first changed line to the last, carrying the
// untouched lines between them through unchanged. So the test is the SPAN, not
// the number of hunks. Counting hunks would push a three-line-apart pair of
// edits onto the patch path for no reason, and the patch path costs a human
// round-trip every time.
//
// ## Why there is an upper bound on the span at all
//
// Because a suggestion is applied by a person looking at it in the diff view. A
// forty-line suggestion is not reviewed, it is accepted — the reader cannot hold
// the before and after in their head, and the one-click apply that makes the
// form good is exactly what makes an unreviewable one dangerous. Past the
// threshold the patch path is the honest shape: it shows the whole diff and asks
// for an explicit confirmation.

import { parsePatch } from 'diff'
import { normalizeDiffHeaderPath } from '@/modules/code-capability/domain/diffHunks'

/** A single contiguous replacement in one file — what a suggestion can express. */
export interface ChangeSpan {
  /** New-side path. */
  path: string
  /** First line of the replaced range, 1-based, on the ORIGINAL file. */
  startLine: number
  /** Last line of the replaced range, inclusive. */
  endLine: number
  /** The lines that replace the range, without trailing newlines. */
  replacement: string[]
}

export interface SuggestionOptions {
  /**
   * The widest range a suggestion may cover, counted on the original file.
   *
   * 20 by default: wide enough for a rewritten function body or a block of
   * imports, narrow enough that the reader can still check it against what it
   * replaces. Both hosts also impose their own caps, so this is the product's
   * limit, not the protocol's.
   */
  maxSpanLines: number
}

export const DEFAULT_SUGGESTION_OPTIONS: SuggestionOptions = { maxSpanLines: 20 }

export type DeliveryForm =
  | { kind: 'suggestion'; span: ChangeSpan }
  /** `reason` is shown to the author, so it says what the machine actually saw. */
  | { kind: 'patch'; reason: string }

/**
 * Read a one-file diff as a single contiguous replacement.
 *
 * Returns null when the diff cannot be one — several files, no changes at all,
 * or a file the parser could not read. The caller turns null into the patch
 * path; this function deliberately does not decide that, so the reason the
 * author sees can name the specific cause.
 */
export function changeSpanOf(unifiedDiff: string): ChangeSpan | null {
  if (unifiedDiff.trim() === '') return null

  let files: ReturnType<typeof parsePatch>
  try {
    files = parsePatch(unifiedDiff)
  } catch {
    return null
  }
  if (files.length !== 1) return null

  const file = files[0]!
  const path =
    normalizeDiffHeaderPath(file.newFileName) ?? normalizeDiffHeaderPath(file.oldFileName)
  if (path === null) return null
  if (file.hunks.length === 0) return null

  // Walk every hunk in order, tracking two things: the content that replaces
  // the span, and how far the span must reach. `lastChange*` is the crux — the
  // span ENDS at the last line a hunk actually changed, not at the end of its
  // trailing context, and the replacement is truncated to match.
  let startLine: number | null = null
  const replacement: string[] = []
  /** Old line the last change touched; the span's true end. */
  let lastChangeOldLine = 0
  /** Length of `replacement` right after that change; everything later is context. */
  let lastChangeLen = 0
  /** Where the previous hunk stopped, for the gap check below. */
  let previousHunkEnd: number | null = null

  for (const hunk of file.hunks) {
    // A single suggestion replaces a CONTIGUOUS range, so every line in the
    // range must be present to be re-emitted. Separated hunks do not carry the
    // lines between them — applying a suggestion built from them would delete
    // those lines silently, with the reviewer's own click. Refusing here sends
    // the change down the patch path instead, which is the honest outcome.
    if (startLine !== null && previousHunkEnd !== null && hunk.oldStart > previousHunkEnd + 1) {
      return null
    }
    previousHunkEnd = hunk.oldStart + hunk.oldLines - 1

    let oldLine = hunk.oldStart
    for (const raw of hunk.lines) {
      // `\ No newline at end of file` annotates the previous line rather than
      // being one. Carried through, it appends a literal backslash to the file.
      if (raw.startsWith('\\')) continue
      const marker = raw[0] ?? ' '
      const text = raw.slice(1)

      if (marker === '-') {
        if (startLine === null) startLine = oldLine
        lastChangeOldLine = oldLine
        lastChangeLen = replacement.length
        oldLine += 1
        continue
      }

      if (marker === '+') {
        if (startLine === null) {
          // A pure insertion sits BETWEEN two old lines, and the suggestion
          // syntax has no way to say "insert without replacing". So it replaces
          // the line it follows, which must then be re-emitted ahead of the new
          // content or applying the suggestion deletes it.
          startLine = Math.max(1, oldLine - 1)
          lastChangeOldLine = startLine
          const anchor = precedingContext(file.hunks, startLine)
          if (anchor !== null) replacement.push(anchor)
        }
        replacement.push(text)
        lastChangeLen = replacement.length
        continue
      }

      // Context. Carried only once the span has opened; leading context is
      // outside the replaced range.
      if (startLine !== null) replacement.push(text)
      oldLine += 1
    }
  }

  if (startLine === null) return null

  return {
    path,
    startLine,
    endLine: lastChangeOldLine,
    replacement: replacement.slice(0, lastChangeLen),
  }
}

/** The old-side content of `line`, when a hunk carries it as context. */
function precedingContext(
  hunks: ReturnType<typeof parsePatch>[number]['hunks'],
  line: number,
): string | null {
  for (const hunk of hunks) {
    let oldLine = hunk.oldStart
    for (const raw of hunk.lines) {
      if (raw.startsWith('\\')) continue
      const marker = raw[0] ?? ' '
      if (marker === '+') continue
      if (oldLine === line) return raw.slice(1)
      oldLine += 1
    }
  }
  return null
}

/**
 * Which form this change should take.
 *
 * Every `patch` verdict carries the reason, because "why did it not just give
 * me a button?" is the first thing a reviewer asks, and an unexplained slower
 * path reads as the platform being broken.
 */
export function decideForm(
  unifiedDiff: string,
  options: SuggestionOptions = DEFAULT_SUGGESTION_OPTIONS,
): DeliveryForm {
  const span = changeSpanOf(unifiedDiff)
  if (span === null) {
    return {
      kind: 'patch',
      reason: 'the change touches more than one file, so it cannot be a single suggestion',
    }
  }

  const width = span.endLine - span.startLine + 1
  if (width > options.maxSpanLines) {
    return {
      kind: 'patch',
      reason: `the change spans ${String(width)} lines of ${span.path}, past the ${String(options.maxSpanLines)}-line limit for a one-click suggestion`,
    }
  }

  return { kind: 'suggestion', span }
}

/**
 * The comment body carrying a suggestion, in the host's own syntax.
 *
 * The two hosts express the RANGE differently and that difference is not
 * cosmetic:
 *
 *   GitLab addresses it relatively — ```` ```suggestion:-a+b ```` means "a lines
 *   above and b lines below the line this comment is on". So the comment must be
 *   anchored somewhere inside the range and the offsets computed from there.
 *   GitHub addresses it absolutely — a plain ```` ```suggestion ```` block, with
 *   the range carried by the COMMENT's `start_line`/`line`, not by the body.
 *
 * Writing GitLab's header into a GitHub body (or omitting it on GitLab) does not
 * error: the host renders a suggestion that replaces the wrong number of lines.
 * That is the failure this function exists to prevent, and why the anchor line
 * is returned alongside rather than left to the caller.
 */
export interface RenderedSuggestion {
  body: string
  /** The line the comment attaches to; GitLab's offsets are relative to it. */
  anchorLine: number
  /** GitHub only: the first line of a multi-line comment range. */
  startLine: number | null
}

export function renderSuggestion(
  provider: 'gitlab' | 'github',
  span: ChangeSpan,
  note?: string,
): RenderedSuggestion {
  const content = span.replacement.join('\n')
  const preamble = note === undefined || note.trim() === '' ? '' : `${note.trim()}\n\n`

  if (provider === 'gitlab') {
    // Anchored at the START of the range so `-0` is always correct; the only
    // offset that varies is how far below it reaches.
    const below = span.endLine - span.startLine
    return {
      body: `${preamble}\`\`\`suggestion:-0+${String(below)}\n${content}\n\`\`\``,
      anchorLine: span.startLine,
      startLine: null,
    }
  }

  return {
    body: `${preamble}\`\`\`suggestion\n${content}\n\`\`\``,
    anchorLine: span.endLine,
    // A single-line range must NOT carry `start_line`: GitHub rejects a
    // multi-line comment whose start equals its end.
    startLine: span.startLine === span.endLine ? null : span.startLine,
  }
}

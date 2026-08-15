// RFC-304 §6.1 — `resolve-positions`, part one: from "line 12 of src/a.ts" to
// the fully-sided anchor a host API can address.
//
// `resolveAnchor` answers whether a finding falls inside the diff. That is not
// enough to place a comment. Both hosts need to know which SIDE the line lives
// on, and GitLab additionally needs both (path, line) pairs when the line is
// context rather than added or removed. The only record of which a line is sits
// in the hunk body's leading marker, so this module walks it.
//
// Walking is not optional and the fallback is not a guess. Treating an
// unmarked line as added puts the comment on the wrong row whenever the hunk
// shifted — and hunks shift on every rebase — so a hunk that arrived without
// bodies produces `null` here and the finding degrades into the overview
// instead. A comment on the wrong line is worse than a comment in a list: the
// first is confidently wrong about code the author is looking at.

import type { AnchoredLine, DiffLineKind } from '@/modules/code-capability/domain/reviewPosition'
import type { DiffHunk, FindingLocation } from '@/modules/code-capability/domain/anchorResolve'

interface WalkedLine {
  kind: DiffLineKind
  oldLine: number | null
  newLine: number | null
}

/**
 * Expand a hunk body into its per-line old/new coordinates.
 *
 * Exported for its own tests: an off-by-one in this loop shifts every comment
 * on the file by one row, which is the kind of wrongness that looks like a
 * sloppy reviewer rather than a broken tool.
 */
export function walkHunkLines(hunk: DiffHunk): WalkedLine[] {
  if (hunk.lines === undefined) return []

  let oldLine = hunk.oldStart
  let newLine = hunk.newStart
  const out: WalkedLine[] = []

  for (const raw of hunk.lines) {
    const marker = raw.charAt(0)
    // `\ No newline at end of file` annotates the PREVIOUS line and occupies no
    // line of its own; counting it shifts everything after it by one.
    if (marker === '\\') continue

    if (marker === '-') {
      out.push({ kind: 'removed', oldLine, newLine: null })
      if (oldLine !== null) oldLine += 1
    } else if (marker === '+') {
      out.push({ kind: 'added', oldLine: null, newLine })
      if (newLine !== null) newLine += 1
    } else {
      // Everything else is context, including the empty string that a
      // zero-length context line becomes once its single leading space is
      // trimmed by an intermediate tool.
      out.push({ kind: 'context', oldLine, newLine })
      if (oldLine !== null) oldLine += 1
      if (newLine !== null) newLine += 1
    }
  }
  return out
}

/** Find the hunk a location falls inside, or null. */
function hunkContaining(
  location: FindingLocation,
  hunks: readonly DiffHunk[],
): { hunk: DiffHunk; walked: WalkedLine } | null {
  const side = location.side ?? 'new'

  for (const hunk of hunks) {
    const path = side === 'new' ? hunk.newPath : hunk.oldPath
    if (path !== location.file) continue

    for (const walked of walkHunkLines(hunk)) {
      const at = side === 'new' ? walked.newLine : walked.oldLine
      if (at === location.line) return { hunk, walked }
    }
  }
  return null
}

/**
 * The content of the hunk a finding sits in, as a stable string.
 *
 * This is what `fingerprintFor` hashes to decide whether a finding seen again
 * is the SAME finding. It has to be the hunk's TEXT, and specifically not its
 * line numbers: a rebase shifts every number while changing no code, and a
 * fingerprint that moved with them would republish the entire previous review
 * as new findings on every push.
 *
 * The complement matters equally — when the surrounding code is genuinely
 * rewritten, this changes, and the finding is allowed to be raised afresh
 * rather than suppressed as a repeat of a remark about code that no longer
 * exists.
 *
 * Returns '' when the location does not resolve; the caller is expected to have
 * degraded such a finding already, and '' keeps the identity stable for the
 * unanchored ones rather than throwing.
 */
export function hunkDigestFor(location: FindingLocation, hunks: readonly DiffHunk[]): string {
  const found = hunkContaining(location, hunks)
  if (found === null) return ''
  const lines = found.hunk.lines
  if (lines === undefined) return ''
  // Markers included: a line changing from context to added IS a code change,
  // and dropping the markers would hide exactly that.
  return lines.join('\n')
}

/**
 * Resolve a finding's location into a placeable anchor.
 *
 * Returns null when the line cannot be placed — no hunk covers it, or the hunk
 * arrived without bodies. The caller degrades the finding into the overview;
 * this function never invents a side.
 */
export function resolveAnchoredLine(
  location: FindingLocation,
  hunks: readonly DiffHunk[],
): AnchoredLine | null {
  const found = hunkContaining(location, hunks)
  if (found === null) return null
  return {
    kind: found.walked.kind,
    oldPath: found.hunk.oldPath,
    oldLine: found.walked.oldLine,
    newPath: found.hunk.newPath,
    newLine: found.walked.newLine,
  }
}

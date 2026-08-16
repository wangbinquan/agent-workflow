// RFC-304 — turning `fetch-diff`'s unified diff into the hunks anchoring needs.
//
// Parsing is delegated to the `diff` package (already a dependency — the skill
// version viewer generates patches with its `structuredPatch`). A hand-written
// unified-diff parser is a classic source of quiet wrongness: renames, binary
// files, `\ No newline at end of file`, `@@ -1 +1 @@` without counts, and
// multi-file headers each have their own edge, and getting one wrong shifts
// line numbers for a whole file — which here means every remark on that file
// lands somewhere else.
//
// So this module is deliberately thin: it normalizes the library's output into
// the shape `resolveAnchor` consumes, and applies the two repo conventions the
// library has no opinion about (strip the a// b/ prefixes, treat /dev/null as
// "this side does not exist").

import { parsePatch } from 'diff'
import type { DiffHunk } from '@/modules/code-capability/domain/anchorResolve'

/**
 * `a/src/x.ts` → `src/x.ts`; `/dev/null` → null (the side does not exist).
 *
 * Exported because more than one reader of a diff header needs it and the
 * prefix rule below is subtle enough that a second copy would eventually get it
 * wrong. `mrDiffNormalize` writes these headers; this reads them.
 */
export function normalizeDiffHeaderPath(raw: string | undefined): string | null {
  if (raw === undefined || raw === '') return null
  if (raw === '/dev/null') return null
  // Only the FIRST segment is a prefix. A file genuinely named `a/b/c.ts`
  // becomes `a/a/b/c.ts` in the header, and stripping greedily would lose a
  // directory level for every path that happens to start with `a/` or `b/`.
  return raw.replace(/^[ab]\//, '')
}

/**
 * Parse a unified diff into hunks.
 *
 * Returns an empty array for an empty or unparsable diff rather than throwing:
 * a round can legitimately reach here with no changes (an MR whose commits
 * cancel out), and that has to produce an all-degraded review rather than a
 * failed stage.
 */
export function parseDiffHunks(unifiedDiff: string): DiffHunk[] {
  if (unifiedDiff.trim() === '') return []

  let files: ReturnType<typeof parsePatch>
  try {
    files = parsePatch(unifiedDiff)
  } catch {
    return []
  }

  const out: DiffHunk[] = []
  for (const file of files) {
    const oldPath = normalizeDiffHeaderPath(file.oldFileName)
    const newPath = normalizeDiffHeaderPath(file.newFileName)
    for (const hunk of file.hunks) {
      out.push({
        oldPath,
        newPath,
        // A pure-addition hunk reports `oldLines: 0`; its `oldStart` then points
        // at the line it was inserted after, which is NOT a line of the old
        // file. Null-ing it keeps `resolveAnchor` from anchoring an old-side
        // finding onto a line that does not exist there.
        oldStart: hunk.oldLines > 0 ? hunk.oldStart : null,
        oldLines: hunk.oldLines,
        newStart: hunk.newLines > 0 ? hunk.newStart : null,
        newLines: hunk.newLines,
        // Carried through so a comment can be PLACED, not merely anchored: the
        // per-line markers are the only record of which lines are context, and
        // GitLab needs that to address a context line correctly.
        lines: hunk.lines,
      })
    }
  }
  return out
}

/**
 * The set of paths this diff touches, new side preferred.
 *
 * Used by the review prompt so the model is told what it may comment on — a
 * cheap way to reduce (not eliminate) findings that would only be degraded.
 */
export function changedPaths(hunks: readonly DiffHunk[]): string[] {
  const paths = new Set<string>()
  for (const hunk of hunks) {
    const path = hunk.newPath ?? hunk.oldPath
    if (path !== null) paths.add(path)
  }
  return [...paths].sort()
}

// RFC-304 §6.1 — turning a finding's line number into a placeable anchor.
//
// An off-by-one in the hunk walk shifts every comment on the file by one row.
// That failure does not look like a broken tool; it looks like a reviewer who
// cannot read, which is worse, because people argue with it before they suspect
// it. So the walk is tested line by line against a hunk containing all three
// line kinds.
//
// The other half is the refusal: a hunk with no body cannot say whether a line
// is context, and GitLab addresses a context line differently from an added
// one. Guessing there puts the comment on the wrong row every time the hunk has
// shifted, so this module returns null and lets the finding degrade instead.

import { describe, expect, test } from 'bun:test'
import {
  hunkDigestFor,
  resolveAnchoredLine,
  walkHunkLines,
} from '../src/modules/code-capability/domain/anchorLine'
import { parseDiffHunks } from '../src/modules/code-capability/domain/diffHunks'
import { buildGitlabPosition } from '../src/modules/code-capability/domain/reviewPosition'

// Old lines 10,11,12 → new lines 10,11,12,13.
//   10/10 context, 11/-- removed, --/11 added, --/12 added, 12/13 context
const DIFF = `--- a/src/a.ts
+++ b/src/a.ts
@@ -10,3 +10,4 @@
 first context
-removed line
+added one
+added two
 last context
`

const hunks = () => parseDiffHunks(DIFF)

describe('RFC-304 — walking a hunk body', () => {
  test('each line kind lands on the right pair of coordinates', () => {
    const [hunk] = hunks()
    expect(walkHunkLines(hunk!)).toEqual([
      { kind: 'context', oldLine: 10, newLine: 10 },
      { kind: 'removed', oldLine: 11, newLine: null },
      { kind: 'added', oldLine: null, newLine: 11 },
      { kind: 'added', oldLine: null, newLine: 12 },
      { kind: 'context', oldLine: 12, newLine: 13 },
    ])
  })

  test('a removed line advances only the old side', () => {
    const walked = walkHunkLines(hunks()[0]!)
    expect(walked[1]?.newLine).toBeNull()
    expect(walked[2]?.newLine).toBe(11)
  })

  test('the no-newline marker occupies no line', () => {
    // `\ No newline at end of file` annotates the line before it. Counting it
    // shifts every coordinate after it by one.
    const diff = `--- a/src/a.ts
+++ b/src/a.ts
@@ -1,2 +1,2 @@
 one
-two
\\ No newline at end of file
+three
`
    const walked = walkHunkLines(parseDiffHunks(diff)[0]!)
    expect(walked.map((w) => w.kind)).toEqual(['context', 'removed', 'added'])
    expect(walked[2]?.newLine).toBe(2)
  })

  test('a hunk with no body walks to nothing rather than throwing', () => {
    expect(
      walkHunkLines({
        newPath: 'a.ts',
        oldPath: 'a.ts',
        newStart: 1,
        newLines: 1,
        oldStart: 1,
        oldLines: 1,
      }),
    ).toEqual([])
  })
})

describe('RFC-304 — resolving a finding to an anchor', () => {
  test('an added line resolves with only a new side', () => {
    const anchor = resolveAnchoredLine({ file: 'src/a.ts', line: 11 }, hunks())
    expect(anchor).toMatchObject({ kind: 'added', oldLine: null, newLine: 11 })
  })

  test('a context line resolves with BOTH sides', () => {
    // The case GitLab needs both pairs for. Reporting only the new side makes
    // it anchor as if the line were added, which is wrong whenever the hunk has
    // shifted — and hunks shift on every rebase.
    const anchor = resolveAnchoredLine({ file: 'src/a.ts', line: 13 }, hunks())
    expect(anchor).toMatchObject({ kind: 'context', oldLine: 12, newLine: 13 })
  })

  test('an old-side finding resolves against old coordinates', () => {
    const anchor = resolveAnchoredLine({ file: 'src/a.ts', line: 11, side: 'old' }, hunks())
    expect(anchor).toMatchObject({ kind: 'removed', oldLine: 11, newLine: null })
  })

  test('a line outside the hunk resolves to null, not to the nearest line', () => {
    // Snapping to the nearest line is the tempting fix and produces a confident
    // comment on code the reviewer never mentioned.
    expect(resolveAnchoredLine({ file: 'src/a.ts', line: 99 }, hunks())).toBeNull()
  })

  test('a file outside the diff resolves to null', () => {
    expect(resolveAnchoredLine({ file: 'src/other.ts', line: 11 }, hunks())).toBeNull()
  })

  test('a hunk with no bodies refuses rather than guessing a side', () => {
    // The refusal that matters: without markers there is no way to know whether
    // line 11 is context or added, and the two are addressed differently.
    const bodiless = [
      {
        newPath: 'src/a.ts',
        oldPath: 'src/a.ts',
        newStart: 10,
        newLines: 4,
        oldStart: 10,
        oldLines: 3,
      },
    ]
    expect(resolveAnchoredLine({ file: 'src/a.ts', line: 11 }, bodiless)).toBeNull()
  })
})

describe('RFC-304 — the hunk digest a fingerprint is built from', () => {
  test('two lines of the same hunk share a digest', () => {
    // The digest identifies the HUNK, not the line — that is what lets a
    // finding keep its identity when a rebase shifts it.
    expect(hunkDigestFor({ file: 'src/a.ts', line: 11 }, hunks())).toBe(
      hunkDigestFor({ file: 'src/a.ts', line: 13 }, hunks()),
    )
  })

  test('the digest is the hunk’s text, so it survives renumbering', () => {
    // Same content, hunk moved from line 10 to line 400. A digest built from
    // coordinates would change here, and the next round would republish the
    // entire previous review as brand-new findings.
    const moved = parseDiffHunks(DIFF.replace('@@ -10,3 +10,4 @@', '@@ -400,3 +400,4 @@'))
    expect(hunkDigestFor({ file: 'src/a.ts', line: 401 }, moved)).toBe(
      hunkDigestFor({ file: 'src/a.ts', line: 11 }, hunks()),
    )
  })

  test('rewritten code in the hunk changes the digest', () => {
    // The complement: when the surrounding code genuinely changed, the finding
    // is allowed to be raised afresh rather than suppressed as a repeat of a
    // remark about code that no longer exists.
    const edited = parseDiffHunks(DIFF.replace('+added one', '+something else entirely'))
    expect(hunkDigestFor({ file: 'src/a.ts', line: 11 }, edited)).not.toBe(
      hunkDigestFor({ file: 'src/a.ts', line: 11 }, hunks()),
    )
  })

  test('a line changing from context to added changes the digest', () => {
    // Markers are part of the text on purpose: that transition IS a code
    // change, and dropping the markers would hide exactly it.
    const edited = parseDiffHunks(DIFF.replace(' last context', '+last context'))
    expect(hunkDigestFor({ file: 'src/a.ts', line: 11 }, edited)).not.toBe(
      hunkDigestFor({ file: 'src/a.ts', line: 11 }, hunks()),
    )
  })

  test('an unresolvable location digests to empty rather than throwing', () => {
    expect(hunkDigestFor({ file: 'src/a.ts', line: 900 }, hunks())).toBe('')
    expect(hunkDigestFor({ file: 'nope.ts', line: 1 }, hunks())).toBe('')
  })
})

describe('RFC-304 — the anchor feeds the position builder', () => {
  const refs = { baseSha: 'base', startSha: 'start', headSha: 'head' }

  test('an added line produces a new-side-only GitLab position', () => {
    const anchor = resolveAnchoredLine({ file: 'src/a.ts', line: 11 }, hunks())
    const built = buildGitlabPosition(anchor!, refs)
    expect(built.ok && built.position).toMatchObject({ new_path: 'src/a.ts', new_line: 11 })
    expect(built.ok && 'old_line' in built.position).toBe(false)
  })

  test('a context line produces a GitLab position carrying both sides', () => {
    const anchor = resolveAnchoredLine({ file: 'src/a.ts', line: 13 }, hunks())
    const built = buildGitlabPosition(anchor!, refs)
    expect(built.ok && built.position).toMatchObject({
      old_path: 'src/a.ts',
      old_line: 12,
      new_path: 'src/a.ts',
      new_line: 13,
    })
  })
})

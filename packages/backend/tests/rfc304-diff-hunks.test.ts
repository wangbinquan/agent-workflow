// RFC-304 — parsing `fetch-diff` output into anchorable hunks.
//
// The parsing itself is the `diff` package's job (already a dependency). What
// is tested here is the thin layer on top, because that is where the repo's own
// conventions live and where a mistake shifts line numbers for a whole file —
// which means every remark on that file lands somewhere else, silently.
//
// The cases that matter are the ones a hand-rolled parser gets wrong: added and
// deleted files (one side is `/dev/null`), pure-addition hunks (`oldLines: 0`,
// whose `oldStart` is NOT a line of the old file), renames, and paths that
// themselves start with `a/`.

import { describe, expect, test } from 'bun:test'
import { changedPaths, parseDiffHunks } from '../src/modules/code-capability/domain/diffHunks'
import { resolveAnchor } from '../src/modules/code-capability/domain/anchorResolve'

const DIFF_MODIFY = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -10,3 +10,4 @@
 context
-removed
+added
+also added
 context2
`

describe('RFC-304 — hunk parsing basics', () => {
  test('a modification yields both sides with their own coordinates', () => {
    const [hunk] = parseDiffHunks(DIFF_MODIFY)
    expect(hunk).toMatchObject({
      oldPath: 'src/a.ts',
      newPath: 'src/a.ts',
      oldStart: 10,
      oldLines: 3,
      newStart: 10,
      newLines: 4,
    })
  })

  test('the a/ and b/ prefixes are stripped, and only the first segment', () => {
    // A file genuinely named `a/b/c.ts` appears as `a/a/b/c.ts` in the header.
    // Greedy stripping would lose a directory level for every path starting
    // with `a/` or `b/` — and then nothing on those files would ever anchor.
    const diff = `diff --git a/a/b/c.ts b/a/b/c.ts
--- a/a/b/c.ts
+++ b/a/b/c.ts
@@ -1,1 +1,2 @@
 x
+y
`
    const [hunk] = parseDiffHunks(diff)
    expect(hunk?.newPath).toBe('a/b/c.ts')
  })

  test('multiple files each contribute their hunks', () => {
    const diff = `${DIFF_MODIFY}diff --git a/src/b.ts b/src/b.ts
--- a/src/b.ts
+++ b/src/b.ts
@@ -1,1 +1,2 @@
 x
+y
`
    const hunks = parseDiffHunks(diff)
    expect(hunks).toHaveLength(2)
    expect(changedPaths(hunks)).toEqual(['src/a.ts', 'src/b.ts'])
  })

  test('multiple hunks in one file are all kept', () => {
    const diff = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -10,1 +10,2 @@
 x
+y
@@ -50,1 +51,2 @@
 p
+q
`
    const hunks = parseDiffHunks(diff)
    expect(hunks.map((h) => h.newStart)).toEqual([10, 51])
  })
})

describe('RFC-304 — the sides a file may not have', () => {
  test('an added file has no old side', () => {
    const diff = `diff --git a/src/new.ts b/src/new.ts
new file mode 100644
--- /dev/null
+++ b/src/new.ts
@@ -0,0 +1,2 @@
+line one
+line two
`
    const [hunk] = parseDiffHunks(diff)
    expect(hunk?.oldPath).toBeNull()
    expect(hunk?.newPath).toBe('src/new.ts')
    // `oldStart` on a pure addition points at the line it was inserted AFTER,
    // which is not a line of the old file. Leaving it set would let an old-side
    // finding anchor onto a line that does not exist there.
    expect(hunk?.oldStart).toBeNull()
    expect(resolveAnchor({ file: 'src/new.ts', line: 1 }, [hunk!]).anchored).toBe(true)
  })

  test('a deleted file has no new side', () => {
    const diff = `diff --git a/src/gone.ts b/src/gone.ts
deleted file mode 100644
--- a/src/gone.ts
+++ /dev/null
@@ -1,2 +0,0 @@
-line one
-line two
`
    const [hunk] = parseDiffHunks(diff)
    expect(hunk?.newPath).toBeNull()
    expect(hunk?.newStart).toBeNull()
    expect(resolveAnchor({ file: 'src/gone.ts', line: 1, side: 'old' }, [hunk!]).anchored).toBe(
      true,
    )
  })

  test('a rename keeps each side its own path', () => {
    const diff = `diff --git a/src/old.ts b/src/new.ts
--- a/src/old.ts
+++ b/src/new.ts
@@ -1,1 +1,2 @@
 x
+y
`
    const [hunk] = parseDiffHunks(diff)
    expect(hunk?.oldPath).toBe('src/old.ts')
    expect(hunk?.newPath).toBe('src/new.ts')
  })
})

describe('RFC-304 — degenerate input never fails the stage', () => {
  test('an empty diff yields no hunks', () => {
    // A legitimate round: an MR whose commits cancel out. It must produce an
    // all-degraded review, not a failed stage.
    expect(parseDiffHunks('')).toEqual([])
    expect(parseDiffHunks('   \n  ')).toEqual([])
  })

  test('unparsable input yields no hunks rather than throwing', () => {
    expect(parseDiffHunks('this is not a diff at all')).toEqual([])
  })

  test('a binary file contributes no hunks', () => {
    const diff = `diff --git a/img.png b/img.png
Binary files a/img.png and b/img.png differ
`
    expect(parseDiffHunks(diff)).toEqual([])
  })

  test('changedPaths on an empty diff is empty, not [null]', () => {
    expect(changedPaths([])).toEqual([])
  })
})

describe('RFC-304 — the parsed hunks feed anchoring end to end', () => {
  test('a finding on a changed line anchors; one just past it degrades', () => {
    const hunks = parseDiffHunks(DIFF_MODIFY)
    // The hunk covers new lines 10..13.
    expect(resolveAnchor({ file: 'src/a.ts', line: 13 }, hunks).anchored).toBe(true)
    const past = resolveAnchor({ file: 'src/a.ts', line: 14 }, hunks)
    expect(past.anchored).toBe(false)
    expect(!past.anchored && past.reason).toBe('line-outside-hunks')
  })

  test('a finding on an untouched file degrades with the other reason', () => {
    const hunks = parseDiffHunks(DIFF_MODIFY)
    const v = resolveAnchor({ file: 'src/untouched.ts', line: 1 }, hunks)
    expect(!v.anchored && v.reason).toBe('file-not-in-diff')
  })
})

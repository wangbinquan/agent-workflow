// RFC-304 §4.2 / T25b — anchoring is not validation.
//
// The design gate that produced this split found the first draft putting both
// under "validate-findings", which made one finding land in two mutually
// exclusive terminal states: AC-3 says an unanchorable finding is degraded,
// folded into the overview, and the stage SUCCEEDS; R4 says a validation
// failure retries until the stage FAILS. Both cannot be true of the same thing.
//
// The dividing line, stated as the tests below check it:
//
//   the AI said something WRONG     → it can fix that → retry
//   the AI said something ELSEWHERE → retrying produces the same true remark
//                                     about the same unchanged line → degrade
//
// AC-4 is the other half: anchoring is judged against `fetch-diff`'s output,
// never against the current worktree — which by then may have been written by a
// hook or a fix stage, drifting every line the reviewer actually looked at.

import { describe, expect, test } from 'bun:test'
import {
  describeDegradation,
  partitionByAnchor,
  resolveAnchor,
  type DiffHunk,
} from '../src/modules/code-capability/domain/anchorResolve'

const hunk = (over: Partial<DiffHunk> = {}): DiffHunk => ({
  newPath: 'src/a.ts',
  oldPath: 'src/a.ts',
  newStart: 10,
  newLines: 3,
  oldStart: 10,
  oldLines: 3,
  ...over,
})

describe('RFC-304 T25b — a line inside a hunk anchors', () => {
  test('the first, middle and LAST line of a hunk all anchor', () => {
    // The last line is the off-by-one that silently drops findings: a hunk
    // starting at 10 with 3 lines covers 10, 11 and 12.
    for (const line of [10, 11, 12]) {
      expect(resolveAnchor({ file: 'src/a.ts', line }, [hunk()]).anchored).toBe(true)
    }
  })

  test('the line just past the hunk does NOT anchor', () => {
    const v = resolveAnchor({ file: 'src/a.ts', line: 13 }, [hunk()])
    expect(v.anchored).toBe(false)
    expect(!v.anchored && v.reason).toBe('line-outside-hunks')
  })

  test('a file with several hunks anchors in any of them', () => {
    const hunks = [hunk({ newStart: 10, newLines: 2 }), hunk({ newStart: 50, newLines: 4 })]
    expect(resolveAnchor({ file: 'src/a.ts', line: 52 }, hunks).anchored).toBe(true)
    // …and not in the gap between them.
    expect(resolveAnchor({ file: 'src/a.ts', line: 30 }, hunks).anchored).toBe(false)
  })

  test('the old side is matched against old-side coordinates', () => {
    // A finding about a deleted line lives in a different coordinate space; the
    // new-side numbers would place it somewhere unrelated.
    const h = hunk({ oldStart: 100, oldLines: 2, newStart: 10, newLines: 1 })
    expect(resolveAnchor({ file: 'src/a.ts', line: 101, side: 'old' }, [h]).anchored).toBe(true)
    expect(resolveAnchor({ file: 'src/a.ts', line: 101, side: 'new' }, [h]).anchored).toBe(false)
  })

  test('a deleted file has no new side to anchor on', () => {
    const deleted = hunk({ newPath: null, newStart: null, newLines: 0 })
    expect(resolveAnchor({ file: 'src/a.ts', line: 10 }, [deleted]).anchored).toBe(false)
  })
})

describe('RFC-304 T25b — the two degradation reasons are distinct', () => {
  test('a file the MR never touched', () => {
    // "You commented on a file this MR does not change" and "you commented on
    // an untouched line of a file it does change" lead the author to different
    // conclusions about whether the review understood their change.
    const v = resolveAnchor({ file: 'src/other.ts', line: 10 }, [hunk()])
    expect(!v.anchored && v.reason).toBe('file-not-in-diff')
  })

  test('a touched file, an untouched line', () => {
    const v = resolveAnchor({ file: 'src/a.ts', line: 999 }, [hunk()])
    expect(!v.anchored && v.reason).toBe('line-outside-hunks')
  })

  test('the overview text distinguishes them for the author', () => {
    const notInDiff = describeDegradation(
      { file: 'src/other.ts', line: 1 },
      {
        anchored: false,
        reason: 'file-not-in-diff',
      },
    )
    const outsideHunks = describeDegradation(
      { file: 'src/a.ts', line: 999 },
      {
        anchored: false,
        reason: 'line-outside-hunks',
      },
    )
    expect(notInDiff).toContain('not changed by this MR')
    expect(outsideHunks).toContain("outside this MR's changed lines")
    // The line number matters in the second case and is meaningless in the
    // first — the author can go look at 999, but not at "somewhere in a file
    // you did not touch".
    expect(outsideHunks).toContain('999')
  })

  test('an empty diff degrades everything, without throwing', () => {
    // A round can legitimately reach here with no hunks (an MR whose only
    // change was reverted, say). Throwing would fail a stage that should
    // succeed with an all-degraded overview.
    const v = resolveAnchor({ file: 'src/a.ts', line: 1 }, [])
    expect(!v.anchored && v.reason).toBe('file-not-in-diff')
  })
})

describe('RFC-304 AC-3 — partitioning keeps every finding', () => {
  type F = { id: string; file: string; line: number }
  const locate = (f: F) => ({ file: f.file, line: f.line })

  test('anchored and degraded are both returned, and nothing is dropped', () => {
    // A stage that discarded the degraded ones would report fewer problems than
    // the review actually found — silently.
    const findings: F[] = [
      { id: 'in', file: 'src/a.ts', line: 11 },
      { id: 'far', file: 'src/a.ts', line: 900 },
      { id: 'elsewhere', file: 'src/z.ts', line: 1 },
    ]
    const { anchored, degraded } = partitionByAnchor(findings, locate, [hunk()])
    expect(anchored.map((a) => a.finding.id)).toEqual(['in'])
    expect(degraded.map((d) => d.finding.id)).toEqual(['far', 'elsewhere'])
    expect(anchored.length + degraded.length).toBe(findings.length)
  })

  test('every finding anchoring is still a valid outcome', () => {
    const { anchored, degraded } = partitionByAnchor(
      [{ id: 'a', file: 'src/a.ts', line: 10 }],
      locate,
      [hunk()],
    )
    expect(anchored).toHaveLength(1)
    expect(degraded).toEqual([])
  })

  test('every finding degrading is ALSO a valid outcome — the stage succeeds', () => {
    // AC-3: this is not a stage failure. The round publishes an overview
    // carrying all of them and moves on.
    const { anchored, degraded } = partitionByAnchor(
      [{ id: 'a', file: 'src/z.ts', line: 1 }],
      locate,
      [hunk()],
    )
    expect(anchored).toEqual([])
    expect(degraded).toHaveLength(1)
  })
})

describe('RFC-304 AC-4 — anchoring reads the diff, not the worktree', () => {
  test('the module reads no filesystem and no worktree', async () => {
    // Source-level guard for a rule that leaves no runtime trace: if this
    // module ever grows a filesystem or worktree parameter, anchoring would
    // drift with whatever a hook or a fix stage wrote after `fetch-diff` ran.
    //
    // Comments are stripped before scanning — the rule has to be explainable
    // where it applies, and the explanation necessarily names the thing it
    // forbids. (Same reason the RFC-304 T11 scans skip comment lines.)
    const src = Bun.file(
      new URL('../src/modules/code-capability/domain/anchorResolve.ts', import.meta.url),
    )
    const text = await src.text()
    const code = text
      .split('\n')
      .filter((line) => {
        const t = line.trim()
        return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*')
      })
      .join('\n')

    for (const forbidden of ['node:fs', 'worktree', 'readFile', 'readdir']) {
      expect(code).not.toContain(forbidden)
    }
    // …and the rule IS explained, in the comments this scan just skipped.
    expect(text).toContain('fetch-diff')
  })
})

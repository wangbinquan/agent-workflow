// RFC-304 §7.1 — position assembly for both code hosts.
//
// Why this deserves careful tests despite being pure string/number shuffling:
// a malformed position does NOT error. Both APIs accept it and quietly demote
// the comment to the MR overview, which reads to the author as "the bot left a
// vague remark" rather than "this platform has a bug". The failure is invisible
// until someone looks at a real MR and wonders why nothing landed on a line.
//
// The case worth the most attention is GitLab's CONTEXT line, which needs BOTH
// sides. Sending only the new side is accepted and anchors the comment as if
// the line were added — which lands on the wrong row whenever the hunk shifted,
// and hunks shift constantly.

import { describe, expect, test } from 'bun:test'
import {
  buildGithubPosition,
  buildGitlabPosition,
  withGithubRange,
  type AnchoredLine,
  type GitlabDiffRefs,
} from '../src/modules/code-capability/domain/reviewPosition'

const REFS: GitlabDiffRefs = { baseSha: 'base1', startSha: 'start1', headSha: 'head1' }

const anchor = (over: Partial<AnchoredLine> = {}): AnchoredLine => ({
  kind: 'added',
  oldPath: 'src/a.ts',
  oldLine: 10,
  newPath: 'src/a.ts',
  newLine: 12,
  ...over,
})

describe('RFC-304 §7.1 — GitLab positions', () => {
  test('an added line sends only the NEW side', () => {
    const r = buildGitlabPosition(anchor({ kind: 'added' }), REFS)
    expect(r.ok).toBe(true)
    expect(r.ok && r.position).toEqual({
      position_type: 'text',
      base_sha: 'base1',
      start_sha: 'start1',
      head_sha: 'head1',
      new_path: 'src/a.ts',
      new_line: 12,
    })
    // Sending the old side too would make GitLab treat it as a context line.
    expect(r.ok && 'old_line' in r.position).toBe(false)
  })

  test('a removed line sends only the OLD side', () => {
    const r = buildGitlabPosition(anchor({ kind: 'removed' }), REFS)
    expect(r.ok && r.position.old_line).toBe(10)
    expect(r.ok && 'new_line' in r.position).toBe(false)
  })

  test('a CONTEXT line sends BOTH sides — the case that silently mis-anchors', () => {
    // With only the new side, GitLab anchors it as an added line, which lands
    // on the wrong row whenever the hunk shifted.
    const r = buildGitlabPosition(anchor({ kind: 'context' }), REFS)
    expect(r.ok && r.position).toMatchObject({
      old_path: 'src/a.ts',
      old_line: 10,
      new_path: 'src/a.ts',
      new_line: 12,
    })
  })

  test('every position carries all three diff refs', () => {
    // GitLab rejects a text position missing any of them, and the rejection
    // arrives as a generic 400 — worth asserting once per kind rather than
    // debugging it against a live MR.
    for (const kind of ['added', 'removed', 'context'] as const) {
      const r = buildGitlabPosition(anchor({ kind }), REFS)
      expect(r.ok && r.position).toMatchObject({
        position_type: 'text',
        base_sha: 'base1',
        start_sha: 'start1',
        head_sha: 'head1',
      })
    }
  })

  test('a file renamed across the diff keeps each side its own path', () => {
    const r = buildGitlabPosition(
      anchor({ kind: 'context', oldPath: 'src/old.ts', newPath: 'src/new.ts' }),
      REFS,
    )
    expect(r.ok && r.position).toMatchObject({ old_path: 'src/old.ts', new_path: 'src/new.ts' })
  })

  test('missing side data is refused, not silently half-built', () => {
    // Refusing gives the caller a `degraded` finding in the overview; a
    // half-built position gives the author a comment on the wrong line.
    expect(buildGitlabPosition(anchor({ kind: 'added', newLine: null }), REFS).ok).toBe(false)
    expect(buildGitlabPosition(anchor({ kind: 'removed', oldPath: null }), REFS).ok).toBe(false)
    const ctx = buildGitlabPosition(anchor({ kind: 'context', oldLine: null }), REFS)
    expect(ctx.ok).toBe(false)
    // The reason must say WHY both sides are needed, or the next reader
    // "simplifies" it back to one side.
    expect(!ctx.ok && ctx.reason).toContain('BOTH')
  })
})

describe('RFC-304 §7.1 — GitHub positions', () => {
  test('an added line is on the RIGHT side', () => {
    const r = buildGithubPosition(anchor({ kind: 'added' }))
    expect(r.ok && r.position).toEqual({ path: 'src/a.ts', line: 12, side: 'RIGHT' })
  })

  test('a context line is also RIGHT — it exists post-change', () => {
    const r = buildGithubPosition(anchor({ kind: 'context' }))
    expect(r.ok && r.position.side).toBe('RIGHT')
    expect(r.ok && r.position.line).toBe(12)
  })

  test('a removed line is the only one on the LEFT', () => {
    const r = buildGithubPosition(anchor({ kind: 'removed' }))
    expect(r.ok && r.position).toEqual({ path: 'src/a.ts', line: 10, side: 'LEFT' })
  })

  test('a removed line uses the OLD path, not the new one', () => {
    // On a rename, using the new path points at a file where that line does
    // not exist on the LEFT side.
    const r = buildGithubPosition(
      anchor({ kind: 'removed', oldPath: 'src/old.ts', newPath: 'src/new.ts' }),
    )
    expect(r.ok && r.position.path).toBe('src/old.ts')
  })

  test('missing side data is refused', () => {
    expect(buildGithubPosition(anchor({ kind: 'added', newPath: null })).ok).toBe(false)
    expect(buildGithubPosition(anchor({ kind: 'removed', oldLine: null })).ok).toBe(false)
  })
})

describe('RFC-304 §7.1 — GitHub multi-line ranges', () => {
  const base = { path: 'src/a.ts', line: 20, side: 'RIGHT' as const }

  test('a real range carries start_line and start_side', () => {
    const r = withGithubRange(base, 15)
    expect(r.ok && r.position).toEqual({ ...base, start_line: 15, start_side: 'RIGHT' })
  })

  test('a one-line range drops the redundant fields', () => {
    // GitHub rejects a comment whose start equals its end on the same side.
    const r = withGithubRange(base, 20)
    expect(r.ok && r.position).toEqual(base)
  })

  test('an inverted range is refused rather than sent', () => {
    const r = withGithubRange(base, 25)
    expect(r.ok).toBe(false)
  })

  test('a range spanning both sides keeps its own start side', () => {
    const r = withGithubRange(base, 15, 'LEFT')
    expect(r.ok && r.position.start_side).toBe('LEFT')
  })
})

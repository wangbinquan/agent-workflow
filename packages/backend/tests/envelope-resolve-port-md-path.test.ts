import { rimrafDir } from './helpers/cleanup'
// RFC-049 PR-B: locks the post-forgiveness contract. The old auto-promote
// "if the port content is a single-line .md path inside the worktree, read
// the file" behavior was removed; agents that want the file body delivered
// to downstream nodes MUST declare `outputKinds: { port: markdown_file }`.
// Anything else now returns the raw content verbatim, even when a real .md
// file exists at the path. Original incident report (forgiveness path)
// preserved for context: /reviews/01KRPE30VQT3R4G24PV3ZAG82D where the
// upstream designer agent emitted an absolute path and the doc_version body
// rendered as a one-line path string. PR-B's "fix" is to declare the kind.
//
// If any of these go red, check packages/backend/src/services/envelope.ts:
// resolvePortContentDetailed should be a single early-return passthrough
// when kind === undefined; no fs probe.

import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolvePortContent } from '../src/services/envelope'
import { ValidationError } from '../src/util/errors'
import { isWindows } from './helpers/stub-runtime'

const canSymlink = isWindows
  ? (() => {
      try {
        const d = mkdirSync(join(tmpdir(), 'aw-symlink-probe-'), { recursive: true }) as string
        symlinkSync(join(d, 'x'), join(d, 'y'), 'file')
        rimrafDir(d)
        return true
      } catch {
        return false
      }
    })()
  : true

describe('RFC-049 PR-B raw-passthrough (kind=undefined never reads file)', () => {
  let worktree: string
  let outside: string

  beforeEach(() => {
    worktree = mkdtempSync(join(tmpdir(), 'aw-wt-'))
    outside = mkdtempSync(join(tmpdir(), 'aw-out-'))
  })

  afterEach(() => {
    rimrafDir(worktree)
    rimrafDir(outside)
  })

  test('kind=undefined + absolute path inside worktree → raw passthrough (the path string)', () => {
    mkdirSync(join(worktree, 'docs'), { recursive: true })
    writeFileSync(join(worktree, 'docs', 'design.md'), '# Spec\nbody')
    const absPath = join(worktree, 'docs', 'design.md')
    expect(resolvePortContent({ rawContent: absPath, worktreePath: worktree })).toBe(absPath)
  })

  test('kind=undefined + relative path inside worktree → raw passthrough (the path string)', () => {
    mkdirSync(join(worktree, 'docs'), { recursive: true })
    writeFileSync(join(worktree, 'docs', 'design.md'), '# rel')
    expect(resolvePortContent({ rawContent: 'docs/design.md', worktreePath: worktree })).toBe(
      'docs/design.md',
    )
  })

  test('kind=string + relative .md path inside worktree → still passthrough (no auto-promote)', () => {
    // 'string' / 'markdown' kinds pass through the handler whose validate
    // returns { ok: true, body: raw } — no file read, regardless of whether
    // the path-shaped string happens to point to a real file.
    mkdirSync(join(worktree, 'docs'), { recursive: true })
    writeFileSync(join(worktree, 'docs', 'a.md'), 'auto')
    expect(
      resolvePortContent({
        rawContent: 'docs/a.md',
        kind: 'string',
        worktreePath: worktree,
      }),
    ).toBe('docs/a.md')
  })

  test('kind=undefined + path-shaped string but file does not exist → passthrough', () => {
    const raw = 'does-not-exist.md'
    expect(resolvePortContent({ rawContent: raw, worktreePath: worktree })).toBe(raw)
  })

  test('kind=undefined + absolute path OUTSIDE worktree → passthrough (no read, no throw)', () => {
    writeFileSync(join(outside, 'secrets.md'), 'TOP SECRET')
    const raw = join(outside, 'secrets.md')
    expect(resolvePortContent({ rawContent: raw, worktreePath: worktree })).toBe(raw)
  })

  test('kind=undefined + symlink inside worktree pointing outside → passthrough', () => {
    // realpath() resolves the symlink and the containment recheck rejects it.
    // The strict markdown_file branch follows the symlink (legacy behavior
    // documented in envelope-parse-md-edge-cases.test.ts attack 4); the
    // forgiveness path is stricter precisely because it fires implicitly.
    // On Windows, file symlinks need developer mode; if unavailable, the
    // passthrough behavior still exists in the code — just skip the test case.
    if (!canSymlink) return
    writeFileSync(join(outside, 'secrets.md'), 'TOP SECRET')
    symlinkSync(join(outside, 'secrets.md'), join(worktree, 'evil.md'))
    expect(
      resolvePortContent({
        rawContent: 'evil.md',
        worktreePath: worktree,
      }),
    ).toBe('evil.md')
  })

  test('kind=undefined + multi-line markdown body containing ".md" → passthrough', () => {
    const body = '# Title\n\nsee design/spec.md for details\n'
    expect(resolvePortContent({ rawContent: body, worktreePath: worktree })).toBe(body)
  })

  test('kind=undefined + single line not ending in .md → passthrough', () => {
    expect(resolvePortContent({ rawContent: 'just a status string', worktreePath: worktree })).toBe(
      'just a status string',
    )
  })

  test('kind=undefined + path points to a directory ending in .md → passthrough', () => {
    mkdirSync(join(worktree, 'weird.md'), { recursive: true })
    expect(
      resolvePortContent({
        rawContent: 'weird.md',
        worktreePath: worktree,
      }),
    ).toBe('weird.md')
  })

  test('kind=undefined + .md path containing traversal that escapes worktree → passthrough', () => {
    const raw = '../escape.md'
    writeFileSync(join(outside, 'escape.md'), 'leaked')
    // Even with the file existing outside, lexical containment fails so we
    // never even attempt the read.
    expect(resolvePortContent({ rawContent: raw, worktreePath: worktree })).toBe(raw)
  })

  test('kind=undefined + empty string → passthrough (no probe)', () => {
    expect(resolvePortContent({ rawContent: '', worktreePath: worktree })).toBe('')
  })

  test('kind=markdown_file + absolute path INSIDE worktree → reads file body', () => {
    // Regression for "review-source-resolve-failed" reported on task
    // 058c4a9c-demo / node rev_crqa2g where the upstream designer agent
    // emitted an absolute path inside the task worktree (its own cwd) and
    // dispatchReviewNode rejected it with markdown-file-absolute-path. The
    // containment check is the real security boundary; absolute-vs-relative
    // on the wire is incidental.
    mkdirSync(join(worktree, 'docs'), { recursive: true })
    writeFileSync(join(worktree, 'docs', 'design.md'), '# Spec')
    expect(
      resolvePortContent({
        rawContent: join(worktree, 'docs', 'design.md'),
        kind: 'markdown_file',
        worktreePath: worktree,
      }),
    ).toBe('# Spec')
  })

  test('kind=markdown_file + absolute path OUTSIDE worktree → ValidationError', () => {
    writeFileSync(join(outside, 'secrets.md'), 'TOP SECRET')
    expect(() =>
      resolvePortContent({
        rawContent: join(outside, 'secrets.md'),
        kind: 'markdown_file',
        worktreePath: worktree,
      }),
    ).toThrow(ValidationError)
  })
})

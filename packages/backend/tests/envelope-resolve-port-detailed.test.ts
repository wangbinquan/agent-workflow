import { rimrafDir } from './helpers/cleanup'
// Locks in resolvePortContentDetailed — the variant of resolvePortContent
// that also reports the worktree-relative file path the body was read from.
//
// dispatchReviewNode uses this to snapshot the source file path onto
// doc_versions.source_file_path so renderCommentsForPrompt can cite the
// file the comments target in the iterate re-run prompt.
//
// If this goes red, see packages/backend/src/services/envelope.ts. The
// security boundary (containment / passthrough behavior) is locked
// separately by envelope-parse-md-edge-cases.test.ts and
// envelope-resolve-port-md-path.test.ts; this file focuses on the
// sourcePath shape every dispatchReviewNode invocation depends on.

import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolvePortContentDetailed } from '../src/services/envelope'
import { isWindows } from './helpers/stub-runtime'

const canSymlink = isWindows
  ? (() => {
      try {
        const { mkdirSync, symlinkSync, rmSync } = require('node:fs')
        const { join } = require('node:path')
        const { tmpdir } = require('node:os')
        const d = mkdirSync(join(tmpdir(), 'aw-symlink-probe-'), { recursive: true })
        symlinkSync(join(d, 'x'), join(d, 'y'), 'file')
        rimrafDir(d)
        return true
      } catch {
        return false
      }
    })()
  : true

describe('resolvePortContentDetailed sourcePath', () => {
  let worktree: string
  let outside: string

  beforeEach(() => {
    worktree = mkdtempSync(join(tmpdir(), 'aw-rpcd-wt-'))
    outside = mkdtempSync(join(tmpdir(), 'aw-rpcd-out-'))
  })

  afterEach(() => {
    rimrafDir(worktree)
    rimrafDir(outside)
  })

  test('kind=markdown_file + relative path → sourcePath = relative path', () => {
    mkdirSync(join(worktree, 'docs'), { recursive: true })
    writeFileSync(join(worktree, 'docs', 'spec.md'), '# Spec\nbody')
    const result = resolvePortContentDetailed({
      rawContent: 'docs/spec.md',
      kind: 'markdown_file',
      worktreePath: worktree,
    })
    expect(result.body).toBe('# Spec\nbody')
    expect(result.sourcePath).toBe('docs/spec.md')
  })

  test('kind=markdown_file + absolute path inside worktree → sourcePath normalized to relative', () => {
    mkdirSync(join(worktree, 'design'), { recursive: true })
    writeFileSync(join(worktree, 'design', 'spec.md'), '# abs')
    const result = resolvePortContentDetailed({
      rawContent: join(worktree, 'design', 'spec.md'),
      kind: 'markdown_file',
      worktreePath: worktree,
    })
    expect(result.body).toBe('# abs')
    expect(result.sourcePath).toBe('design/spec.md')
  })

  test('kind=undefined + .md file in worktree → raw passthrough (sourcePath undefined, body=path)', () => {
    // RFC-049 PR-B removed the forgiveness path. Undeclared kind always
    // returns the raw content verbatim with no sourcePath.
    mkdirSync(join(worktree, 'notes'), { recursive: true })
    writeFileSync(join(worktree, 'notes', 'todo.md'), 'never read after PR-B')
    const result = resolvePortContentDetailed({
      rawContent: 'notes/todo.md',
      worktreePath: worktree,
    })
    expect(result.body).toBe('notes/todo.md')
    expect(result.sourcePath).toBeUndefined()
  })

  test('kind=undefined + absolute .md path in worktree → raw passthrough (no sourcePath)', () => {
    // Symmetric with the relative-path case: absolute paths emitted by an
    // agent on an undeclared port also passthrough verbatim now.
    mkdirSync(join(worktree, 'docs'), { recursive: true })
    writeFileSync(join(worktree, 'docs', 'design.md'), 'abs (never read)')
    const absPath = join(worktree, 'docs', 'design.md')
    const result = resolvePortContentDetailed({
      rawContent: absPath,
      worktreePath: worktree,
    })
    expect(result.body).toBe(absPath)
    expect(result.sourcePath).toBeUndefined()
  })

  test('kind=markdown + multi-line body → sourcePath undefined, body verbatim', () => {
    const body = '# Title\n\nMulti-line markdown body, not a path.\n'
    const result = resolvePortContentDetailed({
      rawContent: body,
      kind: 'markdown',
      worktreePath: worktree,
    })
    expect(result.body).toBe(body)
    expect(result.sourcePath).toBeUndefined()
  })

  test('kind=undefined + path-shaped string that does not exist → sourcePath undefined', () => {
    const raw = 'does-not-exist.md'
    const result = resolvePortContentDetailed({ rawContent: raw, worktreePath: worktree })
    expect(result.body).toBe(raw)
    expect(result.sourcePath).toBeUndefined()
  })

  test('kind=undefined + absolute .md path OUTSIDE worktree → sourcePath undefined, passthrough', () => {
    writeFileSync(join(outside, 'leak.md'), 'TOP SECRET')
    const raw = join(outside, 'leak.md')
    const result = resolvePortContentDetailed({ rawContent: raw, worktreePath: worktree })
    expect(result.body).toBe(raw)
    expect(result.sourcePath).toBeUndefined()
  })

  test('kind=undefined + symlink inside worktree pointing outside → sourcePath undefined, passthrough', () => {
    // On Windows, file symlinks need developer mode; if unavailable, the
    // passthrough behavior still exists in the code — just skip the test case.
    if (!canSymlink) return
    writeFileSync(join(outside, 'leak.md'), 'TOP SECRET')
    const { symlinkSync } = require('node:fs')
    symlinkSync(join(outside, 'leak.md'), join(worktree, 'evil.md'))
    const result = resolvePortContentDetailed({
      rawContent: 'evil.md',
      worktreePath: worktree,
    })
    expect(result.body).toBe('evil.md')
    expect(result.sourcePath).toBeUndefined()
  })
})

// RFC-080: resolvePortContentDetailed now dispatches through the parametric
// registry. Before the migration, any of these kinds threw
// `outputKind handler not registered`; now path<ext> / list<T> / signal all
// validate correctly and the errCode namespace is the handler displayName.
describe('RFC-080 — parametric kinds resolve via the registry', () => {
  let worktree: string

  beforeEach(() => {
    worktree = mkdtempSync(join(tmpdir(), 'aw-rpcd80-wt-'))
  })
  afterEach(() => {
    rimrafDir(worktree)
  })

  test('kind=path<json> + .json file → body read, sourcePath = relative path', () => {
    writeFileSync(join(worktree, 'data.json'), '{"k":1}')
    const result = resolvePortContentDetailed({
      rawContent: 'data.json',
      kind: 'path<json>',
      worktreePath: worktree,
    })
    expect(result.body).toBe('{"k":1}')
    expect(result.sourcePath).toBe('data.json')
  })

  test('kind=path<json> + wrong extension → PortValidationError with `path` namespace (D2)', () => {
    writeFileSync(join(worktree, 'data.txt'), 'nope')
    expect(() =>
      resolvePortContentDetailed({
        rawContent: 'data.txt',
        kind: 'path<json>',
        worktreePath: worktree,
      }),
    ).toThrow('port-validation-path-wrong-extension')
  })

  test('kind=list<path<md>> + two .md paths → validates each item, body = joined paths', () => {
    writeFileSync(join(worktree, 'a.md'), '# A')
    writeFileSync(join(worktree, 'b.md'), '# B')
    const result = resolvePortContentDetailed({
      rawContent: 'a.md\nb.md',
      kind: 'list<path<md>>',
      worktreePath: worktree,
    })
    expect(result.body).toBe('a.md\nb.md')
  })

  test('kind=list<path<md>> + one item points to a missing file → list errCode namespace', () => {
    writeFileSync(join(worktree, 'a.md'), '# A')
    expect(() =>
      resolvePortContentDetailed({
        rawContent: 'a.md\nmissing.md',
        kind: 'list<path<md>>',
        worktreePath: worktree,
      }),
    ).toThrow('port-validation-list-list-item-validate-failed')
  })

  test('kind=signal + any content → normalized to empty body, never throws', () => {
    const result = resolvePortContentDetailed({
      rawContent: 'the agent wrote something here',
      kind: 'signal',
      worktreePath: worktree,
    })
    expect(result.body).toBe('')
    expect(result.sourcePath).toBeUndefined()
  })
})
